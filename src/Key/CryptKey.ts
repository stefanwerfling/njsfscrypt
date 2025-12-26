import * as crypto from 'crypto';

/**
 * Crypt key
 */
export class CryptKey {

    /**
     * Generate
     * @param {number} bytesLen
     */
    public static generate(bytesLen: number = 32): string {
        const keybuffer = crypto.randomBytes(bytesLen);

        return keybuffer.toString('hex');
    }

    /**
     * hex str to buffer
     * @param {string} hexStr
     * @return {Buffer}
     */
    public static hexStrToBuffer(hexStr: string): Buffer {
        const originalKey = Buffer.from(hexStr, 'hex');
        return crypto.createHash('sha256').update(originalKey).digest();
    }

}