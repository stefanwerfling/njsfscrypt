import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import Fuse from 'fuse-native';
import * as path from 'path';

/**
 * EncryptedFS
 */
export class EncryptedFS {

    public static BLOCK_SIZE = 64 * 1024;
    private static readonly HEADER_SIZE = 12 + 16;
    private static readonly META_SIZE = 8;

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

    public constructor(storagePath: string, mountPath: string, key?: Buffer) {
        this.storagePath = storagePath;
        this.mountPath = mountPath;
        // AES-256
        this.key = key ?? crypto.randomBytes(32);
    }

    private async encryptBlock(plain: Buffer): Promise<Buffer> {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
        const ct1 = cipher.update(plain);
        const ct2 = cipher.final();
        const tag = cipher.getAuthTag();

        const outLen = EncryptedFS.HEADER_SIZE + ct1.length + ct2.length;
        const out = Buffer.allocUnsafe(outLen);
        let off = 0;

        iv.copy(out, off); off += 12;
        tag.copy(out, off); off += 16;
        ct1.copy(out, off); off += ct1.length;

        if (ct2.length) {
            ct2.copy(out, off);
        }

        return out;
    }

    private async decryptBlock(enc: Buffer): Promise<Buffer> {
        if (enc.length < EncryptedFS.HEADER_SIZE) {
            throw new Error('Data too short');
        }

        const iv = enc.subarray(0, 12);
        const tag = enc.subarray(12, 28);
        const ciphertext = enc.subarray(28);
        const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);

        decipher.setAuthTag(tag);

        const p1 = decipher.update(ciphertext);
        const p2 = decipher.final();

        if (p2.length) {
            return Buffer.concat([p1, p2]);
        }

        return p1;
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
                    const sizeBuf = Buffer.alloc(8);
                    await fh.read(sizeBuf, 0, 8, 0);
                    const fileSize = Number(sizeBuf.readBigInt64BE(0));

                    if (pos >= fileSize) {
                        cb(0);
                        return;
                    }

                    const toReadTotal = Math.min(len, fileSize - pos);
                    let done = 0;

                    while (done < toReadTotal) {
                        const blockIndex = Math.floor((pos + done) / EncryptedFS.BLOCK_SIZE);
                        const blockOffset = (pos + done) % EncryptedFS.BLOCK_SIZE;

                        let blockStart = EncryptedFS.META_SIZE;

                        for (let i = 0; i < blockIndex; i++) {
                            const hdr = Buffer.alloc(4);
                            await fh.read(hdr, 0, 4, blockStart);
                            const ctLen = hdr.readUInt32BE(0);
                            blockStart += 4 + EncryptedFS.HEADER_SIZE + ctLen;
                        }

                        const hdr = Buffer.alloc(4);
                        const { bytesRead: hbytes } = await fh.read(hdr, 0, 4, blockStart);
                        if (hbytes !== 4) {
                            break;
                        }

                        const ctLen = hdr.readUInt32BE(0);
                        const enc = Buffer.alloc(ctLen + EncryptedFS.HEADER_SIZE);
                        await fh.read(enc, 0, enc.length, blockStart + 4);

                        const dec = await this.decryptBlock(enc);

                        const toCopy = Math.min(
                            dec.length - blockOffset,
                            toReadTotal - done
                        );

                        dec.subarray(blockOffset, blockOffset + toCopy)
                        .copy(buf, done);

                        done += toCopy;
                    }

                    cb(done);

                } catch(e) {
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
                    // fileSize lesen
                    const sizeBuf = Buffer.alloc(8);
                    await fh.read(sizeBuf, 0, 8, 0);
                    let fileSize = Number(sizeBuf.readBigInt64BE(0));

                    const endPos = pos + len;

                    if (endPos > fileSize) {
                        fileSize = endPos;
                    }

                    let bytesWritten = 0;

                    while (bytesWritten < len) {
                        const blockIndex = Math.floor((pos + bytesWritten) / EncryptedFS.BLOCK_SIZE);
                        const blockOffset = (pos + bytesWritten) % EncryptedFS.BLOCK_SIZE;

                        const toWrite = Math.min(
                            EncryptedFS.BLOCK_SIZE - blockOffset,
                            len - bytesWritten
                        );

                        let blockStart = EncryptedFS.META_SIZE;

                        for (let i = 0; i < blockIndex; i++) {
                            const hdr = Buffer.alloc(4);
                            await fh.read(hdr, 0, 4, blockStart);
                            const ctLen = hdr.readUInt32BE(0);
                            blockStart += 4 + EncryptedFS.HEADER_SIZE + ctLen;
                        }

                        const hdr = Buffer.alloc(4);
                        const { bytesRead: hbytes } = await fh.read(hdr, 0, 4, blockStart);

                        const plain = Buffer.alloc(EncryptedFS.BLOCK_SIZE, 0);

                        if (hbytes === 4) {
                            const ctLen = hdr.readUInt32BE(0);
                            const enc = Buffer.alloc(ctLen + EncryptedFS.HEADER_SIZE);
                            await fh.read(enc, 0, enc.length, blockStart + 4);
                            const dec = await this.decryptBlock(enc);
                            dec.copy(plain, 0);
                        }

                        buf.subarray(bytesWritten, bytesWritten + toWrite).copy(plain, blockOffset);

                        const enc = await this.encryptBlock(
                            plain.subarray(0, Math.max(blockOffset + toWrite))
                        );

                        const lenBuf = Buffer.alloc(4);
                        lenBuf.writeUInt32BE(enc.length - EncryptedFS.HEADER_SIZE);

                        await fh.write(lenBuf, 0, 4, blockStart);
                        await fh.write(enc, 0, enc.length, blockStart + 4);

                        bytesWritten += toWrite;
                    }

                    sizeBuf.writeBigInt64BE(BigInt(fileSize));
                    await fh.write(sizeBuf, 0, 8, 0);

                    cb(len);

                } catch(e) {
                    console.error('WRITE ERROR', e);
                    cb(0);
                }
            },

            create: async(p, mode, cb): Promise<void> => {
                try {
                    const fullPath = this.mapPath(p);
                    const fh = await fs.open(fullPath, 'w+');

                    const sizeBuf = Buffer.alloc(8);
                    sizeBuf.writeBigInt64BE(0n);
                    await fh.write(sizeBuf, 0, 8, 0);

                    const handle = this._nextHandle++;
                    this._handleCache.set(handle, fh);

                    cb(0, handle);
                } catch(e) {
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