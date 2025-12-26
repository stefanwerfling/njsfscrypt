import Fuse, {StatFs} from 'fuse-native';
import {constants} from 'node:fs';
import {stat, chmod, truncate, utimes} from 'node:fs/promises';
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

    private static readonly AES_BLOCK = 16;
    private static readonly NONCE_SIZE = 16;
    private static readonly META_SIZE = 8 + CryptFS.NONCE_SIZE;

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
     * generate a counter iv for block
     * @param {Buffer} nonce
     * @param {bigint} blockCounter
     * @return {Buffer}
     * @private
     */
    private _deriveCounterIV(nonce: Buffer, blockCounter: bigint): Buffer {
        const iv = Buffer.from(nonce);
        const last = iv.readBigUInt64BE(8);
        const sum = last + blockCounter;

        iv.writeBigUInt64BE(sum, 8);

        return iv;
    }

    /**
     * decrypt with CTR
     * @param {buffer} nonce
     * @param {bigint} blockCounter
     * @param {Buffer} ciphertext
     * @return {Buffer}
     * @private
     */
    private _decryptCTR(nonce: Buffer, blockCounter: bigint, ciphertext: Buffer): Buffer {
        const iv = this._deriveCounterIV(nonce, blockCounter);
        const decipher = crypto.createDecipheriv('aes-256-ctr', this._options.encryptionKey, iv);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    }

    /**
     * encrypt with CTR
     * @param {Buffer} nonce
     * @param {bigint} blockCounter
     * @param {Buffer} plaintext
     * @return {Buffer}
     * @private
     */
    private _encryptCTR(nonce: Buffer, blockCounter: bigint, plaintext: Buffer): Buffer {
        const iv = this._deriveCounterIV(nonce, blockCounter);
        const cipher = crypto.createCipheriv('aes-256-ctr', this._options.encryptionKey, iv);
        return Buffer.concat([cipher.update(plaintext), cipher.final()]);
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
        const buf = Buffer.alloc(CryptFS.META_SIZE);

        buf.writeBigInt64BE(0n, 0);

        const nonce = crypto.randomBytes(CryptFS.NONCE_SIZE);
        nonce.copy(buf, 8);

        await fh.write(buf, 0, buf.length, 0);

        return this._handler.allocHandle({
            fh: fh,
            path: path,
            realPath: dpath,
            flags: flags
        });
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

        const tstat = await fs.stat(fullPath);

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

        // files -------------------------------------------------------------------------------------------------------

        let fileSize = 0;

        if (tstat.size >= CryptFS.META_SIZE) {
            const fh = await fs.open(fullPath, 'r');

            try {
                const buf = Buffer.alloc(8);
                await fh.read(buf, 0, 8, 0);

                fileSize = Number(buf.readBigInt64BE(0));
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
        const { fh } = this._handler.getHandle(fd);

        if (!fh) {
            throw new Error(`Filehandle not found: ${fd}`);
        }

        /**
         * Read header
         */

        const header = Buffer.alloc(CryptFS.META_SIZE);
        const { bytesRead: headRead } = await fh.read(header, 0, header.length, 0);

        if (headRead < CryptFS.META_SIZE) {
            return Buffer.alloc(0);
        }

        const fileSize = Number(header.readBigInt64BE(0));
        const nonce = header.subarray(8, 8 + CryptFS.NONCE_SIZE);

        if (offset >= fileSize) {
            return Buffer.alloc(0);
        }

        const toReadTotal = Math.min(length, fileSize - offset);
        const out = Buffer.alloc(toReadTotal);

        /**
         * calculate block range
         */

        const firstBlock = Math.floor(offset / this._options.blockSize);
        const lastBlock  = Math.floor((offset + toReadTotal - 1) / this._options.blockSize);

        let done = 0;

        /**
         * Read block
         */

        for (let block = firstBlock; block <= lastBlock; block++) {
            const blockPlainStart = block * this._options.blockSize;
            const blockPlainEnd   = blockPlainStart + this._options.blockSize;

            const readStart = Math.max(offset, blockPlainStart);
            const readEnd   = Math.min(offset + toReadTotal, blockPlainEnd);

            const readLenInBlock = readEnd - readStart;
            const readOffsetInBlock = readStart - blockPlainStart;

            const counterBlockStart =
                Math.floor(blockPlainStart / CryptFS.AES_BLOCK) * CryptFS.AES_BLOCK;

            const cipherFilePos = CryptFS.META_SIZE + counterBlockStart;

            const neededPlainBytes =
                blockPlainEnd - counterBlockStart;

            const cipherReadLen =
                Math.ceil(neededPlainBytes / CryptFS.AES_BLOCK) * CryptFS.AES_BLOCK;

            // read chipher --------------------------------------------------------------------------------------------

            const encBuf = Buffer.alloc(cipherReadLen);
            // eslint-disable-next-line no-await-in-loop
            const { bytesRead } = await fh.read(
                encBuf,
                0,
                cipherReadLen,
                cipherFilePos
            );

            if (bytesRead < cipherReadLen) {
                encBuf.fill(0, bytesRead);
            }

            // decrypt -------------------------------------------------------------------------------------------------

            const plain = this._decryptCTR(
                nonce,
                BigInt(counterBlockStart / CryptFS.AES_BLOCK),
                encBuf
            );

            // copy slice ----------------------------------------------------------------------------------------------

            plain.copy(
                out,
                done,
                readOffsetInBlock,
                readOffsetInBlock + readLenInBlock
            );

            done += readLenInBlock;
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
            await fh.close();
            this._handler.freeHandle(fd);
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
     * truncate
     * @param {string} path
     * @param {number} size
     */
    public async truncate(path: string, size: number): Promise<void> {
        const fh = await fs.open(this._mapPath(path), 'r+');
        try {
            const header = Buffer.alloc(CryptFS.META_SIZE);
            await fh.read(header, 0, header.length, 0);

            const sizeBuf = Buffer.alloc(8);
            sizeBuf.writeBigInt64BE(BigInt(size), 0);
            await fh.write(sizeBuf, 0, 8, 0);

            const blocks = Math.ceil(size / CryptFS.AES_BLOCK);
            await fh.truncate(CryptFS.META_SIZE + (blocks * CryptFS.AES_BLOCK));
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
        const { fh } = this._handler.getHandle(fd);

        if (!fh) {
            throw new ErrnoFuseCb(Fuse.EBADF);
        }

        if (size < 0) {
            throw new ErrnoFuseCb(Fuse.EINVAL);
        }

        const header = Buffer.alloc(CryptFS.META_SIZE);
        await fh.read(header, 0, header.length, 0);

        // create new header -------------------------------------------------------------------------------------------

        const sizeBuf = Buffer.alloc(8);
        sizeBuf.writeBigInt64BE(BigInt(size), 0);
        await fh.write(sizeBuf, 0, 8, 0);

        // -------------------------------------------------------------------------------------------------------------

        const blocks = Math.ceil(size / CryptFS.AES_BLOCK);
        const newPhysicalSize =
            CryptFS.META_SIZE + (blocks * CryptFS.AES_BLOCK);

        const st = await fh.stat();

        if (newPhysicalSize < st.size) {
            await fh.truncate(newPhysicalSize);
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
        const { fh } = this._handler.getHandle(fd);

        if (!fh) {
            throw new Error(`Filehandle not found ${fd}`);
        }

        const writeLen = buffer.length;
        const writeEnd = offset + writeLen;

        /**
         * Header read or init
         */

        const header = Buffer.alloc(CryptFS.META_SIZE);
        let fileSize = 0;
        let nonce: Buffer;

        const st = await fh.stat();

        if (st.size < CryptFS.META_SIZE) {
            nonce = crypto.randomBytes(CryptFS.NONCE_SIZE);
            header.writeBigInt64BE(0n, 0);
            nonce.copy(header, 8);

            await fh.write(header, 0, header.length, 0);
        } else {
            await fh.read(header, 0, header.length, 0);

            fileSize = Number(header.readBigInt64BE(0));
            nonce = header.subarray(8, 8 + CryptFS.NONCE_SIZE);
        }

        /**
         * New filesize
         */

        const newFileSize = Math.max(fileSize, writeEnd);

        /**
         * get plain block
         */

        const firstBlock = Math.floor(offset / this._options.blockSize);
        const lastBlock  = Math.floor((writeEnd - 1) / this._options.blockSize);

        let bytesWritten = 0;

        /**
         * block read
         */

        for (let block = firstBlock; block <= lastBlock; block++) {
            const blockPlainStart = block * this._options.blockSize;
            const blockPlainEnd   = blockPlainStart + this._options.blockSize;

            const writeStart = Math.max(offset, blockPlainStart);
            const writeEndInBlock = Math.min(writeEnd, blockPlainEnd);

            const writeLenInBlock = writeEndInBlock - writeStart;
            const writeOffsetInBlock = writeStart - blockPlainStart;

            // cipher offset (CTR Counter) -----------------------------------------------------------------------------

            const counterBlockStart =
                Math.floor(blockPlainStart / CryptFS.AES_BLOCK) * CryptFS.AES_BLOCK;

            const cipherFilePos = CryptFS.META_SIZE + counterBlockStart;

            // how much? -----------------------------------------------------------------------------------------------

            const neededPlainBytes =
                Math.max(blockPlainEnd, writeEnd) - counterBlockStart;

            const cipherReadLen =
                Math.ceil(neededPlainBytes / CryptFS.AES_BLOCK) * CryptFS.AES_BLOCK;

            // chipher read --------------------------------------------------------------------------------------------

            const encBuf = Buffer.alloc(cipherReadLen);

            // eslint-disable-next-line no-await-in-loop
            const { bytesRead } = await fh.read(
                encBuf,
                0,
                cipherReadLen,
                cipherFilePos
            );

            if (bytesRead < cipherReadLen) {
                encBuf.fill(0, bytesRead);
            }

            // decrypt -------------------------------------------------------------------------------------------------

            let plain = this._decryptCTR(
                nonce,
                BigInt(counterBlockStart / CryptFS.AES_BLOCK),
                encBuf
            );

            // new block add -------------------------------------------------------------------------------------------

            if (plain.length < cipherReadLen) {
                const tmp = Buffer.alloc(cipherReadLen);
                plain.copy(tmp);
                plain = tmp;
            }

            // new data write ------------------------------------------------------------------------------------------

            buffer.copy(
                plain,
                writeOffsetInBlock,
                bytesWritten,
                bytesWritten + writeLenInBlock
            );

            bytesWritten += writeLenInBlock;

            // encrypt -------------------------------------------------------------------------------------------------

            const encNew = this._encryptCTR(
                nonce,
                BigInt(counterBlockStart / CryptFS.AES_BLOCK),
                plain
            );

            // write to file -------------------------------------------------------------------------------------------

            // eslint-disable-next-line no-await-in-loop
            await fh.write(encNew, 0, encNew.length, cipherFilePos);
        }

        /**
         * add new filesize to header and write
         */

        const sizeBuf = Buffer.alloc(8);
        sizeBuf.writeBigInt64BE(BigInt(newFileSize), 0);
        await fh.write(sizeBuf, 0, 8, 0);

        return bytesWritten;
    }

}