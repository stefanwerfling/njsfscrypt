import {VirtualFSEntry} from './VirtualFSEntry.js';
import * as crypto from 'crypto';
import {Stats} from 'fs';
import * as fs from 'fs/promises';
import * as tpath from 'path';

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
     * File handles
     * @protected
     */
    protected _handleCache = new Map<number, fs.FileHandle>();

    /**
     * next handle counter
     * @private
     */
    private _nextHandle = 100;

    public constructor(options: CryptFSOptions) {
        this._options = options;
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

    public async create(path: string, mode: number): Promise<number> {
        const fullPath = this._mapPath(path);
        const fh = await fs.open(fullPath, 'w+', mode);
        const buf = Buffer.alloc(CryptFS.META_SIZE);

        buf.writeBigInt64BE(0n, 0);

        const nonce = crypto.randomBytes(CryptFS.NONCE_SIZE);
        nonce.copy(buf, 8);

        await fh.write(buf, 0, buf.length, 0);

        const handle = this._nextHandle++;
        this._handleCache.set(handle, fh);

        return handle;
    }

    public async getattr(path: string): Promise<Stats> {
        const fullPath = path === '/' ? this._options.baseDir : this._mapPath(path);

        const stat = await fs.stat(fullPath);

        if (stat.isDirectory()) {
            return {
                mtime: stat.mtime,
                atime: stat.atime,
                ctime: stat.ctime,
                size: stat.size,
                mode: 0o040755,
                uid: stat.uid,
                gid: stat.gid
            } as any;
        }

        let fileSize = 0;

        if (stat.size >= CryptFS.META_SIZE) {
            const fh = await fs.open(fullPath, 'r');
            const b = Buffer.alloc(8);
            await fh.read(b, 0, 8, 0);
            await fh.close();

            fileSize = Number(b.readBigInt64BE(0));
        }

        return {
            mtime: stat.mtime,
            atime: stat.atime,
            ctime: stat.ctime,
            size: fileSize,
            mode: stat.mode,
            uid: stat.uid,
            gid: stat.gid
        } as any;
    }

    public async mkdir(path: string, mode: number): Promise<void> {
        await fs.mkdir(this._mapPath(path), {mode: mode});
    }

    public async open(path: string, flags: number): Promise<number> {
        const fullPath = this._mapPath(path);
        const fh = await fs.open(fullPath, flags);
        const id = this._nextHandle++;

        this._handleCache.set(id, fh);

        return id;
    }

    public async read(path: string, fd: number, length: number, offset: number): Promise<Buffer> {
        const fh = this._handleCache.get(fd);

        if (!fh) {
            throw new Error(`Filehandle not found: ${fd}`);
        }

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

        let done = 0;

        while (done < toReadTotal) {
            const currentPos = offset + done;

            const blockIndex = Math.floor(currentPos / this._options.blockSize);
            const blockOffset = currentPos % this._options.blockSize;

            const toRead = Math.min(
                this._options.blockSize - blockOffset,
                toReadTotal - done
            );

            const absoluteDataStart = blockIndex * this._options.blockSize;

            const counterBlockStart =
                Math.floor(absoluteDataStart / CryptFS.AES_BLOCK) * CryptFS.AES_BLOCK;

            const offsetWithinCounterBlock = currentPos - counterBlockStart;

            const cipherFilePos = CryptFS.META_SIZE + counterBlockStart;

            const cipherReadLen = Math.min(
                Math.ceil((offsetWithinCounterBlock + toRead) / CryptFS.AES_BLOCK) * CryptFS.AES_BLOCK,
                fileSize - counterBlockStart
            );

            const encBuf = Buffer.allocUnsafe(cipherReadLen);

            // eslint-disable-next-line no-await-in-loop
            const { bytesRead: bRead } = await fh.read(encBuf, 0, cipherReadLen, cipherFilePos);

            if (bRead === 0) {
                out.fill(0, done, done + toRead);
            } else {
                const blockCounter = BigInt(counterBlockStart / CryptFS.AES_BLOCK);
                const plain = this._decryptCTR(nonce, blockCounter, encBuf.subarray(0, bRead));
                const srcStart = offsetWithinCounterBlock;
                const slice = plain.subarray(srcStart, srcStart + toRead);

                slice.copy(out, done);
            }

            done += toRead;
        }

        return out;
    }

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

    public async release(path: string, fd: number): Promise<void> {
        const fh = this._handleCache.get(fd);

        if (fh) {
            await fh.close();
            this._handleCache.delete(fd);
        }
    }

    public async rename(src: string, dest: string): Promise<void> {
        const fullSrc = this._mapPath(src);
        const fullDest = this._mapPath(dest);

        return fs.rename(fullSrc, fullDest);
    }

    public async rmdir(path: string): Promise<void> {
        return fs.rmdir(this._mapPath(path));
    }

    public async unlink(path: string): Promise<void> {
        return fs.unlink(this._mapPath(path));
    }

    public async write(path: string, fd: number, buffer: Buffer, offset: number): Promise<number> {
        const fh = this._handleCache.get(fd);

        if (!fh) {
            throw new Error(`Filehandle not found ${fd}`);
        }

        const len = buffer.length;
        const stat = await fh.stat();

        if (stat.size < CryptFS.META_SIZE) {
            const nb = Buffer.alloc(CryptFS.META_SIZE);
            nb.writeBigInt64BE(0n, 0);

            const nonce = crypto.randomBytes(CryptFS.NONCE_SIZE);
            nonce.copy(nb, 8);

            await fh.write(nb, 0, nb.length, 0);
        }

        const header = Buffer.alloc(CryptFS.META_SIZE);

        await fh.read(header, 0, header.length, 0);

        let fileSize = Number(header.readBigInt64BE(0));
        const nonce = header.subarray(8, 8 + CryptFS.NONCE_SIZE);

        const endPos = offset + len;

        if (endPos > fileSize) {
            fileSize = endPos;
        }

        let bytesWritten = 0;

        while (bytesWritten < len) {
            const currentPos = offset + bytesWritten;
            const blockIndex = Math.floor(currentPos / this._options.blockSize);
            const blockOffset = currentPos % this._options.blockSize;
            const toWrite = Math.min(this._options.blockSize - blockOffset, len - bytesWritten);

            const absoluteBlockStart = blockIndex * this._options.blockSize;
            const counterBlockStart = Math.floor(absoluteBlockStart / CryptFS.AES_BLOCK) * CryptFS.AES_BLOCK;

            const cipherFilePos = CryptFS.META_SIZE + counterBlockStart;
            const needPlainBytes = blockOffset + toWrite;
            const cipherReadLen = Math.min(
                Math.ceil(needPlainBytes / CryptFS.AES_BLOCK) * CryptFS.AES_BLOCK,
                fileSize - counterBlockStart
            );

            const encBuf = Buffer.allocUnsafe(cipherReadLen);
            // eslint-disable-next-line no-await-in-loop
            const { bytesRead: bRead } = await fh.read(encBuf, 0, cipherReadLen, cipherFilePos);

            let plainBlock: Buffer;
            if (bRead > 0) {
                plainBlock = this._decryptCTR(nonce, BigInt(counterBlockStart / CryptFS.AES_BLOCK), encBuf.subarray(0, bRead));

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

            buffer.copy(plainBlock, blockOffset, bytesWritten, bytesWritten + toWrite);

            const encNew = this._encryptCTR(
                nonce,
                BigInt(counterBlockStart / CryptFS.AES_BLOCK),
                plainBlock
            );

            // eslint-disable-next-line no-await-in-loop
            await fh.write(encNew, 0, encNew.length, cipherFilePos);

            bytesWritten += toWrite;
        }

        const sizeBuf = Buffer.alloc(8);
        sizeBuf.writeBigInt64BE(BigInt(fileSize), 0);
        await fh.write(sizeBuf, 0, 8, 0);

        return bytesWritten;
    }

}