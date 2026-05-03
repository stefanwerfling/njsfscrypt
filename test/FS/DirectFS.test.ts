import {strict as assert} from 'node:assert';
import {afterEach, beforeEach, describe, it} from 'node:test';
import {mkdtemp, rm, writeFile, readdir, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {constants} from 'node:fs';
import {DirectFS} from '../../src/FS/DirectFS.js';

describe('DirectFS', () => {

    let baseDir: string;
    let fs: DirectFS;

    beforeEach(async () => {
        baseDir = await mkdtemp(join(tmpdir(), 'directfs-test-'));
        fs = new DirectFS({baseDir});
        await fs.init();
    });

    afterEach(async () => {
        await rm(baseDir, {recursive: true, force: true});
    });

    it('init fails when baseDir is not a directory', async () => {
        const filePath = join(baseDir, 'not-a-dir');
        await writeFile(filePath, '');

        const bad = new DirectFS({baseDir: filePath});

        await assert.rejects(() => bad.init(), /not a directory/u);
    });

    it('isInit returns true after init', () => {
        assert.equal(fs.isInit(), true);
    });

    it('create + write + read roundtrip', async () => {
        const fd = await fs.create('/hello.txt', 0o644);
        const payload = Buffer.from('hello world');

        const written = await fs.write('/hello.txt', fd, payload, 0);
        assert.equal(written, payload.length);

        const back = await fs.read('/hello.txt', fd, payload.length, 0);
        assert.deepEqual(back, payload);

        await fs.release('/hello.txt', fd);
    });

    it('readdir lists created entries', async () => {
        const fd = await fs.create('/listed.txt', 0o644);
        await fs.release('/listed.txt', fd);

        const names = await fs.readdir('/');
        assert.ok(names.includes('listed.txt'));
    });

    it('mkdir + readdir nested', async () => {
        await fs.mkdir('/sub', 0o755);
        const fd = await fs.create('/sub/inside.txt', 0o644);
        await fs.write('/sub/inside.txt', fd, Buffer.from('x'), 0);
        await fs.release('/sub/inside.txt', fd);

        const names = await fs.readdir('/sub');
        assert.deepEqual(names, ['inside.txt']);
    });

    it('rename moves a file', async () => {
        const fd = await fs.create('/before.txt', 0o644);
        await fs.write('/before.txt', fd, Buffer.from('a'), 0);
        await fs.release('/before.txt', fd);

        await fs.rename('/before.txt', '/after.txt');

        const dirEntries = await readdir(baseDir);
        assert.ok(dirEntries.includes('after.txt'));
        assert.ok(!dirEntries.includes('before.txt'));
    });

    it('truncate shortens a file', async () => {
        const fd = await fs.create('/trunc.txt', 0o644);
        await fs.write('/trunc.txt', fd, Buffer.from('1234567890'), 0);
        await fs.release('/trunc.txt', fd);

        await fs.truncate('/trunc.txt', 4);

        const st = await stat(join(baseDir, 'trunc.txt'));
        assert.equal(st.size, 4);
    });

    it('unlink removes a file', async () => {
        const fd = await fs.create('/del.txt', 0o644);
        await fs.release('/del.txt', fd);

        await fs.unlink('/del.txt');

        const names = await readdir(baseDir);
        assert.ok(!names.includes('del.txt'));
    });

    it('rmdir removes an empty directory', async () => {
        await fs.mkdir('/empty', 0o755);
        await fs.rmdir('/empty');

        const names = await readdir(baseDir);
        assert.ok(!names.includes('empty'));
    });

    it('getattr returns Stats with correct size', async () => {
        const fd = await fs.create('/s.txt', 0o644);
        await fs.write('/s.txt', fd, Buffer.from('abcd'), 0);
        await fs.release('/s.txt', fd);

        const st = await fs.getattr('/s.txt');
        assert.equal(st.size, 4);
    });

    it('open with read flag and read returns the existing content', async () => {
        const fd = await fs.create('/open.txt', 0o644);
        await fs.write('/open.txt', fd, Buffer.from('persistent'), 0);
        await fs.release('/open.txt', fd);

        const fd2 = await fs.open('/open.txt', constants.O_RDONLY);
        const buf = await fs.read('/open.txt', fd2, 100, 0);
        await fs.release('/open.txt', fd2);

        assert.equal(buf.toString('utf8'), 'persistent');
    });

    it('setattr({mode}) chmods the underlying file', async () => {
        const fd = await fs.create('/perm.txt', 0o644);
        await fs.release('/perm.txt', fd);

        await fs.setattr('/perm.txt', {mode: 0o600});

        // eslint-disable-next-line no-bitwise
        const st = await stat(join(baseDir, 'perm.txt'));
        // eslint-disable-next-line no-bitwise
        assert.equal(st.mode & 0o777, 0o600);
    });

    it('fsync(false) and fsync(true) succeed on an open handle', async () => {
        const fd = await fs.create('/sync.txt', 0o644);
        await fs.write('/sync.txt', fd, Buffer.from('payload'), 0);

        await fs.fsync('/sync.txt', fd, false);
        await fs.fsync('/sync.txt', fd, true);

        await fs.release('/sync.txt', fd);
    });

    it('flush is a no-op that resolves', async () => {
        const fd = await fs.create('/flush.txt', 0o644);
        await fs.flush('/flush.txt', fd);
        await fs.release('/flush.txt', fd);
    });

    it('symlink + readlink roundtrip', async () => {
        const fd = await fs.create('/target.txt', 0o644);
        await fs.write('/target.txt', fd, Buffer.from('hi'), 0);
        await fs.release('/target.txt', fd);

        await fs.symlink('/target.txt', '/the-link');

        const target = await fs.readlink('/the-link');
        assert.equal(target, '/target.txt');
    });

    it('getattr on a symlink reports a link, not the target', async () => {
        const fd = await fs.create('/file.txt', 0o644);
        await fs.release('/file.txt', fd);

        await fs.symlink('/file.txt', '/lnk');

        const st = await fs.getattr('/lnk');
        assert.ok(st.isSymbolicLink(), 'expected lstat to flag it as a symlink');
    });

    it('link creates a hard link sharing inode/size', async () => {
        const fd = await fs.create('/orig.txt', 0o644);
        await fs.write('/orig.txt', fd, Buffer.from('hardly'), 0);
        await fs.release('/orig.txt', fd);

        await fs.link('/orig.txt', '/twin.txt');

        const a = await stat(join(baseDir, 'orig.txt'));
        const b = await stat(join(baseDir, 'twin.txt'));
        assert.equal(a.ino, b.ino);
        assert.equal(b.size, 6);
    });

    it('mknod creates a regular file', async () => {
        // eslint-disable-next-line no-bitwise
        const mode = 0o644 | constants.S_IFREG;
        await fs.mknod('/node.bin', mode, 0);

        const st = await stat(join(baseDir, 'node.bin'));
        assert.ok(st.isFile());
    });

    it('mknod refuses non-regular files with ENOSYS', async () => {
        // eslint-disable-next-line no-bitwise
        const fifoMode = 0o644 | constants.S_IFIFO;
        await assert.rejects(() => fs.mknod('/fifo', fifoMode, 0), /ENOSYS|Only regular/u);
    });

    it('setattr({atime, mtime}) updates the timestamps', async () => {
        const fd = await fs.create('/touch.txt', 0o644);
        await fs.release('/touch.txt', fd);

        const target = new Date(1_700_000_000_000);
        await fs.setattr('/touch.txt', {atime: target, mtime: target});

        const st = await stat(join(baseDir, 'touch.txt'));
        assert.equal(st.mtime.getTime(), target.getTime());
        assert.equal(st.atime.getTime(), target.getTime());
    });

});