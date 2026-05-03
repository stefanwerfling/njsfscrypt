import {strict as assert} from 'node:assert';
import {afterEach, beforeEach, describe, it} from 'node:test';
import {mkdtemp, rm, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {constants} from 'node:fs';
import {CryptFS} from '../../src/FS/CryptFS.js';
import {CryptKey} from '../../src/Key/CryptKey.js';

const KEY = CryptKey.hexStrToBuffer('aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899');
const BLOCK_SIZE = 64 * 1024;

describe('CryptFS', () => {

    let baseDir: string;
    let fs: CryptFS;

    beforeEach(async () => {
        baseDir = await mkdtemp(join(tmpdir(), 'cryptfs-test-'));
        fs = new CryptFS({baseDir, encryptionKey: KEY, blockSize: BLOCK_SIZE});
        await fs.init();
    });

    afterEach(async () => {
        await rm(baseDir, {recursive: true, force: true});
    });

    it('isInit returns true after init', () => {
        assert.equal(fs.isInit(), true);
    });

    it('create + write + read small payload roundtrip', async () => {
        const fd = await fs.create('/small.txt', 0o644);
        const payload = Buffer.from('hello crypt world');

        const written = await fs.write('/small.txt', fd, payload, 0);
        assert.equal(written, payload.length);

        const back = await fs.read('/small.txt', fd, payload.length, 0);
        assert.deepEqual(back, payload);

        await fs.release('/small.txt', fd);
    });

    it('persists encrypted bytes (raw file content differs from plaintext)', async () => {
        const fd = await fs.create('/secret.txt', 0o644);
        const payload = Buffer.from('top secret message');

        await fs.write('/secret.txt', fd, payload, 0);
        await fs.release('/secret.txt', fd);

        const onDisk = await readdir(baseDir);
        assert.equal(onDisk.length, 1, 'expected exactly one encrypted entry');
        assert.notEqual(onDisk[0], 'secret.txt', 'filename must be encoded');

        const raw = await import('node:fs/promises').then(m => m.readFile(join(baseDir, onDisk[0]!)));
        assert.ok(!raw.includes(payload), 'plaintext must not appear in the encrypted file');
    });

    it('readdir decodes encoded names back to plaintext', async () => {
        const fd = await fs.create('/named.txt', 0o644);
        await fs.release('/named.txt', fd);

        const names = await fs.readdir('/');
        assert.ok(names.includes('named.txt'));
    });

    it('roundtrips a payload spanning multiple blocks', async () => {
        const fd = await fs.create('/big.bin', 0o644);

        const size = (BLOCK_SIZE * 2) + 123;
        const payload = Buffer.alloc(size);
        for (let i = 0; i < size; i++) {
            payload[i] = i & 0xff;
        }

        const written = await fs.write('/big.bin', fd, payload, 0);
        assert.equal(written, size);

        const back = await fs.read('/big.bin', fd, size, 0);
        assert.equal(back.length, size);
        assert.deepEqual(back, payload);

        await fs.release('/big.bin', fd);
    });

    it('reads from an arbitrary offset', async () => {
        const fd = await fs.create('/seek.bin', 0o644);
        const payload = Buffer.from('0123456789abcdef');

        await fs.write('/seek.bin', fd, payload, 0);

        const slice = await fs.read('/seek.bin', fd, 4, 6);
        assert.equal(slice.toString('utf8'), '6789');

        await fs.release('/seek.bin', fd);
    });

    it('survives close/reopen (header persisted)', async () => {
        const fd = await fs.create('/keep.txt', 0o644);
        const payload = Buffer.from('persisted across opens');

        await fs.write('/keep.txt', fd, payload, 0);
        await fs.release('/keep.txt', fd);

        const fd2 = await fs.open('/keep.txt', constants.O_RDWR);
        const back = await fs.read('/keep.txt', fd2, payload.length, 0);
        await fs.release('/keep.txt', fd2);

        assert.deepEqual(back, payload);
    });

    it('getattr reports the plaintext size, not the on-disk ciphertext size', async () => {
        const fd = await fs.create('/attr.bin', 0o644);
        const payload = Buffer.alloc(100, 0x42);

        await fs.write('/attr.bin', fd, payload, 0);
        await fs.release('/attr.bin', fd);

        const st = await fs.getattr('/attr.bin');
        assert.equal(st.size, 100);
    });

    it('rename keeps content readable under the new path', async () => {
        const fd = await fs.create('/from.txt', 0o644);
        await fs.write('/from.txt', fd, Buffer.from('move me'), 0);
        await fs.release('/from.txt', fd);

        await fs.rename('/from.txt', '/to.txt');

        const fd2 = await fs.open('/to.txt', constants.O_RDONLY);
        const back = await fs.read('/to.txt', fd2, 100, 0);
        await fs.release('/to.txt', fd2);

        assert.equal(back.toString('utf8'), 'move me');
    });

    it('mkdir + nested file roundtrip with encoded directory name', async () => {
        await fs.mkdir('/sub', 0o755);

        const fd = await fs.create('/sub/inner.txt', 0o644);
        await fs.write('/sub/inner.txt', fd, Buffer.from('inside'), 0);
        await fs.release('/sub/inner.txt', fd);

        const decoded = await fs.readdir('/sub');
        assert.deepEqual(decoded, ['inner.txt']);

        const fd2 = await fs.open('/sub/inner.txt', constants.O_RDONLY);
        const back = await fs.read('/sub/inner.txt', fd2, 100, 0);
        await fs.release('/sub/inner.txt', fd2);

        assert.equal(back.toString('utf8'), 'inside');
    });

    it('unlink removes the encrypted file', async () => {
        const fd = await fs.create('/gone.txt', 0o644);
        await fs.release('/gone.txt', fd);

        const before = await fs.readdir('/');
        assert.ok(before.includes('gone.txt'));

        await fs.unlink('/gone.txt');

        const after = await fs.readdir('/');
        assert.ok(!after.includes('gone.txt'));
    });

    it('rmdir refuses non-empty directories', async () => {
        await fs.mkdir('/full', 0o755);
        const fd = await fs.create('/full/child.txt', 0o644);
        await fs.release('/full/child.txt', fd);

        await assert.rejects(() => fs.rmdir('/full'));

        await fs.unlink('/full/child.txt');
        await fs.rmdir('/full');
    });

    it('truncate shrinks the reported plaintext size', async () => {
        const fd = await fs.create('/shrink.bin', 0o644);
        await fs.write('/shrink.bin', fd, Buffer.alloc(200, 0x55), 0);
        await fs.release('/shrink.bin', fd);

        await fs.truncate('/shrink.bin', 50);

        const st = await fs.getattr('/shrink.bin');
        assert.equal(st.size, 50);
    });

    it('overwrites partially without corrupting surrounding bytes', async () => {
        const fd = await fs.create('/patch.bin', 0o644);
        const original = Buffer.from('AAAAAAAAAAAAAAAA');
        await fs.write('/patch.bin', fd, original, 0);

        await fs.write('/patch.bin', fd, Buffer.from('BBBB'), 4);

        const back = await fs.read('/patch.bin', fd, original.length, 0);
        assert.equal(back.toString('utf8'), 'AAAABBBBAAAAAAAA');

        await fs.release('/patch.bin', fd);
    });

    it('symlink + readlink roundtrip: decoded target matches the original', async () => {
        const fd = await fs.create('/target.txt', 0o644);
        await fs.write('/target.txt', fd, Buffer.from('hi'), 0);
        await fs.release('/target.txt', fd);

        const original = '/some/very/long/target with spaces.txt';
        await fs.symlink(original, '/the-link');

        const readBack = await fs.readlink('/the-link');
        assert.equal(readBack, original);
    });

    it('on-disk symlink target is not readable as plaintext', async () => {
        const original = '/leak-me.txt';
        await fs.symlink(original, '/secret-link');

        const encodedEntries = await readdir(baseDir);
        const encodedLinkName = encodedEntries.find((n) => n !== 'target.txt') ?? encodedEntries[0]!;
        const onDiskTarget = (await import('node:fs/promises'))
            .readlink(join(baseDir, encodedLinkName));

        const target = (await onDiskTarget).toString();
        assert.notEqual(target, original, 'on-disk symlink target must not be plaintext');
        assert.ok(!target.includes('leak-me'), 'plaintext fragment must not appear');
    });

    it('getattr on a symlink reports a symbolic link with the target length', async () => {
        const original = '/some/target.bin';
        await fs.symlink(original, '/lnk');

        const st = await fs.getattr('/lnk');
        assert.ok(st.isSymbolicLink(), 'expected lstat-style symlink mode');
        assert.equal(st.size, original.length, 'size should be the decoded target length');
    });

    it('link creates a hard link: same encrypted inode, both readable as plaintext', async () => {
        const fd = await fs.create('/orig.txt', 0o644);
        await fs.write('/orig.txt', fd, Buffer.from('hardlink-payload'), 0);
        await fs.release('/orig.txt', fd);

        await fs.link('/orig.txt', '/twin.txt');

        const fd2 = await fs.open('/twin.txt', constants.O_RDONLY);
        const back = await fs.read('/twin.txt', fd2, 100, 0);
        await fs.release('/twin.txt', fd2);
        assert.equal(back.toString('utf8'), 'hardlink-payload');

        const encodedEntries = await readdir(baseDir);
        assert.ok(encodedEntries.length >= 2, 'expected two encoded names on disk');
    });

    it('mknod creates a regular CryptFS file (header + zero size)', async () => {
        // eslint-disable-next-line no-bitwise
        const mode = 0o644 | constants.S_IFREG;
        await fs.mknod('/n.bin', mode, 0);

        const st = await fs.getattr('/n.bin');
        assert.equal(st.size, 0);

        const fd = await fs.open('/n.bin', constants.O_RDWR);
        await fs.write('/n.bin', fd, Buffer.from('after-mknod'), 0);
        const back = await fs.read('/n.bin', fd, 100, 0);
        await fs.release('/n.bin', fd);

        assert.equal(back.toString('utf8'), 'after-mknod');
    });

    it('mknod refuses non-regular files with ENOSYS', async () => {
        // eslint-disable-next-line no-bitwise
        const fifoMode = 0o644 | constants.S_IFIFO;
        await assert.rejects(() => fs.mknod('/fifo', fifoMode, 0), /only supports regular/u);
    });

    it('uses a different on-disk encoding for the same name across instances (random nonce per file)', async () => {
        const fd1 = await fs.create('/same-name-1.txt', 0o644);
        await fs.write('/same-name-1.txt', fd1, Buffer.from('payload'), 0);
        await fs.release('/same-name-1.txt', fd1);

        const fd2 = await fs.create('/same-name-2.txt', 0o644);
        await fs.write('/same-name-2.txt', fd2, Buffer.from('payload'), 0);
        await fs.release('/same-name-2.txt', fd2);

        const fsMod = await import('node:fs/promises');
        const entries = await fsMod.readdir(baseDir);
        const buf1 = await fsMod.readFile(join(baseDir, entries[entries.length - 2]!));
        const buf2 = await fsMod.readFile(join(baseDir, entries[entries.length - 1]!));

        assert.notDeepEqual(buf1, buf2, 'identical plaintexts must not produce identical ciphertexts');
    });

});