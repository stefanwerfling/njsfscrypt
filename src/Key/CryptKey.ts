import * as crypto from 'crypto';

export class CryptKey {

    public static generate(bytesLen: number = 32): string {
        const keybuffer = crypto.randomBytes(bytesLen);

        return keybuffer.toString('hex');
    }

    public static hexStrToBuffer(hexStr: string): Buffer {
        const originalKey = Buffer.from(hexStr, 'hex');
        return crypto.createHash('sha256').update(originalKey).digest();
    }

}