import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import Fuse from 'fuse-native';
import * as path from 'path';

/**
 * EncryptedFS
 */
export class EncryptedFS {

    public static BLOCK_SIZE = 64 * 1024;
    private static readonly AES_BLOCK = 16;
    private static readonly NONCE_SIZE = 16;
    private static readonly META_SIZE = 8 + EncryptedFS.NONCE_SIZE;

    /**
     * Key
     * @private
     */
    private readonly key: Buffer;

    /**
     * storage path
     * @private
     */
    private readonly storagePath: string;

    /**
     * mount path
     * @private
     */
    private readonly mountPath: string;

    /**
     * File handles
     * @protected
     */
    protected _handleCache = new Map<number, fs.FileHandle>();
    private _nextHandle = 100;

    public constructor(storagePath: string, mountPath: string, key: Buffer) {
        this.storagePath = storagePath;
        this.mountPath = mountPath;
        this.key = key;
    }

    private deriveCounterIV(nonce: Buffer, blockCounter: bigint): Buffer {
        const iv = Buffer.from(nonce);
        const last = iv.readBigUInt64BE(8);
        const sum = last + blockCounter;

        iv.writeBigUInt64BE(sum, 8);

        return iv;
    }

    private decryptCTR(nonce: Buffer, blockCounter: bigint, ciphertext: Buffer): Buffer {
        const iv = this.deriveCounterIV(nonce, blockCounter);
        const decipher = crypto.createDecipheriv('aes-256-ctr', this.key, iv);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    }

    private encryptCTR(nonce: Buffer, blockCounter: bigint, plaintext: Buffer): Buffer {
        const iv = this.deriveCounterIV(nonce, blockCounter);
        const cipher = crypto.createCipheriv('aes-256-ctr', this.key, iv);
        return Buffer.concat([cipher.update(plaintext), cipher.final()]);
    }

    private encodeName(name: string): string {
        const cipher = crypto.createCipheriv('aes-256-gcm', this.key, Buffer.alloc(12,0));
        const encrypted = Buffer.concat([cipher.update(Buffer.from(name,'utf8')), cipher.final()]);
        const tag = cipher.getAuthTag();
        return Buffer.concat([tag, encrypted])
        .toString('base64')
        .replace(/\+/gu, '-')
        .replace(/\//gu, '_')
        .replace(/[=]+$/u,'');
    }

    private decodeName(encName: string): string {
        const b64 = encName.replace(/-/gu, '+').replace(/_/gu, '/');
        const buf = Buffer.from(b64, 'base64');
        const tag = buf.subarray(0,16);
        const encrypted = buf.subarray(16);

        const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.alloc(12,0));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    }

    private mapPath(mountPath: string): string {
        const parts = mountPath.split('/').filter(Boolean);
        const encParts = parts.map(p => this.encodeName(p));
        return path.join(this.storagePath, ...encParts);
    }

    public mount(): void {
        const fuse = new Fuse(this.mountPath, {
            readdir: async(p, cb): Promise<void> => {
                const fullPath = p === '/' ? this.storagePath : this.mapPath(p);

                try {
                    const files = (await fs.readdir(fullPath)).map((fn) => {
                        try {
                            return this.decodeName(fn);
                        } catch {
                            return '???';
                        }
                    });

                    cb(0, files);
                } catch {
                    cb(-2, []);
                }
            },

            getattr: async(p, cb): Promise<void> => {
                const fullPath = p === '/' ? this.storagePath : this.mapPath(p);

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

                    if (stat.size >= EncryptedFS.META_SIZE) {
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
                    const fullPath = this.mapPath(openPath);
                    const fh = await fs.open(fullPath, flags);
                    const id = this._nextHandle++;

                    this._handleCache.set(id, fh);

                    cb(0, id);
                } catch (e) {
                    console.error('OPEN ERROR', e);
                    cb(-1, 0);
                }
            },

            read: async(p, fd, buf, len, pos, cb): Promise<void> => {
                const fh = this._handleCache.get(fd);

                if (!fh) {
                    cb(0);
                    return;
                }

                try {
                    const header = Buffer.alloc(EncryptedFS.META_SIZE);
                    const { bytesRead: headRead } = await fh.read(header, 0, header.length, 0);

                    if (headRead < EncryptedFS.META_SIZE) {
                        cb(0);
                        return;
                    }
                    const fileSize = Number(header.readBigInt64BE(0));
                    const nonce = header.subarray(8, 8 + EncryptedFS.NONCE_SIZE);

                    if (pos >= fileSize) {
                        cb(0);
                        return;
                    }

                    const toReadTotal = Math.min(len, fileSize - pos);

                    let done = 0;
                    while (done < toReadTotal) {
                        const currentPos = pos + done;
                        const blockIndex = Math.floor(currentPos / EncryptedFS.BLOCK_SIZE);
                        const blockOffset = currentPos % EncryptedFS.BLOCK_SIZE;
                        const toRead = Math.min(EncryptedFS.BLOCK_SIZE - blockOffset, toReadTotal - done);
                        const absoluteDataStart = blockIndex * EncryptedFS.BLOCK_SIZE;
                        const counterBlockStart = Math.floor(absoluteDataStart / EncryptedFS.AES_BLOCK) * EncryptedFS.AES_BLOCK;
                        const offsetWithinCounterBlock = currentPos - counterBlockStart;
                        const cipherFilePos = EncryptedFS.META_SIZE + counterBlockStart;

                        const cipherReadLen = Math.min(
                            Math.ceil((offsetWithinCounterBlock + toRead) / EncryptedFS.AES_BLOCK) * EncryptedFS.AES_BLOCK,
                            fileSize - counterBlockStart
                        );

                        const encBuf = Buffer.allocUnsafe(cipherReadLen);
                        const { bytesRead: bRead } = await fh.read(encBuf, 0, cipherReadLen, cipherFilePos);

                        if (bRead === 0) {
                            buf.fill(0, done, done + toRead);
                        } else {
                            const blockCounter = BigInt(counterBlockStart / EncryptedFS.AES_BLOCK);
                            const plain = this.decryptCTR(nonce, blockCounter, encBuf.subarray(0, bRead));
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

            write: async(_p, fd, buf, len, pos, cb): Promise<void> => {
                const fh = this._handleCache.get(fd);

                if (!fh) {
                    cb(0);
                    return;
                }

                try {
                    const stat = await fh.stat();

                    if (stat.size < EncryptedFS.META_SIZE) {
                        const nb = Buffer.alloc(EncryptedFS.META_SIZE);
                        nb.writeBigInt64BE(0n, 0);
                        const nonce = crypto.randomBytes(EncryptedFS.NONCE_SIZE);
                        nonce.copy(nb, 8);
                        await fh.write(nb, 0, nb.length, 0);
                    }

                    const header = Buffer.alloc(EncryptedFS.META_SIZE);
                    await fh.read(header, 0, header.length, 0);
                    let fileSize = Number(header.readBigInt64BE(0));
                    const nonce = header.subarray(8, 8 + EncryptedFS.NONCE_SIZE);

                    const endPos = pos + len;
                    if (endPos > fileSize) {
                        fileSize = endPos;
                    }

                    let bytesWritten = 0;
                    while (bytesWritten < len) {
                        const currentPos = pos + bytesWritten;
                        const blockIndex = Math.floor(currentPos / EncryptedFS.BLOCK_SIZE);
                        const blockOffset = currentPos % EncryptedFS.BLOCK_SIZE;
                        const toWrite = Math.min(EncryptedFS.BLOCK_SIZE - blockOffset, len - bytesWritten);

                        // determine counter-aligned region to read: start at counterBlockStart
                        const absoluteBlockStart = blockIndex * EncryptedFS.BLOCK_SIZE;
                        const counterBlockStart = Math.floor(absoluteBlockStart / EncryptedFS.AES_BLOCK) * EncryptedFS.AES_BLOCK;

                        const cipherFilePos = EncryptedFS.META_SIZE + counterBlockStart;
                        // read enough ciphertext to cover (blockOffset + toWrite), round up to AES_BLOCKs
                        const needPlainBytes = blockOffset + toWrite;
                        const cipherReadLen = Math.min(
                            Math.ceil(needPlainBytes / EncryptedFS.AES_BLOCK) * EncryptedFS.AES_BLOCK,
                            fileSize - counterBlockStart
                        );

                        const encBuf = Buffer.allocUnsafe(cipherReadLen);
                        const { bytesRead: bRead } = await fh.read(encBuf, 0, cipherReadLen, cipherFilePos);

                        let plainBlock: Buffer;
                        if (bRead > 0) {
                            plainBlock = this.decryptCTR(nonce, BigInt(counterBlockStart / EncryptedFS.AES_BLOCK), encBuf.subarray(0, bRead));

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

                        const encNew = this.encryptCTR(nonce, BigInt(counterBlockStart / EncryptedFS.AES_BLOCK), plainBlock);

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

            create: async(p, mode, cb): Promise<void> => {
                try {
                    const fullPath = this.mapPath(p);
                    const fh = await fs.open(fullPath, 'w+');
                    const buf = Buffer.alloc(EncryptedFS.META_SIZE);
                    buf.writeBigInt64BE(0n, 0);
                    const nonce = crypto.randomBytes(EncryptedFS.NONCE_SIZE);
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

            unlink: async(p, cb): Promise<void> => {
                const fullPath = this.mapPath(p);

                try {
                    await fs.unlink(fullPath);
                } catch {
                    console.log(`Error unlink ${fullPath}`);
                }

                cb(0);
            },

            mkdir: async(p, mode, cb): Promise<void> => {
                const fullPath = this.mapPath(p);

                try {
                    await fs.mkdir(fullPath, {mode: mode});
                } catch {
                    console.log(`Error mkdir ${fullPath}`);
                }

                cb(0);
            },

            rmdir: async(p, cb): Promise<void> => {
                const fullPath = this.mapPath(p);

                try {
                    await fs.rmdir(fullPath);
                } catch {
                    console.log(`Error rmdir ${fullPath}`);
                }

                cb(0);
            },

            rename: async(src, dest, cb): Promise<void> => {
                const fullSrc = this.mapPath(src);
                const fullDest = this.mapPath(dest);

                try {
                    await fs.rename(fullSrc, fullDest);
                } catch {
                    console.log(`Error rename ${fullSrc} -> ${fullDest}`);
                }

                cb(0);
            },

            release: async(_path, fd, cb): Promise<void> => {
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
                console.log('Mounted', this.mountPath);
            }
        });

        process.on('SIGINT', () => this.unmount(fuse));
    }

    public unmount(fuse?: Fuse): void {
        fuse?.unmount(err => {
            if (err) {
                console.error('Unmount failed', err);
            } else {
                console.log('Unmounted', this.mountPath);
            }

            process.exit(0);
        });
    }

}