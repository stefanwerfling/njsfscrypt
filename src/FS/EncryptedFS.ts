import * as crypto from 'crypto';
import * as fs from 'fs';
import {Readable, Writable} from 'node:stream';
import {promisify} from 'node:util';
import * as path from 'path';
import * as fuse from 'node-fuse-bindings';
import {pipeline} from 'stream';

const pipe = promisify(pipeline);

/**
 * EncryptedFS
 */
export class EncryptedFS {

    public static BLOCK_SIZE = 128 * 1024 * 1024;

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

    public constructor(storagePath: string, mountPath: string, key?: Buffer) {
        this.storagePath = storagePath;
        this.mountPath = mountPath;
        // AES-256
        this.key = key ?? crypto.randomBytes(32);
    }

    private async encryptBlockStream(data: Buffer): Promise<Buffer> {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);

        const input = Readable.from(data);
        const chunks: Buffer[] = [];
        const output = new Writable({
            write: (chunk, _, cb): void => {
                chunks.push(Buffer.from(chunk));
                cb();
            }
        });

        await pipe(input, cipher, output);
        const encrypted = Buffer.concat(chunks);
        const tag = cipher.getAuthTag();
        return Buffer.concat([iv, tag, encrypted]);
    }

    private async decryptBlockStream(data: Buffer): Promise<Buffer> {
        if (data.length < 28) {
            throw new Error('Data too short');
        }

        const iv = data.subarray(0,12);
        const tag = data.subarray(12,28);
        const encrypted = data.subarray(28);
        const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
        decipher.setAuthTag(tag);

        const input = Readable.from(encrypted);
        const chunks: Buffer[] = [];
        const output = new Writable({
            write: (chunk, _, cb): void => {
                chunks.push(Buffer.from(chunk));
                cb();
            }
        });

        await pipe(input, decipher, output);
        return Buffer.concat(chunks);
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
        fuse.mount(this.mountPath, {
            // eslint-disable-next-line consistent-return
            readdir: (p, cb) => {
                const fullPath = path.join(this.storagePath, p);

                if (!fs.existsSync(fullPath)) {
                    return cb(-2, []);
                }

                const files = fs.readdirSync(fullPath).map(fn => {
                    try {
                        return this.decodeName(fn);
                    } catch {
                        return '???';
                    }
                });

                cb(0, files);
            },

            getattr: (p, cb) => {
                const fullPath = this.mapPath(p);

                if (p === '/') {
                    return cb(0, {
                        mtime: new Date(),
                        atime: new Date(),
                        ctime: new Date(),
                        size: 4096,
                        mode: 0o040755,
                        uid: process.getuid?.() ?? 0,
                        gid: process.getgid?.() ?? 0
                    } as any);
                }

                if (!fs.existsSync(fullPath)) {
                    return cb(-2);
                }

                const stat = fs.statSync(fullPath);

                return cb(0, {
                    mtime: stat.mtime,
                    atime: stat.atime,
                    ctime: stat.ctime,
                    size: stat.size,
                    mode: 0o100644,
                    uid: stat.uid,
                    gid: stat.gid
                } as any);
            },

            open: (p, flags, cb) => cb(0, 42),

            // eslint-disable-next-line consistent-return
            read: async(p, fd, buf, len, pos, cb) => {
                const fullPath = this.mapPath(p);

                if (!fs.existsSync(fullPath)) {
                    return cb(0);
                }

                const fdStorage = fs.openSync(fullPath, 'r');
                const result = Buffer.alloc(len);
                let bytesRead = 0;
                let blockIndex = Math.floor(pos / EncryptedFS.BLOCK_SIZE);
                let blockOffset = pos % EncryptedFS.BLOCK_SIZE;

                while (bytesRead < len) {
                    const blockPos = blockIndex * (EncryptedFS.BLOCK_SIZE + 28);
                    const toRead = Math.min(EncryptedFS.BLOCK_SIZE, len - bytesRead);
                    const rawBlock = Buffer.alloc(EncryptedFS.BLOCK_SIZE + 28);
                    const n = fs.readSync(fdStorage, rawBlock, 0, rawBlock.length, blockPos);

                    if (n === 0) {
                        break;
                    }

                    const decrypted = await this.decryptBlockStream(rawBlock.subarray(0, n));
                    const slice = decrypted.subarray(blockOffset, blockOffset + toRead);
                    slice.copy(result, bytesRead);

                    bytesRead += slice.length;
                    blockIndex++;
                    blockOffset = 0;
                }

                fs.closeSync(fdStorage);
                result.copy(buf, 0);
                cb(bytesRead);
            },

            write: async(p, fd, buf, len, pos, cb) => {
                const fullPath = this.mapPath(p);
                const fdStorage = fs.openSync(fullPath, 'r+');

                let bytesWritten = 0;
                let blockIndex = Math.floor(pos / EncryptedFS.BLOCK_SIZE);
                let blockOffset = pos % EncryptedFS.BLOCK_SIZE;

                while (bytesWritten < len) {
                    const blockPos = blockIndex * (EncryptedFS.BLOCK_SIZE + 28);
                    const toWrite = Math.min(EncryptedFS.BLOCK_SIZE - blockOffset, len - bytesWritten);
                    const rawBlock = Buffer.alloc(EncryptedFS.BLOCK_SIZE + 28);

                    let decrypted: Buffer = Buffer.alloc(EncryptedFS.BLOCK_SIZE);

                    try {
                        const n = fs.readSync(fdStorage, rawBlock, 0, rawBlock.length, blockPos);
                        if (n > 0) {
                            decrypted = await this.decryptBlockStream(rawBlock.subarray(0, n));
                        }
                    } catch {
                        console.log(`Error write ${fullPath}`);
                    }

                    buf.subarray(bytesWritten, bytesWritten + toWrite).copy(decrypted, blockOffset);
                    const encryptedBlock = await this.encryptBlockStream(decrypted);

                    fs.writeSync(fdStorage, encryptedBlock, 0, encryptedBlock.length, blockPos);
                    bytesWritten += toWrite;
                    blockIndex++;
                    blockOffset = 0;
                }

                fs.closeSync(fdStorage);
                cb(len);
            },

            create: (p, mode, cb) => {
                const fullPath = this.mapPath(p);

                this.encryptBlockStream(Buffer.alloc(0)).then(enc => fs.writeFileSync(fullPath, enc));

                cb(0);
            },

            unlink: (p, cb) => {
                const fullPath = this.mapPath(p);

                try {
                    fs.unlinkSync(fullPath);
                } catch {
                    console.log(`Error unlink ${fullPath}`);
                }

                cb(0);
            },

            mkdir: (p, mode, cb) => {
                const fullPath = this.mapPath(p);

                try {
                    fs.mkdirSync(fullPath, { mode: mode });
                } catch {
                    console.log(`Error mkdir ${fullPath}`);
                }

                cb(0);
            },

            rmdir: (p, cb) => {
                const fullPath = this.mapPath(p);

                try {
                    fs.rmdirSync(fullPath);
                } catch {
                    console.log(`Error rmdir ${fullPath}`);
                }

                cb(0);
            },

            rename: (src, dest, cb) => {
                const fullSrc = this.mapPath(src);
                const fullDest = this.mapPath(dest);

                try {
                    fs.renameSync(fullSrc, fullDest);
                } catch {
                    console.log(`Error rename ${fullSrc} -> ${fullDest}`);
                }

                cb(0);
            }

        }, (err?: number) => {
            if (err) {
                console.error('Mount failed:', err);
            } else {
                console.log('Mounted', this.mountPath);
            }
        });

        process.on('SIGINT', () => this.unmount());
    }

    public unmount(): void {
        fuse.unmount(this.mountPath, (err?: number) => {
            if (err) {
                console.error('Unmount failed:', err);
            } else {
                console.log('Unmounted', this.mountPath);
            }

            process.exit(0);
        });
    }

}