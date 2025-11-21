import * as crypto from 'crypto';
import {Stats} from 'fs';
import * as fs from 'fs/promises';
import Fuse from 'fuse-native';
import * as path from 'path';

/**
 * NjsCrypt File System
 */
export class NjsCryptFS {

    public static BLOCK_SIZE = 64 * 1024;
    private static readonly AES_BLOCK = 16;
    private static readonly NONCE_SIZE = 16;
    private static readonly META_SIZE = 8 + NjsCryptFS.NONCE_SIZE;

    /**
     * Key
     * @private
     */
    private readonly _key: Buffer;

    /**
     * storage path
     * @private
     */
    private readonly _storagePath: string;

    /**
     * mount path
     * @private
     */
    private readonly _mountPath: string;

    /**
     * File handles
     * @protected
     */
    protected _handleCache = new Map<number, fs.FileHandle>();
    private _nextHandle = 100;

    /**
     * constructor
     * @param {string} storagePath
     * @param {string} mountPath
     * @param {Buffer} key
     */
    public constructor(storagePath: string, mountPath: string, key: Buffer) {
        this._storagePath = storagePath;
        this._mountPath = mountPath;
        this._key = key;
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
        const decipher = crypto.createDecipheriv('aes-256-ctr', this._key, iv);
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
        const cipher = crypto.createCipheriv('aes-256-ctr', this._key, iv);
        return Buffer.concat([cipher.update(plaintext), cipher.final()]);
    }

    /**
     * encode a name (file or folder name)
     * @param {string} name
     * @return {string}
     * @private
     */
    private _encodeName(name: string): string {
        const cipher = crypto.createCipheriv('aes-256-gcm', this._key, Buffer.alloc(12,0));
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

        const decipher = crypto.createDecipheriv('aes-256-gcm', this._key, Buffer.alloc(12,0));
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
        return path.join(this._storagePath, ...encParts);
    }

    /**
     * Mount start
     */
    public mount(): void {
        const fuse = new Fuse(this._mountPath, {

            /**
             * readdir
             * @param {string} p
             * @param {(err: number | null, names?: string[]) => void} cb
             */
            readdir: async(
                p: string,
                cb: (err: number | null, names?: string[]) => void
            ): Promise<void> => {
                const fullPath = p === '/' ? this._storagePath : this._mapPath(p);

                try {
                    const files = (await fs.readdir(fullPath)).map((fn) => {
                        try {
                            return this._decodeName(fn);
                        } catch {
                            return '???';
                        }
                    });

                    cb(0, files);
                } catch {
                    cb(-2, []);
                }
            },

            /**
             * get attr
             * @param {string} p
             * @param {(err: number | null, stat?: Stats) => void} cb
             */
            getattr: async(
                p: string,
                cb: (err: number | null, stat?: Stats) => void
            ): Promise<void> => {
                const fullPath = p === '/' ? this._storagePath : this._mapPath(p);

                try {
                    const stat = await fs.stat(fullPath);

                    if (stat.isDirectory()) {
                        cb(0, {
                            mtime: stat.mtime,
                            atime: stat.atime,
                            ctime: stat.ctime,
                            size: stat.size,
                            mode: 0o040755,
                            uid: stat.uid,
                            gid: stat.gid
                        } as any);

                        return;
                    }

                    let fileSize = 0;

                    if (stat.size >= NjsCryptFS.META_SIZE) {
                        const fh = await fs.open(fullPath, 'r');
                        const b = Buffer.alloc(8);
                        await fh.read(b, 0, 8, 0);
                        await fh.close();

                        fileSize = Number(b.readBigInt64BE(0));
                    }

                    cb(0, {
                        mtime: stat.mtime,
                        atime: stat.atime,
                        ctime: stat.ctime,
                        size: fileSize,
                        mode: 0o100644,
                        uid: stat.uid,
                        gid: stat.gid
                    } as any);

                } catch {
                    cb(-2, undefined);
                }
            },

            /**
             * Open
             * @param {string} openPath
             * @param {number} flags
             * @param {(code: number, fd: number) => void} cb
             */
            open: async(
                openPath: string,
                flags: number,
                cb: (code: number, fd: number) => void
            ): Promise<void> => {
                try {
                    const fullPath = this._mapPath(openPath);
                    const fh = await fs.open(fullPath, flags);
                    const id = this._nextHandle++;

                    this._handleCache.set(id, fh);

                    cb(0, id);
                } catch (e) {
                    console.error('OPEN ERROR', e);
                    cb(-1, 0);
                }
            },

            /**
             * read
             * @param {string} _p
             * @param {number} fd
             * @param {Buffer} buf
             * @param {number} len
             * @param {number} pos
             * @param {(bytesRead: number) => void} cb
             */
            read: async(
                _p: string,
                fd: number,
                buf: Buffer,
                len: number,
                pos: number,
                cb: (bytesRead: number) => void
            ): Promise<void> => {
                const fh = this._handleCache.get(fd);

                if (!fh) {
                    cb(0);
                    return;
                }

                try {
                    const header = Buffer.alloc(NjsCryptFS.META_SIZE);
                    const { bytesRead: headRead } = await fh.read(header, 0, header.length, 0);

                    if (headRead < NjsCryptFS.META_SIZE) {
                        cb(0);
                        return;
                    }
                    const fileSize = Number(header.readBigInt64BE(0));
                    const nonce = header.subarray(8, 8 + NjsCryptFS.NONCE_SIZE);

                    if (pos >= fileSize) {
                        cb(0);
                        return;
                    }

                    const toReadTotal = Math.min(len, fileSize - pos);

                    let done = 0;
                    while (done < toReadTotal) {
                        const currentPos = pos + done;
                        const blockIndex = Math.floor(currentPos / NjsCryptFS.BLOCK_SIZE);
                        const blockOffset = currentPos % NjsCryptFS.BLOCK_SIZE;
                        const toRead = Math.min(NjsCryptFS.BLOCK_SIZE - blockOffset, toReadTotal - done);
                        const absoluteDataStart = blockIndex * NjsCryptFS.BLOCK_SIZE;
                        const counterBlockStart = Math.floor(absoluteDataStart / NjsCryptFS.AES_BLOCK) * NjsCryptFS.AES_BLOCK;
                        const offsetWithinCounterBlock = currentPos - counterBlockStart;
                        const cipherFilePos = NjsCryptFS.META_SIZE + counterBlockStart;

                        const cipherReadLen = Math.min(
                            Math.ceil((offsetWithinCounterBlock + toRead) / NjsCryptFS.AES_BLOCK) * NjsCryptFS.AES_BLOCK,
                            fileSize - counterBlockStart
                        );

                        const encBuf = Buffer.allocUnsafe(cipherReadLen);
                        const { bytesRead: bRead } = await fh.read(encBuf, 0, cipherReadLen, cipherFilePos);

                        if (bRead === 0) {
                            buf.fill(0, done, done + toRead);
                        } else {
                            const blockCounter = BigInt(counterBlockStart / NjsCryptFS.AES_BLOCK);
                            const plain = this._decryptCTR(nonce, blockCounter, encBuf.subarray(0, bRead));
                            const srcStart = offsetWithinCounterBlock;
                            const slice = plain.subarray(srcStart, srcStart + toRead);

                            slice.copy(buf, done);
                        }

                        done += toRead;
                    }

                    cb(done);
                } catch (e) {
                    console.error('READ ERROR', e);
                    cb(0);
                }
            },

            /**
             * Write
             * @param {string} _p Path (unused)
             * @param {number} fd File handler id
             * @param {Buffer} buf
             * @param {number} len
             * @param {number} pos
             * @param {(written: number) => void} cb
             */
            write: async(_p: string,
                fd: number,
                buf: Buffer,
                len: number,
                pos: number,
                cb: (written: number) => void): Promise<void> => {
                const fh = this._handleCache.get(fd);

                if (!fh) {
                    cb(0);
                    return;
                }

                try {
                    const stat = await fh.stat();

                    if (stat.size < NjsCryptFS.META_SIZE) {
                        const nb = Buffer.alloc(NjsCryptFS.META_SIZE);
                        nb.writeBigInt64BE(0n, 0);

                        const nonce = crypto.randomBytes(NjsCryptFS.NONCE_SIZE);
                        nonce.copy(nb, 8);

                        await fh.write(nb, 0, nb.length, 0);
                    }

                    const header = Buffer.alloc(NjsCryptFS.META_SIZE);

                    await fh.read(header, 0, header.length, 0);

                    let fileSize = Number(header.readBigInt64BE(0));
                    const nonce = header.subarray(8, 8 + NjsCryptFS.NONCE_SIZE);

                    const endPos = pos + len;

                    if (endPos > fileSize) {
                        fileSize = endPos;
                    }

                    let bytesWritten = 0;

                    while (bytesWritten < len) {
                        const currentPos = pos + bytesWritten;
                        const blockIndex = Math.floor(currentPos / NjsCryptFS.BLOCK_SIZE);
                        const blockOffset = currentPos % NjsCryptFS.BLOCK_SIZE;
                        const toWrite = Math.min(NjsCryptFS.BLOCK_SIZE - blockOffset, len - bytesWritten);

                        const absoluteBlockStart = blockIndex * NjsCryptFS.BLOCK_SIZE;
                        const counterBlockStart = Math.floor(absoluteBlockStart / NjsCryptFS.AES_BLOCK) * NjsCryptFS.AES_BLOCK;

                        const cipherFilePos = NjsCryptFS.META_SIZE + counterBlockStart;
                        const needPlainBytes = blockOffset + toWrite;
                        const cipherReadLen = Math.min(
                            Math.ceil(needPlainBytes / NjsCryptFS.AES_BLOCK) * NjsCryptFS.AES_BLOCK,
                            fileSize - counterBlockStart
                        );

                        const encBuf = Buffer.allocUnsafe(cipherReadLen);
                        const { bytesRead: bRead } = await fh.read(encBuf, 0, cipherReadLen, cipherFilePos);

                        let plainBlock: Buffer;
                        if (bRead > 0) {
                            plainBlock = this._decryptCTR(nonce, BigInt(counterBlockStart / NjsCryptFS.AES_BLOCK), encBuf.subarray(0, bRead));

                            if (plainBlock.length < cipherReadLen) {
                                const tmp = Buffer.alloc(cipherReadLen);

                                plainBlock.copy(tmp, 0);
                                plainBlock = tmp;
                            }
                        } else {
                            plainBlock = Buffer.alloc(Math.max(needPlainBytes, 0));
                        }

                        if (plainBlock.length < blockOffset + toWrite) {
                            const tmp = Buffer.alloc(blockOffset + toWrite);

                            plainBlock.copy(tmp, 0);
                            plainBlock = tmp;
                        }

                        buf.copy(plainBlock, blockOffset, bytesWritten, bytesWritten + toWrite);

                        const encNew = this._encryptCTR(
                            nonce,
                            BigInt(counterBlockStart / NjsCryptFS.AES_BLOCK),
                            plainBlock
                        );

                        await fh.write(encNew, 0, encNew.length, cipherFilePos);

                        bytesWritten += toWrite;
                    }

                    const sizeBuf = Buffer.alloc(8);
                    sizeBuf.writeBigInt64BE(BigInt(fileSize), 0);
                    await fh.write(sizeBuf, 0, 8, 0);

                    cb(len);
                } catch (e) {
                    console.error('WRITE ERROR', e);
                    cb(0);
                }
            },

            /**
             * Create
             * @param {string} p
             * @param {number} mode
             * @param {(err: number | null, fd?: number) => void} cb
             */
            create: async(
                p: string,
                mode: number,
                cb: (err: number | null, fd?: number) => void
            ): Promise<void> => {
                try {
                    const fullPath = this._mapPath(p);
                    const fh = await fs.open(fullPath, 'w+');
                    const buf = Buffer.alloc(NjsCryptFS.META_SIZE);

                    buf.writeBigInt64BE(0n, 0);

                    const nonce = crypto.randomBytes(NjsCryptFS.NONCE_SIZE);
                    nonce.copy(buf, 8);

                    await fh.write(buf, 0, buf.length, 0);

                    const handle = this._nextHandle++;
                    this._handleCache.set(handle, fh);
                    cb(0, handle);
                } catch (e) {
                    console.error('CREATE ERROR', e);
                    cb(-1, 0);
                }
            },

            /**
             * unlink
             * @param {string} p Path to file
             * @param {(err: number | null) => void} cb
             */
            unlink: async(
                p: string,
                cb: (err: number | null) => void
            ): Promise<void> => {
                const fullPath = this._mapPath(p);

                try {
                    await fs.unlink(fullPath);
                } catch {
                    console.log(`Error unlink ${fullPath}`);
                }

                cb(0);
            },

            /**
             * mkdir
             * @param {string} p Path to directory
             * @param {number} mode
             * @param {(err: number | null) => void} cb
             */
            mkdir: async(
                p: string,
                mode: number,
                cb: (err: number | null) => void
            ): Promise<void> => {
                const fullPath = this._mapPath(p);

                try {
                    await fs.mkdir(fullPath, {mode: mode});
                } catch {
                    console.log(`Error mkdir ${fullPath}`);
                }

                cb(0);
            },

            /**
             * rmdir
             * @param {string} p Path to directory
             * @param {(err: number | null) => void} cb
             */
            rmdir: async(
                p: string,
                cb: (err: number | null) => void
            ): Promise<void> => {
                const fullPath = this._mapPath(p);

                try {
                    await fs.rmdir(fullPath);
                } catch {
                    console.log(`Error rmdir ${fullPath}`);
                }

                cb(0);
            },

            /**
             * rename
             * @param {string} src
             * @param {string} dest
             * @param {(err: number | null) => void} cb
             */
            rename: async(
                src: string,
                dest: string,
                cb: (err: number | null) => void
            ): Promise<void> => {
                const fullSrc = this._mapPath(src);
                const fullDest = this._mapPath(dest);

                try {
                    await fs.rename(fullSrc, fullDest);
                } catch {
                    console.log(`Error rename ${fullSrc} -> ${fullDest}`);
                }

                cb(0);
            },

            /**
             * release
             * @param {string} _path
             * @param {number} fd
             * @param {(err: number | null) => void} cb
             */
            release: async(
                _path: string,
                fd: number,
                cb: (err: number | null) => void
            ): Promise<void> => {
                const fh = this._handleCache.get(fd);

                if (fh) {
                    await fh.close();
                    this._handleCache.delete(fd);
                }

                cb(0);
            }
        }, { force: true, debug: false });

        fuse.mount(err => {
            if (err) {
                console.error('Mount failed', err);
            } else {
                console.log('Mounted', this._mountPath);
            }
        });

        process.on('SIGINT', () => this.unmount(fuse));
    }

    /**
     * Unmount
     * @param {Fuse} fuse
     */
    public unmount(fuse?: Fuse): void {
        fuse?.unmount(err => {
            if (err) {
                console.error('Unmount failed', err);
            } else {
                console.log('Unmounted', this._mountPath);
            }

            process.exit(0);
        });
    }

}