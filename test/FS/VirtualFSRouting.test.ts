import {strict as assert} from 'node:assert';
import {describe, it} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Stats} from 'node:fs';
import Fuse, {type StatFs} from 'fuse-native';
import {VirtualFS} from '../../src/FS/VirtualFS.js';
import type {VirtualFSEntry} from '../../src/FS/VirtualFSEntry.js';

/**
 * Records the path argument every entry method received.
 * Returns benign defaults so the wrappers don't error out.
 */
class RecordingEntry implements VirtualFSEntry {

    public calls: {op: string; path: string; extra?: unknown}[] = [];

    public async init(): Promise<void> {
        // no-op
    }

    public isInit(): boolean {
        return true;
    }

    public async readdir(path: string): Promise<string[]> {
        this.calls.push({op: 'readdir', path});
        return [];
    }

    public async getattr(path: string): Promise<Stats> {
        this.calls.push({op: 'getattr', path});
        return {size: 0, mode: 0o644, mtime: new Date(), atime: new Date(), ctime: new Date()} as Stats;
    }

    public async setattr(path: string, attr: Partial<Stats>): Promise<void> {
        this.calls.push({op: 'setattr', path, extra: attr});
    }

    public async open(path: string, flags: number): Promise<number> {
        this.calls.push({op: 'open', path, extra: flags});
        return 1;
    }

    public async read(path: string): Promise<Buffer> {
        this.calls.push({op: 'read', path});
        return Buffer.alloc(0);
    }

    public async write(path: string): Promise<number> {
        this.calls.push({op: 'write', path});
        return 0;
    }

    public async release(path: string, fd: number): Promise<void> {
        this.calls.push({op: 'release', path, extra: fd});
    }

    public async create(path: string, mode: number): Promise<number> {
        this.calls.push({op: 'create', path, extra: mode});
        return 1;
    }

    public async unlink(path: string): Promise<void> {
        this.calls.push({op: 'unlink', path});
    }

    public async mkdir(path: string, mode: number): Promise<void> {
        this.calls.push({op: 'mkdir', path, extra: mode});
    }

    public async rmdir(path: string): Promise<void> {
        this.calls.push({op: 'rmdir', path});
    }

    public async rename(src: string, dest: string): Promise<void> {
        this.calls.push({op: 'rename', path: src, extra: dest});
    }

    public async truncate(path: string, size: number): Promise<void> {
        this.calls.push({op: 'truncate', path, extra: size});
    }

    public async ftruncate(path: string, fd: number, size: number): Promise<void> {
        this.calls.push({op: 'ftruncate', path, extra: {fd, size}});
    }

    public async access(path: string, mode: number): Promise<void> {
        this.calls.push({op: 'access', path, extra: mode});
    }

    public async statfs(path: string): Promise<StatFs> {
        this.calls.push({op: 'statfs', path});
        return {
            bsize: 4096, frsize: 4096, blocks: 0, bfree: 0, bavail: 0,
            files: 0, ffree: 0, favail: 0, fsid: 0, flag: 0, namemax: 255
        };
    }

    public async flush(path: string, fd: number): Promise<void> {
        this.calls.push({op: 'flush', path, extra: fd});
    }

    public async fsync(path: string, fd: number, datasync: boolean): Promise<void> {
        this.calls.push({op: 'fsync', path, extra: {fd, datasync}});
    }

    public async symlink(target: string, linkPath: string): Promise<void> {
        this.calls.push({op: 'symlink', path: linkPath, extra: target});
    }

    public async readlink(path: string): Promise<string> {
        this.calls.push({op: 'readlink', path});
        return '/the-target';
    }

    public async link(src: string, dest: string): Promise<void> {
        this.calls.push({op: 'link', path: src, extra: dest});
    }

    public async mknod(path: string, mode: number, dev: number): Promise<void> {
        this.calls.push({op: 'mknod', path, extra: {mode, dev}});
    }

}

/**
 * Test subclass that exposes the otherwise protected pieces and lets us drive
 * the wrappers without spinning up a real FUSE mount.
 */
class TestVirtualFS extends VirtualFS {

    public resolve(path: string) {
        return this._resolve(path);
    }

    public callSetattr(path: string, attr: Partial<Stats>): Promise<number | null> {
        return new Promise((res) => {
            void this._setattr(path, attr, (err) => res(err));
        });
    }

    public callTruncate(path: string, size: number): Promise<number | null> {
        return new Promise((res) => {
            void this._truncate(path, size, (err) => res(err));
        });
    }

    public callFtruncate(path: string, fd: number, size: number): Promise<number | null> {
        return new Promise((res) => {
            void this._ftruncate(path, fd, size, (err) => res(err));
        });
    }

    public callAccess(path: string, mode: number): Promise<number | null> {
        return new Promise((res) => {
            void this._access(path, mode, (err) => res(err));
        });
    }

    public callChmod(path: string, mode: number): Promise<number | null> {
        return new Promise((res) => {
            void this._chmod(path, mode, (err) => res(err));
        });
    }

    public callChown(path: string, uid: number, gid: number): Promise<number | null> {
        return new Promise((res) => {
            void this._chown(path, uid, gid, (err) => res(err));
        });
    }

    public callUtimens(path: string, atime: number, mtime: number): Promise<number | null> {
        return new Promise((res) => {
            void this._utimens(path, atime, mtime, (err) => res(err));
        });
    }

    public callRename(src: string, dest: string): Promise<number | null> {
        return new Promise((res) => {
            void this._rename(src, dest, (err) => res(err));
        });
    }

    public callCreate(path: string, mode: number): Promise<{err: number | null; fd?: number}> {
        return new Promise((res) => {
            void this._create(path, mode, (err, fd) => res({err, fd}));
        });
    }

    public callFlush(path: string, fd: number): Promise<number | null> {
        return new Promise((res) => {
            void this._flush(path, fd, (err) => res(err));
        });
    }

    public callFsync(path: string, datasync: boolean, fd: number): Promise<number | null> {
        return new Promise((res) => {
            void this._fsync(path, datasync, fd, (err) => res(err));
        });
    }

    public callMkdir(path: string, mode: number): Promise<number | null> {
        return new Promise((res) => {
            void (this as unknown as {_mkdir: (p: string, m: number, cb: (err: number | null) => void) => Promise<void>})
                ._mkdir(path, mode, (err) => res(err));
        });
    }

    public callUnlink(path: string): Promise<number | null> {
        return new Promise((res) => {
            void (this as unknown as {_unlink: (p: string, cb: (err: number | null) => void) => Promise<void>})
                ._unlink(path, (err) => res(err));
        });
    }

    public callSymlink(target: string, linkPath: string): Promise<number | null> {
        return new Promise((res) => {
            void this._symlink(target, linkPath, (err) => res(err));
        });
    }

    public callReadlink(path: string): Promise<{err: number | null; target?: string}> {
        return new Promise((res) => {
            void this._readlink(path, (err, target) => res({err, target}));
        });
    }

    public callLink(src: string, dest: string): Promise<number | null> {
        return new Promise((res) => {
            void this._link(src, dest, (err) => res(err));
        });
    }

    public callMknod(path: string, mode: number, dev: number): Promise<number | null> {
        return new Promise((res) => {
            void this._mknod(path, mode, dev, (err) => res(err));
        });
    }

    public callGetxattr(path: string): Promise<number | null> {
        return new Promise((res) => {
            void (this as unknown as {
                _getxattr: (p: string, n: string, pos: number, cb: (err: number | null) => void) => void
            })._getxattr(path, 'user.x', 0, (err) => res(err));
        });
    }

    public callSetxattr(path: string): Promise<number | null> {
        return new Promise((res) => {
            void (this as unknown as {
                _setxattr: (p: string, n: string, v: Buffer, pos: number, f: number, cb: (err: number | null) => void) => void
            })._setxattr(path, 'user.x', Buffer.alloc(0), 0, 0, (err) => res(err));
        });
    }

    public callListxattr(path: string): Promise<number | null> {
        return new Promise((res) => {
            void (this as unknown as {_listxattr: (p: string, cb: (err: number | null) => void) => void})
                ._listxattr(path, (err) => res(err));
        });
    }

    public callRemovexattr(path: string): Promise<number | null> {
        return new Promise((res) => {
            void (this as unknown as {_removexattr: (p: string, n: string, cb: (err: number | null) => void) => void})
                ._removexattr(path, 'user.x', (err) => res(err));
        });
    }

    public callInit(): Promise<number | null> {
        return new Promise((res) => {
            void (this as unknown as {_init: (cb: (err: number | null) => void) => void})
                ._init((err) => res(err));
        });
    }

    public callError(): Promise<number | null> {
        return new Promise((res) => {
            void (this as unknown as {_error: (cb: (err: number | null) => void) => void})
                ._error((err) => res(err));
        });
    }

}

async function freshMountPoint(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'vfs-routing-'));
}

describe('VirtualFS routing', () => {

    describe('_resolve', () => {

        it('strips the sub-mount prefix from the relPath', async () => {
            const mountPath = await freshMountPoint();
            try {
                const vfs = new TestVirtualFS(mountPath);
                const entry = new RecordingEntry();
                await vfs.register('/crypt', entry);

                const r = vfs.resolve('/crypt/foo/bar.txt');

                assert.equal(r.fs, entry);
                assert.equal(r.relPath, '/foo/bar.txt');
            } finally {
                await rm(mountPath, {recursive: true, force: true});
            }
        });

        it('keeps the full path when the root entry matches', async () => {
            const mountPath = await freshMountPoint();
            try {
                const vfs = new TestVirtualFS(mountPath);
                const entry = new RecordingEntry();
                await vfs.register('/', entry);

                const r = vfs.resolve('/foo.txt');

                assert.equal(r.fs, entry);
                assert.equal(r.relPath, '/foo.txt');
            } finally {
                await rm(mountPath, {recursive: true, force: true});
            }
        });

        it('prefers the longest matching pattern (sub-mount wins over /)', async () => {
            const mountPath = await freshMountPoint();
            try {
                const vfs = new TestVirtualFS(mountPath);
                const root = new RecordingEntry();
                const sub = new RecordingEntry();
                await vfs.register('/', root);
                await vfs.register('/crypt', sub);

                const r = vfs.resolve('/crypt/x');

                assert.equal(r.fs, sub);
                assert.equal(r.relPath, '/x');
            } finally {
                await rm(mountPath, {recursive: true, force: true});
            }
        });

    });

    describe('wrappers pass relPath (not the full mount path) to the entry', () => {

        it('_setattr forwards the resolved relPath', async () => {
            const mountPath = await freshMountPoint();
            try {
                const vfs = new TestVirtualFS(mountPath);
                const entry = new RecordingEntry();
                await vfs.register('/crypt', entry);

                await vfs.callSetattr('/crypt/foo.txt', {mode: 0o600});

                const call = entry.calls.find((c) => c.op === 'setattr');
                assert.ok(call, 'setattr was not called');
                assert.equal(call!.path, '/foo.txt');
            } finally {
                await rm(mountPath, {recursive: true, force: true});
            }
        });

        it('_truncate forwards the resolved relPath', async () => {
            const mountPath = await freshMountPoint();
            try {
                const vfs = new TestVirtualFS(mountPath);
                const entry = new RecordingEntry();
                await vfs.register('/crypt', entry);

                await vfs.callTruncate('/crypt/foo.txt', 42);

                const call = entry.calls.find((c) => c.op === 'truncate');
                assert.ok(call, 'truncate was not called');
                assert.equal(call!.path, '/foo.txt');
                assert.equal(call!.extra, 42);
            } finally {
                await rm(mountPath, {recursive: true, force: true});
            }
        });

        it('_ftruncate forwards the resolved relPath', async () => {
            const mountPath = await freshMountPoint();
            try {
                const vfs = new TestVirtualFS(mountPath);
                const entry = new RecordingEntry();
                await vfs.register('/crypt', entry);

                await vfs.callFtruncate('/crypt/foo.txt', 7, 13);

                const call = entry.calls.find((c) => c.op === 'ftruncate');
                assert.ok(call, 'ftruncate was not called');
                assert.equal(call!.path, '/foo.txt');
            } finally {
                await rm(mountPath, {recursive: true, force: true});
            }
        });

        it('_access forwards the resolved relPath', async () => {
            const mountPath = await freshMountPoint();
            try {
                const vfs = new TestVirtualFS(mountPath);
                const entry = new RecordingEntry();
                await vfs.register('/crypt', entry);

                await vfs.callAccess('/crypt/foo.txt', 4);

                const call = entry.calls.find((c) => c.op === 'access');
                assert.ok(call, 'access was not called');
                assert.equal(call!.path, '/foo.txt');
            } finally {
                await rm(mountPath, {recursive: true, force: true});
            }
        });

    });

    describe('flush / fsync forward the resolved relPath', () => {

        it('_flush forwards the resolved relPath and fd', async () => {
            const mountPath = await freshMountPoint();
            try {
                const vfs = new TestVirtualFS(mountPath);
                const entry = new RecordingEntry();
                await vfs.register('/crypt', entry);

                const err = await vfs.callFlush('/crypt/foo.txt', 7);

                assert.equal(err, 0);
                const call = entry.calls.find((c) => c.op === 'flush');
                assert.ok(call);
                assert.equal(call!.path, '/foo.txt');
                assert.equal(call!.extra, 7);
            } finally {
                await rm(mountPath, {recursive: true, force: true});
            }
        });

        it('_fsync forwards relPath, fd and datasync flag', async () => {
            const mountPath = await freshMountPoint();
            try {
                const vfs = new TestVirtualFS(mountPath);
                const entry = new RecordingEntry();
                await vfs.register('/crypt', entry);

                const err = await vfs.callFsync('/crypt/foo.txt', true, 9);

                assert.equal(err, 0);
                const call = entry.calls.find((c) => c.op === 'fsync');
                assert.ok(call);
                assert.equal(call!.path, '/foo.txt');
                assert.deepEqual(call!.extra, {fd: 9, datasync: true});
            } finally {
                await rm(mountPath, {recursive: true, force: true});
            }
        });

    });

    describe('chmod / chown / utimens delegate to setattr on the entry', () => {

        it('_chmod calls entry.setattr with {mode} and the resolved path', async () => {
            const mountPath = await freshMountPoint();
            try {
                const vfs = new TestVirtualFS(mountPath);
                const entry = new RecordingEntry();
                await vfs.register('/crypt', entry);

                await vfs.callChmod('/crypt/foo.txt', 0o600);

                const call = entry.calls.find((c) => c.op === 'setattr');
                assert.ok(call, 'setattr was not called');
                assert.equal(call!.path, '/foo.txt');
                assert.deepEqual(call!.extra, {mode: 0o600});
            } finally {
                await rm(mountPath, {recursive: true, force: true});
            }
        });

        it('_chown calls entry.setattr with {uid, gid} and the resolved path', async () => {
            const mountPath = await freshMountPoint();
            try {
                const vfs = new TestVirtualFS(mountPath);
                const entry = new RecordingEntry();
                await vfs.register('/crypt', entry);

                await vfs.callChown('/crypt/foo.txt', 1000, 1000);

                const call = entry.calls.find((c) => c.op === 'setattr');
                assert.ok(call, 'setattr was not called');
                assert.equal(call!.path, '/foo.txt');
                assert.deepEqual(call!.extra, {uid: 1000, gid: 1000});
            } finally {
                await rm(mountPath, {recursive: true, force: true});
            }
        });

        it('_rename within the same mount forwards both relPaths', async () => {
            const mountPath = await freshMountPoint();
            try {
                const vfs = new TestVirtualFS(mountPath);
                const entry = new RecordingEntry();
                await vfs.register('/crypt', entry);

                const err = await vfs.callRename('/crypt/a.txt', '/crypt/b.txt');

                assert.equal(err, 0);
                const call = entry.calls.find((c) => c.op === 'rename');
                assert.ok(call, 'rename was not called');
                assert.equal(call!.path, '/a.txt');
                assert.equal(call!.extra, '/b.txt');
            } finally {
                await rm(mountPath, {recursive: true, force: true});
            }
        });

        it('_rename re-keys stats from src path to dest path', async () => {
            const mountPath = await freshMountPoint();
            try {
                const vfs = new TestVirtualFS(mountPath);
                const entry = new RecordingEntry();
                await vfs.register('/', entry);

                const {fd} = await vfs.callCreate('/old.txt', 0o644);
                assert.equal(typeof fd, 'number');

                const oldKey = `/old.txt:${fd}`;
                assert.ok(vfs.getStats().has(oldKey), 'stats missing under src key');

                const err = await vfs.callRename('/old.txt', '/new.txt');
                assert.equal(err, 0);

                const stats = vfs.getStats();
                assert.ok(!stats.has(oldKey), 'stale stats under src key');
                assert.ok(stats.has(`/new.txt:${fd}`), 'stats missing under dest key');
            } finally {
                await rm(mountPath, {recursive: true, force: true});
            }
        });

        it('_create initializes a stats entry for the new fd', async () => {
            const mountPath = await freshMountPoint();
            try {
                const vfs = new TestVirtualFS(mountPath);
                const entry = new RecordingEntry();
                await vfs.register('/crypt', entry);

                const {err, fd} = await vfs.callCreate('/crypt/new.txt', 0o644);
                assert.equal(err, 0);
                assert.equal(typeof fd, 'number');

                const stats = vfs.getStats();
                assert.ok(stats.has(`/crypt/new.txt:${fd}`), 'stats entry missing for created fd');
            } finally {
                await rm(mountPath, {recursive: true, force: true});
            }
        });

        it('_rename across different mounts is rejected with EXDEV', async () => {
            const mountPath = await freshMountPoint();
            try {
                const vfs = new TestVirtualFS(mountPath);
                const root = new RecordingEntry();
                const sub = new RecordingEntry();
                await vfs.register('/', root);
                await vfs.register('/crypt', sub);

                const err = await vfs.callRename('/foo.txt', '/crypt/foo.txt');

                assert.equal(err, Fuse.EXDEV);
                assert.ok(!root.calls.some((c) => c.op === 'rename'));
                assert.ok(!sub.calls.some((c) => c.op === 'rename'));
            } finally {
                await rm(mountPath, {recursive: true, force: true});
            }
        });

        it('_utimens calls entry.setattr with Date(atime)/Date(mtime) and the resolved path', async () => {
            const mountPath = await freshMountPoint();
            try {
                const vfs = new TestVirtualFS(mountPath);
                const entry = new RecordingEntry();
                await vfs.register('/crypt', entry);

                const aMs = 1700000000000;
                const mMs = 1700000111000;

                await vfs.callUtimens('/crypt/foo.txt', aMs, mMs);

                const call = entry.calls.find((c) => c.op === 'setattr');
                assert.ok(call, 'setattr was not called');
                assert.equal(call!.path, '/foo.txt');
                const extra = call!.extra as {atime: Date; mtime: Date};
                assert.ok(extra.atime instanceof Date);
                assert.ok(extra.mtime instanceof Date);
                assert.equal(extra.atime.getTime(), aMs);
                assert.equal(extra.mtime.getTime(), mMs);
            } finally {
                await rm(mountPath, {recursive: true, force: true});
            }
        });

    });

    describe('symlink / readlink / link / mknod routing', () => {

        it('_symlink forwards target verbatim and resolves linkPath', async () => {
            const mountPath = await freshMountPoint();
            try {
                const vfs = new TestVirtualFS(mountPath);
                const entry = new RecordingEntry();
                await vfs.register('/crypt', entry);

                const err = await vfs.callSymlink('/some/target', '/crypt/the-link');

                assert.equal(err, 0);
                const call = entry.calls.find((c) => c.op === 'symlink');
                assert.ok(call);
                assert.equal(call!.path, '/the-link');
                assert.equal(call!.extra, '/some/target');
            } finally {
                await rm(mountPath, {recursive: true, force: true});
            }
        });

        it('_readlink returns the entry-provided target', async () => {
            const mountPath = await freshMountPoint();
            try {
                const vfs = new TestVirtualFS(mountPath);
                const entry = new RecordingEntry();
                await vfs.register('/crypt', entry);

                const {err, target} = await vfs.callReadlink('/crypt/the-link');
                assert.equal(err, 0);
                assert.equal(target, '/the-target');

                const call = entry.calls.find((c) => c.op === 'readlink');
                assert.ok(call);
                assert.equal(call!.path, '/the-link');
            } finally {
                await rm(mountPath, {recursive: true, force: true});
            }
        });

        it('_link within the same mount forwards both relPaths', async () => {
            const mountPath = await freshMountPoint();
            try {
                const vfs = new TestVirtualFS(mountPath);
                const entry = new RecordingEntry();
                await vfs.register('/crypt', entry);

                const err = await vfs.callLink('/crypt/a.txt', '/crypt/b.txt');
                assert.equal(err, 0);

                const call = entry.calls.find((c) => c.op === 'link');
                assert.ok(call);
                assert.equal(call!.path, '/a.txt');
                assert.equal(call!.extra, '/b.txt');
            } finally {
                await rm(mountPath, {recursive: true, force: true});
            }
        });

        it('_link across mounts is rejected with EXDEV', async () => {
            const mountPath = await freshMountPoint();
            try {
                const vfs = new TestVirtualFS(mountPath);
                const root = new RecordingEntry();
                const sub = new RecordingEntry();
                await vfs.register('/', root);
                await vfs.register('/crypt', sub);

                const err = await vfs.callLink('/foo.txt', '/crypt/foo.txt');
                assert.equal(err, Fuse.EXDEV);
            } finally {
                await rm(mountPath, {recursive: true, force: true});
            }
        });

        it('_mknod forwards mode and dev and resolves the path', async () => {
            const mountPath = await freshMountPoint();
            try {
                const vfs = new TestVirtualFS(mountPath);
                const entry = new RecordingEntry();
                await vfs.register('/crypt', entry);

                const err = await vfs.callMknod('/crypt/n.bin', 0o644, 0);
                assert.equal(err, 0);

                const call = entry.calls.find((c) => c.op === 'mknod');
                assert.ok(call);
                assert.equal(call!.path, '/n.bin');
                assert.deepEqual(call!.extra, {mode: 0o644, dev: 0});
            } finally {
                await rm(mountPath, {recursive: true, force: true});
            }
        });

    });

    describe('lifecycle hooks', () => {

        it('_init resolves with 0 and emits a log line', async () => {
            const mountPath = await freshMountPoint();
            try {
                const vfs = new TestVirtualFS(mountPath);
                const logged: {level: number; msg: string}[] = [];
                vfs.setLogger((level, msg) => {
                    logged.push({level, msg});
                });

                const err = await vfs.callInit();
                assert.equal(err, 0);
                assert.ok(logged.some((l) => l.msg.startsWith('init:')));
            } finally {
                await rm(mountPath, {recursive: true, force: true});
            }
        });

        it('_error resolves with 0 and emits an error log', async () => {
            const mountPath = await freshMountPoint();
            try {
                const vfs = new TestVirtualFS(mountPath);
                const logged: {level: number; msg: string}[] = [];
                vfs.setLogger((level, msg) => {
                    logged.push({level, msg});
                });

                const err = await vfs.callError();
                assert.equal(err, 0);
                assert.ok(logged.some((l) => l.msg.startsWith('error:')));
            } finally {
                await rm(mountPath, {recursive: true, force: true});
            }
        });

    });

    describe('xattr stubs', () => {

        it('all four xattr ops return ENOSYS', async () => {
            const mountPath = await freshMountPoint();
            try {
                const vfs = new TestVirtualFS(mountPath);
                await vfs.register('/', new RecordingEntry());

                assert.equal(await vfs.callGetxattr('/x'), Fuse.ENOSYS);
                assert.equal(await vfs.callSetxattr('/x'), Fuse.ENOSYS);
                assert.equal(await vfs.callListxattr('/x'), Fuse.ENOSYS);
                assert.equal(await vfs.callRemovexattr('/x'), Fuse.ENOSYS);
            } finally {
                await rm(mountPath, {recursive: true, force: true});
            }
        });

    });

    describe('error translation', () => {

        it('forwards EEXIST from mkdir instead of swallowing it', async () => {
            const mountPath = await freshMountPoint();
            try {
                const vfs = new TestVirtualFS(mountPath);
                const entry = new RecordingEntry();
                entry.mkdir = async () => {
                    const e: NodeJS.ErrnoException = new Error('exists');
                    e.code = 'EEXIST';
                    throw e;
                };
                await vfs.register('/', entry);

                const err = await vfs.callMkdir('/dup', 0o755);
                assert.equal(err, Fuse.EEXIST);
            } finally {
                await rm(mountPath, {recursive: true, force: true});
            }
        });

        it('forwards EACCES from unlink instead of ENOENT', async () => {
            const mountPath = await freshMountPoint();
            try {
                const vfs = new TestVirtualFS(mountPath);
                const entry = new RecordingEntry();
                entry.unlink = async () => {
                    const e: NodeJS.ErrnoException = new Error('denied');
                    e.code = 'EACCES';
                    throw e;
                };
                await vfs.register('/', entry);

                const err = await vfs.callUnlink('/locked.txt');
                assert.equal(err, Fuse.EACCES);
            } finally {
                await rm(mountPath, {recursive: true, force: true});
            }
        });

        it('uses the carried fuse code from an ErrnoFuseCb', async () => {
            const mountPath = await freshMountPoint();
            try {
                const vfs = new TestVirtualFS(mountPath);
                const entry = new RecordingEntry();
                const {ErrnoFuseCb} = await import('../../src/Error/ErrnoFuseCb.js');
                entry.unlink = async () => {
                    throw new ErrnoFuseCb(Fuse.EROFS, 'read-only');
                };
                await vfs.register('/', entry);

                const err = await vfs.callUnlink('/anything.txt');
                assert.equal(err, Fuse.EROFS);
            } finally {
                await rm(mountPath, {recursive: true, force: true});
            }
        });

    });

});