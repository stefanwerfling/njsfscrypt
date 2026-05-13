import Fuse, {StatFs} from 'fuse-native';
import {constants} from 'node:fs';
import {stat, chmod, chown, truncate, utimes} from 'node:fs/promises';
import {ErrnoFuseCb} from '../Error/ErrnoFuseCb.js';
import {ErrorUtils} from '../Utils/ErrorUtils.js';
import {VirtualFSEntry} from './VirtualFSEntry.js';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import {Stats} from 'fs';
import * as tpath from 'path';
import {VirtualFSHandler} from './VirtualFSHandler.js';

interface CryptFSOptions {
    baseDir: string;
    encryptionKey: Buffer;
    blockSize: number;
}

export class CryptFS implements VirtualFSEntry {

    /**
     * Magic prefix written at the start of every CryptFS v2 file. Lets us
     * detect the format and reject old AES-256-CTR (v1) files instead of
     * silently producing garbage.
     */
    private static readonly MAGIC = Buffer.from('NJSc', 'ascii');
    private static readonly VERSION = 2;

    /** GCM standard nonce size. */
    private static readonly IV_SIZE = 12;

    /** GCM standard authentication tag size. */
    private static readonly TAG_SIZE = 16;

    /**
     * Header layout: 4 magic + 4 version + 8 filesize + 8 reserved = 24 bytes.
     */
    private static readonly META_SIZE = 24;
    private static readonly HEADER_FILESIZE_OFFSET = 8;

    /**
     * Each on-disk block has a fresh IV prepended and an auth tag appended,
     * so on-disk size = plaintext length + BLOCK_OVERHEAD.
     */
    private static readonly BLOCK_OVERHEAD = CryptFS.IV_SIZE + CryptFS.TAG_SIZE;

    private _options: CryptFSOptions;

    /**
     * Debuging
     * @protected
     */
    protected _debug: boolean = true;

    /**
     * Handler
     * @private
     */
    private _handler: VirtualFSHandler = new VirtualFSHandler();

    /**
     * Is cfs init
     * @private
     */
    private _isInit: boolean = false;


    /**
     * Per-fd cache of the plaintext file size held in the header. Avoids a
     * header-read syscall on every `read()`/`write()` and a header-write
     * syscall on every `write()`. The dirty flag tracks whether the
     * in-memory size has grown past the on-disk header; the persist happens
     * in `release()` / `fsync()`.
     * @private
     */
    private _metaCache: Map<number, {fileSize: number; dirty: boolean;}> = new Map();

    /**
     * constructor
     * @param {CryptFSOptions} options
     */
    public constructor(options: CryptFSOptions) {
        this._options = options;
    }

    /**
     * init
     */
    public async init(): Promise<void> {
        const st = await stat(this._options.baseDir);

        if (!st.isDirectory()) {
            throw new Error(`baseDir is not a directory: ${this._options.baseDir}`);
        }

        this._isInit = true;
    }

    /**
     * is init
     * @return {boolean}
     */
    public isInit(): boolean {
        return this._isInit;
    }

    /**
     * AAD that binds an encrypted block to its index. Reordering or pasting a
     * block from a different position in the file fails the auth check even
     * if its on-disk bytes are intact, because the AAD will not match.
     * @param {number} blockIndex
     * @return {Buffer}
     * @private
     */
    private _aadFor(blockIndex: number): Buffer {
        const aad = Buffer.alloc(8);
        aad.writeBigUInt64BE(BigInt(blockIndex), 0);
        return aad;
    }

    /**
     * Encrypt one plaintext block using AES-256-GCM with a fresh random IV
     * and the block index bound in as AAD.
     *
     * Layout produced: [12 IV][N ciphertext][16 tag], where N === plaintext.length.
     *
     * @param {number} blockIndex
     * @param {Buffer} plaintext
     * @return {Buffer}
     * @private
     */
    private _encryptBlock(blockIndex: number, plaintext: Buffer): Buffer {
        const iv = crypto.randomBytes(CryptFS.IV_SIZE);
        const cipher = crypto.createCipheriv('aes-256-gcm', this._options.encryptionKey, iv);
        cipher.setAAD(this._aadFor(blockIndex));

        const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const tag = cipher.getAuthTag();

        return Buffer.concat([iv, ct, tag]);
    }

    /**
     * Decrypt and authenticate one on-disk block. Throws if the tag does not
     * verify (tampering or wrong block index for AAD).
     *
     * @param {number} blockIndex
     * @param {Buffer} onDisk Full block as read from disk: [IV][ct][tag].
     * @return {Buffer}
     * @private
     */
    private _decryptBlock(blockIndex: number, onDisk: Buffer): Buffer {
        if (onDisk.length < CryptFS.BLOCK_OVERHEAD) {
            throw new ErrnoFuseCb(Fuse.EIO, 'CryptFS block truncated below overhead size');
        }

        const iv = onDisk.subarray(0, CryptFS.IV_SIZE);
        const tag = onDisk.subarray(onDisk.length - CryptFS.TAG_SIZE);
        const ct = onDisk.subarray(CryptFS.IV_SIZE, onDisk.length - CryptFS.TAG_SIZE);

        const decipher = crypto.createDecipheriv('aes-256-gcm', this._options.encryptionKey, iv);
        decipher.setAAD(this._aadFor(blockIndex));
        decipher.setAuthTag(tag);

        return Buffer.concat([decipher.update(ct), decipher.final()]);
    }

    /**
     * Build a fresh header with the supplied filesize.
     * @param {number} fileSize
     * @return {Buffer}
     * @private
     */
    private _buildHeader(fileSize: number): Buffer {
        const buf = Buffer.alloc(CryptFS.META_SIZE);
        CryptFS.MAGIC.copy(buf, 0);
        buf.writeUInt32BE(CryptFS.VERSION, 4);
        buf.writeBigInt64BE(BigInt(fileSize), CryptFS.HEADER_FILESIZE_OFFSET);
        // bytes 16..24 are reserved zeros
        return buf;
    }

    /**
     * Read and validate the header from the given file handle.
     * Returns the recorded plaintext file size.
     *
     * @param {fs.FileHandle} fh
     * @return {number}
     * @private
     */
    private async _readHeader(fh: fs.FileHandle): Promise<number> {
        const buf = Buffer.alloc(CryptFS.META_SIZE);
        const {bytesRead} = await fh.read(buf, 0, buf.length, 0);

        if (bytesRead < CryptFS.META_SIZE) {
            throw new ErrnoFuseCb(Fuse.EIO, 'CryptFS file is shorter than the header');
        }

        if (!buf.subarray(0, 4).equals(CryptFS.MAGIC)) {
            throw new ErrnoFuseCb(Fuse.EIO, 'CryptFS magic missing — wrong key, corruption, or v1 file');
        }

        const version = buf.readUInt32BE(4);
        if (version !== CryptFS.VERSION) {
            throw new ErrnoFuseCb(Fuse.EIO, `Unsupported CryptFS version ${version}`);
        }

        return Number(buf.readBigInt64BE(CryptFS.HEADER_FILESIZE_OFFSET));
    }

    /**
     * Return the plaintext file size for a given fd, reading and caching
     * the header on first use.
     * @param {number} fd
     * @param {fs.FileHandle} fh
     * @return {number}
     * @private
     */
    private async _getCachedFileSize(fd: number, fh: fs.FileHandle): Promise<number> {
        const entry = this._metaCache.get(fd);

        if (entry) {
            return entry.fileSize;
        }

        const fileSize = await this._readHeader(fh);
        this._metaCache.set(fd, {fileSize: fileSize, dirty: false});

        return fileSize;
    }

    /**
     * Flush the cached filesize back into the on-disk header if it has
     * grown since the last persist. Only the 8-byte filesize field is
     * touched — magic and version stay intact.
     * @param {number} fd
     * @param {fs.FileHandle} fh
     * @private
     */
    private async _flushFileSizeIfDirty(fd: number, fh: fs.FileHandle): Promise<void> {
        const entry = this._metaCache.get(fd);

        if (!entry || !entry.dirty) {
            return;
        }

        const sizeBuf = Buffer.alloc(8);
        sizeBuf.writeBigInt64BE(BigInt(entry.fileSize), 0);
        await fh.write(sizeBuf, 0, 8, CryptFS.HEADER_FILESIZE_OFFSET);
        entry.dirty = false;
    }

    /**
     * Number of plaintext blocks needed to cover `fileSize` bytes.
     * @param {number} fileSize
     * @return {number}
     * @private
     */
    private _numBlocks(fileSize: number): number {
        if (fileSize <= 0) {
            return 0;
        }
        return Math.ceil(fileSize / this._options.blockSize);
    }

    /**
     * Plaintext length stored in block `blockIndex`. Full blocks return
     * `blockSize`; the trailing block returns the remainder.
     * @param {number} blockIndex
     * @param {number} fileSize
     * @return {number}
     * @private
     */
    private _plainLenOfBlock(blockIndex: number, fileSize: number): number {
        const numBlocks = this._numBlocks(fileSize);
        if (blockIndex >= numBlocks) {
            return 0;
        }
        if (blockIndex === numBlocks - 1) {
            return fileSize - (blockIndex * this._options.blockSize);
        }
        return this._options.blockSize;
    }

    /**
     * Byte offset on disk where block `blockIndex` starts.
     * Each preceding block contributes `blockSize + BLOCK_OVERHEAD` bytes.
     * @param {number} blockIndex
     * @return {number}
     * @private
     */
    private _blockDiskOffset(blockIndex: number): number {
        return CryptFS.META_SIZE + blockIndex * (this._options.blockSize + CryptFS.BLOCK_OVERHEAD);
    }

    /**
     * Total physical size on disk for a file with the given plaintext size.
     * @param {number} fileSize
     * @return {number}
     * @private
     */
    private _physicalSize(fileSize: number): number {
        const numBlocks = this._numBlocks(fileSize);
        if (numBlocks === 0) {
            return CryptFS.META_SIZE;
        }
        const fullBlocks = numBlocks - 1;
        const lastPlain = fileSize - (fullBlocks * this._options.blockSize);
        return CryptFS.META_SIZE
            + fullBlocks * (this._options.blockSize + CryptFS.BLOCK_OVERHEAD)
            + lastPlain + CryptFS.BLOCK_OVERHEAD;
    }

    /**
     * encode a name (file or folder name)
     * @param {string} name
     * @return {string}
     * @private
     */
    private _encodeName(name: string): string {
        const cipher = crypto.createCipheriv('aes-256-gcm', this._options.encryptionKey, Buffer.alloc(12,0));
        const encrypted = Buffer.concat([cipher.update(Buffer.from(name,'utf8')), cipher.final()]);
        const tag = cipher.getAuthTag();

        return Buffer.concat([tag, encrypted])
        .toString('base64')
        .replace(/\+/gu, '-')
        .replace(/\//gu, '_')
        .replace(/[=]+$/u,'');
    }

    /**
     * decode a name (file or folder name)
     * @param {string} encName
     * @return {string}
     * @private
     */
    private _decodeName(encName: string): string {
        const b64 = encName.replace(/-/gu, '+').replace(/_/gu, '/');
        const buf = Buffer.from(b64, 'base64');
        const tag = buf.subarray(0,16);
        const encrypted = buf.subarray(16);

        const decipher = crypto.createDecipheriv('aes-256-gcm', this._options.encryptionKey, Buffer.alloc(12,0));
        decipher.setAuthTag(tag);

        return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    }

    /**
     * Map a path and use encode name
     * @param {string} mountPath
     * @return {string}
     * @private
     */
    private _mapPath(mountPath: string): string {
        const parts = mountPath.split('/').filter(Boolean);
        const encParts = parts.map(p => this._encodeName(p));
        return tpath.join(this._options.baseDir, ...encParts);
    }

    /**
     * Access file/directory
     * @param {string} path
     * @param {number} mode
     */
    public async access(path: string, mode: number): Promise<void> {
        //const dpath = this._mapPath(path);
        //await fs.access(dpath, mode);
    }

    /**
     * Create file
     * @param {string} path
     * @param {number} mode
     * @return {number}
     */
    public async create(path: string, mode: number): Promise<number> {
        const dpath = this._mapPath(path);
        const flags =
            // eslint-disable-next-line no-bitwise
            constants.O_CREAT |
            constants.O_TRUNC |
            constants.O_RDWR;

        const fh = await fs.open(dpath, flags, mode);

        await fh.write(this._buildHeader(0), 0, CryptFS.META_SIZE, 0);

        const vfd = this._handler.allocHandle({
            fh: fh,
            path: path,
            realPath: dpath,
            flags: flags
        });

        // Header was just written with filesize=0 — prime the cache so the
        // first read/write doesn't re-read it.
        this._metaCache.set(vfd, {fileSize: 0, dirty: false});

        return vfd;
    }

    /**
     * statfs
     * @param {string} _path
     */
    public async statfs(_path: string): Promise<StatFs> {
        return {
            bsize: 4096,
            frsize: 4096,
            blocks: 1000000,
            bfree: 500000,
            bavail: 500000,
            files: 1000000,
            ffree: 500000,
            favail: 500000,
            fsid: 1234,
            flag: 0,
            namemax: 255
        };
    }

    /**
     * Get attr
     * @param {string} path
     * @return {Stats}
     */
    public async getattr(path: string): Promise<Stats> {
        const fullPath = path === '/' ? this._options.baseDir : this._mapPath(path);

        const tstat = await fs.lstat(fullPath);

        if (tstat.isDirectory()) {
            return {
                atime: tstat.atime,
                mtime: tstat.mtime,
                ctime: tstat.ctime,
                size: tstat.size,
                mode: tstat.mode,
                uid: tstat.uid,
                gid: tstat.gid
            } as any;
        }

        // symlinks ----------------------------------------------------------------------------------------------------

        if (tstat.isSymbolicLink()) {
            let targetLen = 0;
            try {
                const onDisk = await fs.readlink(fullPath);
                targetLen = this._decodeName(onDisk.toString()).length;
            } catch {
                // unreadable target — keep size 0 so ls shows something sane
            }

            // Return the live lstat Stats with the size patched to the
            // decoded target length. Returning a plain object would lose
            // the helper methods (isSymbolicLink etc.) consumers rely on.
            (tstat as Stats & {size: number;}).size = targetLen;

            return tstat;
        }

        // files -------------------------------------------------------------------------------------------------------

        let fileSize = 0;

        if (tstat.size >= CryptFS.META_SIZE) {
            const fh = await fs.open(fullPath, 'r');
            try {
                fileSize = await this._readHeader(fh);
            } finally {
                await fh.close();
            }
        }

        return {
            atime: tstat.atime,
            mtime: tstat.mtime,
            ctime: tstat.ctime,
            size: fileSize,
            mode: tstat.mode,
            uid: tstat.uid,
            gid: tstat.gid
        } as any;
    }

    /**
     * Set attr
     * @param {string} path
     * @param {Partial<Stats>} attr
     */
    public async setattr(path: string, attr: Partial<Stats>): Promise<void> {
        const isRoot = path === '/';
        const dpath = isRoot ? this._options.baseDir : this._mapPath(path);

        let st: Stats;
        try {
            st = await stat(dpath);
        } catch {
            throw new ErrnoFuseCb(Fuse.ENOENT, 'File not found');
        }

        if (isRoot && attr.size !== undefined) {
            return;
        }

        if (attr.mode !== undefined) {
            await chmod(dpath, attr.mode);
        }

        if (attr.size !== undefined) {
            await truncate(dpath, attr.size);
        }

        if (attr.uid !== undefined || attr.gid !== undefined) {
            await chown(
                dpath,
                attr.uid ?? st.uid,
                attr.gid ?? st.gid
            );
        }

        if (attr.atime !== undefined || attr.mtime !== undefined) {
            await utimes(
                dpath,
                attr.atime ?? st.atime,
                attr.mtime ?? st.mtime
            );
        }
    }

    /**
     * mkdir
     * @param {string} path
     * @param {number} mode
     */
    public async mkdir(path: string, mode: number): Promise<void> {
        await fs.mkdir(this._mapPath(path), {mode: mode});
    }

    /**
     * open
     * @param {string} path
     * @param {number} flags
     * @return {number}
     */
    public async open(path: string, flags: number): Promise<number> {
        const dpath = this._mapPath(path);
        const fh = await fs.open(dpath, flags);

        return this._handler.allocHandle({
            fh: fh,
            path: path,
            realPath: dpath,
            flags: flags
        });
    }

    /**
     * read
     * @param {string} path
     * @param {number} fd
     * @param {number} length
     * @param {number} offset
     * @return {Buffer}
     */
    public async read(path: string, fd: number, length: number, offset: number): Promise<Buffer> {
        const {fh} = this._handler.getHandle(fd);

        if (!fh) {
            throw new Error(`Filehandle not found: ${fd}`);
        }

        const fileSize = await this._getCachedFileSize(fd, fh);

        if (offset >= fileSize) {
            return Buffer.alloc(0);
        }

        const toReadTotal = Math.min(length, fileSize - offset);
        const out = Buffer.alloc(toReadTotal);

        const firstBlock = Math.floor(offset / this._options.blockSize);
        const lastBlock = Math.floor((offset + toReadTotal - 1) / this._options.blockSize);

        // Blocks are contiguous on disk, so the whole touched range is one
        // syscall. Cipher work stays per-block (GCM = per-block IV + tag).
        const readStart = this._blockDiskOffset(firstBlock);
        const lastBlockOnDiskLen =
            this._plainLenOfBlock(lastBlock, fileSize) + CryptFS.BLOCK_OVERHEAD;
        const readLen = this._blockDiskOffset(lastBlock) + lastBlockOnDiskLen - readStart;

        const onDiskBuf = Buffer.alloc(readLen);
        const {bytesRead} = await fh.read(onDiskBuf, 0, readLen, readStart);

        if (bytesRead < readLen) {
            throw new ErrnoFuseCb(Fuse.EIO, 'CryptFS block range truncated on disk');
        }

        let done = 0;
        let cursor = 0;

        for (let block = firstBlock; block <= lastBlock; block++) {
            const blockPlainStart = block * this._options.blockSize;
            const plainLen = this._plainLenOfBlock(block, fileSize);
            const onDiskLen = plainLen + CryptFS.BLOCK_OVERHEAD;

            const plain = this._decryptBlock(
                block,
                onDiskBuf.subarray(cursor, cursor + onDiskLen)
            );

            const sliceStart = Math.max(offset, blockPlainStart) - blockPlainStart;
            const sliceEnd = Math.min(offset + toReadTotal, blockPlainStart + plainLen) - blockPlainStart;

            plain.copy(out, done, sliceStart, sliceEnd);
            done += sliceEnd - sliceStart;
            cursor += onDiskLen;
        }

        return out;
    }

    /**
     * read dir
     * @param {string} path
     * @return {string[]}
     */
    public async readdir(path: string): Promise<string[]> {
        const fullPath = path === '/' ? this._options.baseDir : this._mapPath(path);

        return (await fs.readdir(fullPath)).map((fn) => {
            try {
                return this._decodeName(fn);
            } catch {
                return '???';
            }
        });
    }

    /**
     * release
     * @param {string} path
     * @param {number} fd
     */
    public async release(path: string, fd: number): Promise<void> {
        const { fh } = this._handler.getHandle(fd);

        if (fh) {
            try {
                await this._flushFileSizeIfDirty(fd, fh);
            } finally {
                await fh.close();
                this._handler.freeHandle(fd);
                this._metaCache.delete(fd);
            }
        }
    }

    /**
     * rename
     * @param {string} src
     * @param {string} dest
     */
    public async rename(src: string, dest: string): Promise<void> {
        const fullSrc = this._mapPath(src);
        const fullDest = this._mapPath(dest);

        return fs.rename(fullSrc, fullDest);
    }

    /**
     * rmdir
     * @param {string} path
     */
    public async rmdir(path: string): Promise<void> {
        const fullPath = this._mapPath(path);

        try {
            const files = await fs.readdir(fullPath);

            if (files.length > 0) {
                throw new ErrnoFuseCb(Fuse.ENOTEMPTY, 'Directory not empty');
            }

            await fs.rmdir(this._mapPath(path));
        } catch (e) {
            if (e instanceof ErrnoFuseCb) {
                throw e;
            }

            if (ErrorUtils.isFsError(e)) {
                switch (e.code) {
                    case 'ENOENT':
                        throw new ErrnoFuseCb(Fuse.ENOENT);
                }
            }

            throw new ErrnoFuseCb(Fuse.EIO, 'Failed to remove directory');
        }
    }

    /**
     * unlink
     * @param {string} path
     */
    public async unlink(path: string): Promise<void> {
        return fs.unlink(this._mapPath(path));
    }

    /**
     * flush — no-op; encryption + write are synchronous from the caller's view
     * and the actual handle close happens in release().
     * @param {string} _path
     * @param {number} _fd
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public async flush(_path: string, _fd: number): Promise<void> {
        // no-op
    }

    /**
     * fsync / fdatasync — flush the encrypted file's kernel buffers to disk.
     * @param {string} _path
     * @param {number} fd
     * @param {boolean} datasync true = fdatasync, false = full fsync
     */
    public async fsync(_path: string, fd: number, datasync: boolean): Promise<void> {
        const {fh} = this._handler.getHandle(fd);

        if (!fh) {
            throw new Error(`Filehandle not found: ${fd}`);
        }

        await this._flushFileSizeIfDirty(fd, fh);

        if (datasync) {
            await fh.datasync();
        } else {
            await fh.sync();
        }
    }

    /**
     * symlink — the on-disk symlink stores the target string encrypted with
     * the same name-encoding as filenames. The kernel never resolves the
     * on-disk target directly; readlink() decrypts it before returning.
     * @param {string} target
     * @param {string} linkPath
     */
    public async symlink(target: string, linkPath: string): Promise<void> {
        const encodedTarget = this._encodeName(target);
        await fs.symlink(encodedTarget, this._mapPath(linkPath));
    }

    /**
     * readlink — read and decrypt the symlink target.
     * @param {string} path
     * @return {string}
     */
    public async readlink(path: string): Promise<string> {
        const onDisk = await fs.readlink(this._mapPath(path));
        return this._decodeName(onDisk.toString());
    }

    /**
     * link — hard link two encoded names onto the same encrypted inode. The
     * encrypted file (header + per-block IVs/tags) is shared by both names.
     * @param {string} src
     * @param {string} dest
     */
    public async link(src: string, dest: string): Promise<void> {
        await fs.link(this._mapPath(src), this._mapPath(dest));
    }

    /**
     * mknod — only regular files (S_IFREG) are accepted. The on-disk file is
     * created with the standard CryptFS header (filesize=0 + fresh nonce) so
     * subsequent reads return zero bytes.
     * @param {string} path
     * @param {number} mode
     * @param {number} _dev
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public async mknod(path: string, mode: number, _dev: number): Promise<void> {
        // eslint-disable-next-line no-bitwise
        const isRegular = (constants.S_IFMT & mode) === constants.S_IFREG;

        if (!isRegular) {
            throw new ErrnoFuseCb(Fuse.ENOSYS, 'CryptFS only supports regular files via mknod');
        }

        const dpath = this._mapPath(path);
        const flags =
            // eslint-disable-next-line no-bitwise
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_WRONLY;

        const fh = await fs.open(dpath, flags, mode);

        try {
            await fh.write(this._buildHeader(0), 0, CryptFS.META_SIZE, 0);
        } finally {
            await fh.close();
        }
    }

    /**
     * Shared resize implementation used by truncate() and ftruncate().
     * Re-encrypts the boundary block(s) when shrinking lands mid-block or
     * when extending grows past the old (possibly partial) trailing block.
     *
     * @param {fs.FileHandle} fh
     * @param {number} newSize
     * @param {number} [knownOldSize] Pre-known old plaintext size to avoid
     *   re-reading the header (e.g. from the per-fd cache in ftruncate).
     * @private
     */
    private async _resize(fh: fs.FileHandle, newSize: number, knownOldSize?: number): Promise<void> {
        const oldSize = knownOldSize ?? await this._readHeader(fh);

        if (newSize === oldSize) {
            return;
        }

        const oldNumBlocks = this._numBlocks(oldSize);
        const newNumBlocks = this._numBlocks(newSize);

        if (newSize < oldSize) {
            // Shrink: re-encrypt the new last block if shrinking mid-block.
            if (newNumBlocks > 0) {
                const lastBlock = newNumBlocks - 1;
                const oldPlainLen = this._plainLenOfBlock(lastBlock, oldSize);
                const newPlainLen = this._plainLenOfBlock(lastBlock, newSize);

                if (newPlainLen < oldPlainLen) {
                    const onDiskLen = oldPlainLen + CryptFS.BLOCK_OVERHEAD;
                    const onDiskBuf = Buffer.alloc(onDiskLen);
                    await fh.read(onDiskBuf, 0, onDiskLen, this._blockDiskOffset(lastBlock));
                    const plain = this._decryptBlock(lastBlock, onDiskBuf);
                    const truncated = plain.subarray(0, newPlainLen);
                    const encrypted = this._encryptBlock(lastBlock, truncated);
                    await fh.write(encrypted, 0, encrypted.length, this._blockDiskOffset(lastBlock));
                }
            }
            await fh.truncate(this._physicalSize(newSize));
        } else {
            // Extend: pad/grow the old trailing block to a full block (if it
            // was partial) and append zero-filled blocks up to the new size.
            const startBlock = oldNumBlocks > 0 ? oldNumBlocks - 1 : 0;
            for (let block = startBlock; block < newNumBlocks; block++) {
                const newPlainLen = this._plainLenOfBlock(block, newSize);

                let existing: Buffer;
                if (block < oldNumBlocks) {
                    const existingOnDiskLen =
                        this._plainLenOfBlock(block, oldSize) + CryptFS.BLOCK_OVERHEAD;
                    const onDiskBuf = Buffer.alloc(existingOnDiskLen);
                    // eslint-disable-next-line no-await-in-loop
                    await fh.read(onDiskBuf, 0, existingOnDiskLen, this._blockDiskOffset(block));
                    // eslint-disable-next-line no-await-in-loop
                    existing = this._decryptBlock(block, onDiskBuf);
                } else {
                    existing = Buffer.alloc(0);
                }

                const newPlain = Buffer.alloc(newPlainLen);
                existing.copy(newPlain, 0, 0, Math.min(existing.length, newPlainLen));

                const encrypted = this._encryptBlock(block, newPlain);
                // eslint-disable-next-line no-await-in-loop
                await fh.write(encrypted, 0, encrypted.length, this._blockDiskOffset(block));
            }
        }

        // Update filesize in header.
        const sizeBuf = Buffer.alloc(8);
        sizeBuf.writeBigInt64BE(BigInt(newSize), 0);
        await fh.write(sizeBuf, 0, 8, CryptFS.HEADER_FILESIZE_OFFSET);
    }

    /**
     * truncate
     * @param {string} path
     * @param {number} size
     */
    public async truncate(path: string, size: number): Promise<void> {
        if (size < 0) {
            throw new ErrnoFuseCb(Fuse.EINVAL);
        }

        const fh = await fs.open(this._mapPath(path), 'r+');
        try {
            await this._resize(fh, size);
        } finally {
            await fh.close();
        }
    }

    /**
     * ftruncate
     * @param {string} path
     * @param {number} fd
     * @param {number} size
     */
    public async ftruncate(path: string, fd: number, size: number): Promise<void> {
        const {fh} = this._handler.getHandle(fd);

        if (!fh) {
            throw new ErrnoFuseCb(Fuse.EBADF);
        }

        if (size < 0) {
            throw new ErrnoFuseCb(Fuse.EINVAL);
        }

        const oldSize = await this._getCachedFileSize(fd, fh);
        await this._resize(fh, size, oldSize);

        // _resize already persisted the new filesize to the header.
        const entry = this._metaCache.get(fd);
        if (entry) {
            entry.fileSize = size;
            entry.dirty = false;
        } else {
            this._metaCache.set(fd, {fileSize: size, dirty: false});
        }
    }

    /**
     * write
     * @param {string} path
     * @param {number} fd
     * @param {Buffer} buffer
     * @param {number} offset
     * @return {number}
     */
    public async write(path: string, fd: number, buffer: Buffer, offset: number): Promise<number> {
        const {fh} = this._handler.getHandle(fd);

        if (!fh) {
            throw new Error(`Filehandle not found ${fd}`);
        }

        const writeLen = buffer.length;
        const writeEnd = offset + writeLen;

        const fileSize = await this._getCachedFileSize(fd, fh);
        const oldNumBlocks = this._numBlocks(fileSize);
        const oldLastBlock = oldNumBlocks - 1;
        const oldLastPlainLen = oldLastBlock >= 0
            ? fileSize - (oldLastBlock * this._options.blockSize)
            : 0;

        const newFileSize = Math.max(fileSize, writeEnd);
        const newNumBlocks = this._numBlocks(newFileSize);
        const newLastBlock = newNumBlocks - 1;

        const firstTouched = Math.floor(offset / this._options.blockSize);
        const lastTouched = Math.floor((writeEnd - 1) / this._options.blockSize);

        // If the file grows past an old partial trailing block, that block is
        // no longer the trailing block — it must be re-encrypted as a full
        // blockSize block.
        let firstAffected = firstTouched;
        if (
            oldLastBlock >= 0 &&
            oldLastPlainLen < this._options.blockSize &&
            newLastBlock > oldLastBlock &&
            oldLastBlock < firstTouched
        ) {
            firstAffected = oldLastBlock;
        }

        const lastAffected = Math.max(lastTouched, newLastBlock);
        let bytesWritten = 0;

        // Identify the range of blocks whose existing ciphertext we still
        // need (on-disk blocks that aren't fully overwritten). Coalesce
        // them into a single fh.read; non-needed blocks inside the range
        // are over-read but cost only bandwidth, not extra syscalls.
        let firstReadBlock = -1;
        let lastReadBlock = -1;
        for (let block = firstAffected; block <= lastAffected; block++) {
            const blockPlainStart = block * this._options.blockSize;
            const newBlockPlainLen = this._plainLenOfBlock(block, newFileSize);
            const writeFullyCoversBlock =
                offset <= blockPlainStart &&
                writeEnd >= blockPlainStart + newBlockPlainLen;

            if (block < oldNumBlocks && !writeFullyCoversBlock) {
                if (firstReadBlock < 0) {
                    firstReadBlock = block;
                }
                lastReadBlock = block;
            }
        }

        let readBuf: Buffer | null = null;
        let readBufStart = 0;
        if (firstReadBlock >= 0) {
            readBufStart = this._blockDiskOffset(firstReadBlock);
            const lastReadOnDiskLen =
                this._plainLenOfBlock(lastReadBlock, fileSize) + CryptFS.BLOCK_OVERHEAD;
            const readLen =
                this._blockDiskOffset(lastReadBlock) + lastReadOnDiskLen - readBufStart;
            readBuf = Buffer.alloc(readLen);
            const {bytesRead} = await fh.read(readBuf, 0, readLen, readBufStart);
            if (bytesRead < readLen) {
                throw new ErrnoFuseCb(Fuse.EIO, 'CryptFS write RMW read truncated');
            }
        }

        // Encrypt every affected block into a contiguous buffer.
        const writeChunks: Buffer[] = [];

        for (let block = firstAffected; block <= lastAffected; block++) {
            const blockPlainStart = block * this._options.blockSize;
            const newBlockPlainLen = this._plainLenOfBlock(block, newFileSize);
            const writeFullyCoversBlock =
                offset <= blockPlainStart &&
                writeEnd >= blockPlainStart + newBlockPlainLen;

            let existing: Buffer;
            if (block < oldNumBlocks && !writeFullyCoversBlock) {
                const existingOnDiskLen =
                    this._plainLenOfBlock(block, fileSize) + CryptFS.BLOCK_OVERHEAD;
                const bufOff = this._blockDiskOffset(block) - readBufStart;
                existing = this._decryptBlock(
                    block,
                    readBuf!.subarray(bufOff, bufOff + existingOnDiskLen)
                );
            } else {
                existing = Buffer.alloc(0);
            }

            const newPlain = Buffer.alloc(newBlockPlainLen);
            existing.copy(newPlain, 0, 0, Math.min(existing.length, newBlockPlainLen));

            const sliceStart = Math.max(offset, blockPlainStart);
            const sliceEnd = Math.min(writeEnd, blockPlainStart + this._options.blockSize);

            if (sliceStart < sliceEnd) {
                const srcStart = sliceStart - offset;
                const dstStart = sliceStart - blockPlainStart;
                const copyLen = sliceEnd - sliceStart;
                buffer.copy(newPlain, dstStart, srcStart, srcStart + copyLen);
                bytesWritten += copyLen;
            }

            writeChunks.push(this._encryptBlock(block, newPlain));
        }

        // Single coalesced write covering every affected block.
        const writeBuf = Buffer.concat(writeChunks);
        await fh.write(
            writeBuf, 0, writeBuf.length, this._blockDiskOffset(firstAffected)
        );

        // Update the cached filesize; persist is deferred to release()/fsync().
        if (newFileSize !== fileSize) {
            const entry = this._metaCache.get(fd);
            if (entry) {
                entry.fileSize = newFileSize;
                entry.dirty = true;
            } else {
                this._metaCache.set(fd, {fileSize: newFileSize, dirty: true});
            }
        }

        return bytesWritten;
    }

}