import {strict as assert} from 'node:assert';
import {describe, it} from 'node:test';
import {CryptKey} from '../../src/Key/CryptKey.js';

describe('CryptKey', () => {

    describe('generate', () => {
        it('returns a hex string of default length 32 bytes (64 chars)', () => {
            const key = CryptKey.generate();

            assert.equal(typeof key, 'string');
            assert.equal(key.length, 64);
            assert.match(key, /^[0-9a-f]+$/u);
        });

        it('honors the requested byte length', () => {
            const key = CryptKey.generate(16);

            assert.equal(key.length, 32);
            assert.match(key, /^[0-9a-f]+$/u);
        });

        it('produces different keys on subsequent calls', () => {
            const a = CryptKey.generate();
            const b = CryptKey.generate();

            assert.notEqual(a, b);
        });
    });

    describe('hexStrToBuffer', () => {
        it('returns a 32-byte sha256 buffer', () => {
            const buf = CryptKey.hexStrToBuffer('00ff');

            assert.ok(Buffer.isBuffer(buf));
            assert.equal(buf.length, 32);
        });

        it('is deterministic for the same input', () => {
            const a = CryptKey.hexStrToBuffer('deadbeef');
            const b = CryptKey.hexStrToBuffer('deadbeef');

            assert.deepEqual(a, b);
        });

        it('produces distinct buffers for distinct inputs', () => {
            const a = CryptKey.hexStrToBuffer('aa');
            const b = CryptKey.hexStrToBuffer('bb');

            assert.notDeepEqual(a, b);
        });
    });

});