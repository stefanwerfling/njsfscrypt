import {Stats} from 'fs';
import Fuse, {StatFs} from 'fuse-native';
import {ErrorUtils} from '../Utils/ErrorUtils.js';
import {VirtualFSEntry} from './VirtualFSEntry.js';

export enum VirtualFSLoggerLevel {
    error,
    info,
    warn,
    log,
    debug
}

/**
 * VirtualFS Logger
 */
export type VirtualFSLogger = (level: VirtualFSLoggerLevel, str: string, e?: unknown) => void;

/**
 * Mount-time options surfaced from the underlying fuse-native FuseOptions.
 * Only fields with safe defaults are exposed; everything else stays internal.
 */
export interface VirtualFSMountOptions {
    /**
     * If true, an existing FUSE mount at the same mountpoint is forcibly
     * unmounted before this one is established. Convenient for development,
     * dangerous on shared paths — defaults to true to preserve previous
     * behaviour but can be turned off explicitly.
     */
    force?: boolean;

    /**
     * Allow access by users other than the mounter. Required for daemons that
     * serve multiple local accounts.
     */
    allowOther?: boolean;

    /**
     * Display name for the mount (shown by `mount` / Finder etc.).
     */
    name?: string;
}

/**
 * Virtual FS Stats
 */
export type VirtualFSStats = {
    readBytes: number;
    writeBytes: number;
    readBytesDuration: number;
    writeBytesDuration: number;
    readBytesTotal: number;
    writeBytesTotal: number;
    readTimeMs: number;
    writeTimeMs: number;
    readOps: number;
    writeOps: number;
};

/**
 * Virtual FileSystem
 */
export class VirtualFS {

    /**
     * Register instances
     * @private
     */
    private _registry: {
        pattern: RegExp;
        instance: VirtualFSEntry;
    }[] = [];

    /**
     * Debuging
     * @protected
     */
    protected _debug: boolean = false;

    /**
     * Fuse object
     * @private
     */
    private readonly _fuse: Fuse;

    /**
     * Mount Path
     * @private
     */
    private readonly _mountPath: string;

    /**
     * Logger
     * @private
     */
    private _logger: VirtualFSLogger|null = null;

    /**
     * stats
     * @private
     */
    private _statsMap = new Map<string, VirtualFSStats>();

    /**
     * constructor
     * @param {string} mountPath
     * @param {boolean} debug
     * @param {VirtualFSMountOptions} mountOptions Optional mount-time tuning
     *   (force-unmount, allow-other, display name). Defaults preserve the
     *   previous hard-coded behaviour.
     */
    public constructor(
        private mountPath: string,
        debug: boolean = false,
        mountOptions: VirtualFSMountOptions = {}
    ) {
        this._mountPath = mountPath;
        this._debug = debug;

        const {force = true, allowOther = false, name} = mountOptions;

        this._fuse = new Fuse(mountPath, {
            init: this._init.bind(this),
            error: this._error.bind(this),
            readdir: this._readdir.bind(this),
            getattr: this._getattr.bind(this),
            open: this._open.bind(this),
            read: this._read.bind(this),
            write: this._write.bind(this),
            create: this._create.bind(this),
            unlink: this._unlink.bind(this),
            rmdir: this._rmdir.bind(this),
            mkdir: this._mkdir.bind(this),
            rename: this._rename.bind(this),
            release: this._release.bind(this),
            truncate: this._truncate.bind(this),
            ftruncate: this._ftruncate.bind(this),
            access: this._access.bind(this),
            statfs: this._statfs.bind(this),
            chmod: this._chmod.bind(this),
            chown: this._chown.bind(this),
            utimens: this._utimens.bind(this),
            flush: this._flush.bind(this),
            fsync: this._fsync.bind(this),
            symlink: this._symlink.bind(this),
            readlink: this._readlink.bind(this),
            link: this._link.bind(this),
            mknod: this._mknod.bind(this),
            getxattr: this._getxattr.bind(this),
            setxattr: this._setxattr.bind(this),
            listxattr: this._listxattr.bind(this),
            removexattr: this._removexattr.bind(this)
        }, {
            force: force,
            debug: debug,
            allowOther: allowOther,
            name: name
        });
    }

    /**
     * Add VirtualFS implementation to the register
     * @param {string|RegExp} pattern
     * @param {VirtualFSEntry} instance
     */
    public async register(pattern: string | RegExp, instance: VirtualFSEntry): Promise<void> {
        if (!instance.isInit()) {
            await instance.init();
        }

        const regex =
            typeof pattern === 'string'
                ? new RegExp(`^${pattern.replace(/\//gu, '\\/')}`, 'u')
                : new RegExp(pattern.source, pattern.flags.includes('u') ? pattern.flags : `${pattern.flags}u`);

        this._registry.push({
            pattern: regex,
            instance: instance
        });
    }

    /**
     * log methode
     * @param {VirtualFSLoggerLevel} level
     * @param {string} str
     * @param {unknown} e
     * @private
     */
    private _log(level: VirtualFSLoggerLevel, str: string, e?: unknown): void {
        if (this._logger) {
            if (level === VirtualFSLoggerLevel.debug) {
                if (this._debug) {
                    this._logger(level, str, e);
                }
            } else {
                this._logger(level, str, e);
            }
        }
    }

    /**
     * Set logger
     * @param {VirtualFSLogger|null} logger
     */
    public setLogger(logger: VirtualFSLogger|null): void {
        this._logger = logger;
    }

    /**
     * Return the stats map
     * @return {Map<number, VirtualFSStats>}
     */
    public getStats(): Map<string, VirtualFSStats> {
        return this._statsMap;
    }

    /**
     * Resolve by path
     * @param {string} path
     * @return {{ fs: VirtualFSEntry; relPath: string; }}
     * @private
     */
    protected _resolve(path: string): {
        fs: VirtualFSEntry;
        relPath: string;
    } {
        const sorted = this._registry.slice().sort(
            (a, b) => b.pattern.source.length - a.pattern.source.length
        );

        for (const r of sorted) {
            if (r.pattern.test(path)) {
                let relPath = path;

                if (r.pattern.source !== '^\\/$') {
                    const match = r.pattern.exec(path);

                    if (match) {
                        relPath = path.slice(match[0].length);

                        if (!relPath.startsWith('/')) {
                            relPath = `/${  relPath}`;
                        }
                    }
                }

                return {
                    fs: r.instance,
                    relPath: relPath
                };
            }
        }

        throw new Error(`No VirtualFSEntry registered for ${path}`);
    }

    /**
     * init — called once after the FUSE channel is up. Just emits a log line.
     * @param {(err: number | null) => void} cb
     */
    protected _init(cb: (err: number | null) => void): void {
        this._log(VirtualFSLoggerLevel.log, `init: ${this._mountPath}`);
        process.nextTick(cb, 0);
    }

    /**
     * error — called when fuse-native hits an internal error.
     * @param {(err: number | null) => void} cb
     */
    protected _error(cb: (err: number | null) => void): void {
        this._log(VirtualFSLoggerLevel.error, `error: ${this._mountPath}`);
        process.nextTick(cb, 0);
    }

    /**
     * readdir
     * @param {string} path
     * @param {(err: number | null, names?: string[]) => void} cb
     */
    private async _readdir(path: string, cb: (err: number | null, names?: string[]) => void): Promise<void> {
        this._log(VirtualFSLoggerLevel.debug, `_readdir call: ${path}`);

        try {
            const resolve = this._resolve(path);
            let names = await resolve.fs.readdir(resolve.relPath);

            names = ['.', '..', ...names];

            this._log(VirtualFSLoggerLevel.debug, `_readdir return: ${path}`, names);

            process.nextTick(cb, 0, names);
        } catch (err) {
            this._log(VirtualFSLoggerLevel.error, `READDIR ERROR: ${path}`, err);
            process.nextTick(cb, ErrorUtils.toFuseError(err, Fuse.ENOENT));
        }
    }

    /**
     * get attr
     * @param {string} path
     * @param {(err: number | null, stat?: Stats) => void} cb
     * @private
     */
    private async _getattr(path: string, cb: (err: number | null, stat?: Stats) => void): Promise<void> {
        this._log(VirtualFSLoggerLevel.debug, `_getattr call: ${path}`);

        try {
            const resolve = this._resolve(path);
            const stat = await resolve.fs.getattr(resolve.relPath);

            this._log(VirtualFSLoggerLevel.debug, `_getattr return: ${path}`, stat);

            process.nextTick(cb, 0, stat);
        } catch(err) {
            const code = ErrorUtils.toFuseError(err, Fuse.ENOENT);

            this._log(
                VirtualFSLoggerLevel.debug,
                `_getattr error: ${path} -> ${code}`
            );

            process.nextTick(cb, code);
        }
    }

    /**
     * Set attr bind
     * @param {string} path
     * @param {Partial<Stats>} attr
     * @param {(err: number | null) => void): Promise<void>} cb
     * @private
     */
    protected async _setattr(path: string, attr: Partial<Stats>, cb: (err: number | null) => void): Promise<void> {
        this._log(VirtualFSLoggerLevel.debug, `_setattr call: ${path}`, attr);

        try {
            const resolve = this._resolve(path);
            await resolve.fs.setattr(resolve.relPath, attr);

            process.nextTick(cb, 0);
        } catch(err) {
            const code = ErrorUtils.toFuseError(err, Fuse.ENOENT);

            this._log(
                VirtualFSLoggerLevel.debug,
                `_setattr error: ${path} -> ${code}`
            );

            process.nextTick(cb, code);
        }
    }

    /**
     * chmod (delegates to setattr({mode}))
     * @param {string} path
     * @param {number} mode
     * @param {(err: number | null) => void} cb
     */
    protected _chmod(path: string, mode: number, cb: (err: number | null) => void): Promise<void> {
        return this._setattr(path, {mode: mode} as Partial<Stats>, cb);
    }

    /**
     * chown (delegates to setattr({uid, gid}))
     * @param {string} path
     * @param {number} uid
     * @param {number} gid
     * @param {(err: number | null) => void} cb
     */
    protected _chown(path: string, uid: number, gid: number, cb: (err: number | null) => void): Promise<void> {
        return this._setattr(path, {uid: uid, gid: gid} as Partial<Stats>, cb);
    }

    /**
     * utimens (delegates to setattr({atime, mtime})). Times arrive as ms since epoch.
     * @param {string} path
     * @param {number} atime
     * @param {number} mtime
     * @param {(err: number | null) => void} cb
     */
    protected _utimens(path: string, atime: number, mtime: number, cb: (err: number | null) => void): Promise<void> {
        return this._setattr(path, {
            atime: new Date(atime),
            mtime: new Date(mtime)
        } as Partial<Stats>, cb);
    }

    /**
     * statfs
     * @param {string} path
     * @param {(err: number | null, stat?: StatFs) => void} cb
     * @private
     */
    private async _statfs(path: string, cb: (err: number | null, stat?: StatFs) => void): Promise<void> {
        this._log(VirtualFSLoggerLevel.debug, `_statfs call: ${path}`);

        try {
            const resolve = this._resolve(path);
            const statefs = await resolve.fs.statfs(path);

            process.nextTick(cb, 0, statefs);
        } catch(err) {
            const code = ErrorUtils.toFuseError(err, Fuse.ENOENT);
            this._log(VirtualFSLoggerLevel.debug, `_statfs error: ${path} -> ${code}`, err);
            process.nextTick(cb, code);
        }
    }

    /**
     * Access
     * @param {string} path
     * @param {number} mode
     * @param {(err: number | null) => void} cb
     * @private
     */
    protected async _access(path: string, mode: number, cb: (err: number | null) => void): Promise<void> {
        this._log(VirtualFSLoggerLevel.debug, `_access call: ${path}`);

        try {
            const resolve = this._resolve(path);
            await resolve.fs.access(resolve.relPath, mode);

            process.nextTick(cb, 0);
        } catch(err) {
            const code = ErrorUtils.toFuseError(err, Fuse.EACCES);
            this._log(VirtualFSLoggerLevel.debug, `_access error: ${path} -> ${code}`, err);
            process.nextTick(cb, code);
        }
    }

    /**
     * open
     * @param {string} path
     * @param {number} flags
     * @param {(code: number, fd: number) => void} cb
     */
    private async _open(path: string, flags: number, cb: (err: number | null, fd?: number) => void): Promise<void> {
        this._log(VirtualFSLoggerLevel.debug, `_open call: ${path}`);

        try {
            const resolve = this._resolve(path);
            const fd = await resolve.fs.open(resolve.relPath, flags);

            this._initStats(path, fd);

            process.nextTick(cb, 0, fd);
        } catch(err) {
            this._log(VirtualFSLoggerLevel.error, 'OPEN ERROR', err);
            process.nextTick(cb, ErrorUtils.toFuseError(err, Fuse.ENOENT));
        }
    }

    /**
     * Init zero stats for a freshly opened or created handle.
     * @param {string} path
     * @param {number} fd
     */
    private _initStats(path: string, fd: number): void {
        this._statsMap.set(`${path}:${fd}`, {
            readBytes: 0,
            writeBytes: 0,
            readBytesDuration: 0,
            writeBytesDuration: 0,
            readBytesTotal: 0,
            writeBytesTotal: 0,
            readTimeMs: 0,
            writeTimeMs: 0,
            readOps: 0,
            writeOps: 0
        });
    }

    /**
     * read
     * @param {string} path
     * @param {number} fd
     * @param {Buffer} buf
     * @param {number} len
     * @param {number} pos
     * @param {(bytesRead: number) => void} cb
     */
    private async _read(path: string, fd: number, buf: Buffer, len: number, pos: number, cb: (bytesRead: number) => void): Promise<void> {
        this._log(VirtualFSLoggerLevel.debug, `_read call: ${path}`);

        try {
            const start = performance.now();

            const resolve = this._resolve(path);
            const data = await resolve.fs.read(resolve.relPath, fd, len, pos);

            data.copy(buf, 0, 0, data.length);

            // stats ---------------------------------------------------------------------------------------------------

            const duration = performance.now() - start;
            const statsKey = `${path}:${fd}`;
            const stats = this._statsMap.get(statsKey);

            if (stats) {
                stats.readOps++;
                stats.readBytes = data.length;
                stats.readBytesDuration = duration;
                stats.readBytesTotal += data.length;
                stats.readTimeMs += duration;

                this._statsMap.set(statsKey, stats);
            }

            // ---------------------------------------------------------------------------------------------------------

            process.nextTick(cb, data.length);
        } catch(err) {
            this._log(VirtualFSLoggerLevel.error, 'READ ERROR', err);
            process.nextTick(cb, ErrorUtils.toFuseError(err, -Fuse.ENOENT));
        }
    }

    /**
     * Write
     * @param {string} path Path (unused)
     * @param {number} fd File handler id
     * @param {Buffer} buf
     * @param {number} len
     * @param {number} pos
     * @param {(written: number) => void} cb
     */
    private async _write(path: string, fd: number, buf: Buffer, len: number, pos: number, cb: (written: number) => void): Promise<void> {
        this._log(VirtualFSLoggerLevel.debug, `_write call: ${path}`);

        try {
            const start = performance.now();

            const resolve = this._resolve(path);
            const written = await resolve.fs.write(resolve.relPath, fd, buf.subarray(0, len), pos);

            // stats ---------------------------------------------------------------------------------------------------

            const duration = performance.now() - start;
            const statsKey = `${path}:${fd}`;
            const stats = this._statsMap.get(statsKey);

            if (stats) {
                stats.writeOps++;
                stats.writeBytes = written;
                stats.writeBytesTotal += written;
                stats.writeBytesDuration = duration;
                stats.writeTimeMs += duration;

                this._statsMap.set(statsKey, stats);
            }

            // ---------------------------------------------------------------------------------------------------------

            process.nextTick(cb, written);
        } catch(err) {
            this._log(VirtualFSLoggerLevel.error, 'WRITE ERROR', err);
            process.nextTick(cb, ErrorUtils.toFuseError(err, -Fuse.ENOENT));
        }
    }

    /**
     * Create
     * @param {string} path
     * @param {number} mode
     * @param {(err: number | null, fd?: number) => void} cb
     */
    protected async _create(path: string, mode: number, cb: (err: number | null, fd?: number) => void): Promise<void> {
        this._log(VirtualFSLoggerLevel.debug, `_create call: ${path}`);

        try {
            const resolve = this._resolve(path);
            const fd = await resolve.fs.create(resolve.relPath, mode);

            this._initStats(path, fd);

            process.nextTick(cb, 0, fd);
        } catch(err) {
            this._log(VirtualFSLoggerLevel.error, 'CREATE ERROR', err);
            process.nextTick(cb, ErrorUtils.toFuseError(err, Fuse.EIO));
        }
    }

    /**
     * unlink
     * @param {string} path Path to file
     * @param {(err: number | null) => void} cb
     */
    private async _unlink(path: string, cb: (err: number | null) => void): Promise<void> {
        this._log(VirtualFSLoggerLevel.debug, `_unlink call: ${path}`);

        try {
            const resolve = this._resolve(path);
            await resolve.fs.unlink(resolve.relPath);

            process.nextTick(cb, 0);
        } catch (err) {
            this._log(VirtualFSLoggerLevel.error, 'UNLINK ERROR', err);
            process.nextTick(cb, ErrorUtils.toFuseError(err, Fuse.ENOENT));
        }
    }

    /**
     * mkdir
     * @param {string} path Path to directory
     * @param {number} mode
     * @param {(err: number | null) => void} cb
     */
    private async _mkdir(path: string, mode: number, cb: (err: number | null) => void): Promise<void> {
        this._log(VirtualFSLoggerLevel.debug, `_mkdir call: ${path}`);

        try {
            const resolve = this._resolve(path);
            await resolve.fs.mkdir(resolve.relPath, mode);

            process.nextTick(cb, 0);
        } catch (err) {
            this._log(VirtualFSLoggerLevel.error, 'MKDIR ERROR', err);
            process.nextTick(cb, ErrorUtils.toFuseError(err, Fuse.EIO));
        }
    }

    /**
     * rmdir
     * @param {string} path Path to directory
     * @param {(err: number | null) => void} cb
     */
    private async _rmdir(path: string, cb: (err: number | null) => void): Promise<void> {
        this._log(VirtualFSLoggerLevel.debug, `_rmdir call: ${path}`);

        try {
            const resolve = this._resolve(path);
            await resolve.fs.rmdir(resolve.relPath);

            process.nextTick(cb, 0);
        } catch (err) {
            this._log(VirtualFSLoggerLevel.error, 'RMDIR ERROR', err);
            process.nextTick(cb, ErrorUtils.toFuseError(err, Fuse.ENOENT));
        }
    }

    /**
     * rename
     * @param {string} src
     * @param {string} dest
     * @param {(err: number | null) => void} cb
     */
    protected async _rename(src: string, dest: string, cb: (err: number | null) => void): Promise<void> {
        this._log(VirtualFSLoggerLevel.debug, `_rename call: ${src} -> ${dest}`);

        try {
            const resolveSrc = this._resolve(src);
            const resolveDest = this._resolve(dest);

            if (resolveSrc.fs !== resolveDest.fs) {
                this._log(
                    VirtualFSLoggerLevel.debug,
                    `_rename cross-mount refused: ${src} -> ${dest}`
                );
                process.nextTick(cb, Fuse.EXDEV);
                return;
            }

            await resolveSrc.fs.rename(resolveSrc.relPath, resolveDest.relPath);

            this._rekeyStatsAfterRename(src, dest);

            process.nextTick(cb, 0);
        } catch (err) {
            this._log(VirtualFSLoggerLevel.error, 'RENAME ERROR', err);
            process.nextTick(cb, ErrorUtils.toFuseError(err, Fuse.ENOENT));
        }
    }

    /**
     * Re-key any open stats entries that referenced the source path so they
     * keep tracking the same fd under the destination path.
     * @param {string} src
     * @param {string} dest
     */
    private _rekeyStatsAfterRename(src: string, dest: string): void {
        const prefix = `${src}:`;

        for (const key of [...this._statsMap.keys()]) {
            if (key.startsWith(prefix)) {
                const stats = this._statsMap.get(key)!;
                this._statsMap.delete(key);
                this._statsMap.set(`${dest}:${key.slice(prefix.length)}`, stats);
            }
        }
    }

    /**
     * symlink — link path is mounted, target is stored verbatim
     * (it's just a string, not an FS path the kernel walks for us here).
     * @param {string} target
     * @param {string} linkPath
     * @param {(err: number | null) => void} cb
     */
    protected async _symlink(target: string, linkPath: string, cb: (err: number | null) => void): Promise<void> {
        this._log(VirtualFSLoggerLevel.debug, `_symlink call: ${linkPath} -> ${target}`);

        try {
            const resolve = this._resolve(linkPath);
            await resolve.fs.symlink(target, resolve.relPath);

            process.nextTick(cb, 0);
        } catch (err) {
            this._log(VirtualFSLoggerLevel.error, 'SYMLINK ERROR', err);
            process.nextTick(cb, ErrorUtils.toFuseError(err, Fuse.EIO));
        }
    }

    /**
     * readlink — return the target string of the symlink at path.
     * @param {string} path
     * @param {(err: number | null, linkname?: string) => void} cb
     */
    protected async _readlink(path: string, cb: (err: number | null, linkname?: string) => void): Promise<void> {
        this._log(VirtualFSLoggerLevel.debug, `_readlink call: ${path}`);

        try {
            const resolve = this._resolve(path);
            const target = await resolve.fs.readlink(resolve.relPath);

            process.nextTick(cb, 0, target);
        } catch (err) {
            this._log(VirtualFSLoggerLevel.error, 'READLINK ERROR', err);
            process.nextTick(cb, ErrorUtils.toFuseError(err, Fuse.ENOENT));
        }
    }

    /**
     * link — hard link. Both src and dest must live in the same mount.
     * @param {string} src
     * @param {string} dest
     * @param {(err: number | null) => void} cb
     */
    protected async _link(src: string, dest: string, cb: (err: number | null) => void): Promise<void> {
        this._log(VirtualFSLoggerLevel.debug, `_link call: ${src} -> ${dest}`);

        try {
            const resolveSrc = this._resolve(src);
            const resolveDest = this._resolve(dest);

            if (resolveSrc.fs !== resolveDest.fs) {
                this._log(
                    VirtualFSLoggerLevel.debug,
                    `_link cross-mount refused: ${src} -> ${dest}`
                );
                process.nextTick(cb, Fuse.EXDEV);
                return;
            }

            await resolveSrc.fs.link(resolveSrc.relPath, resolveDest.relPath);

            process.nextTick(cb, 0);
        } catch (err) {
            this._log(VirtualFSLoggerLevel.error, 'LINK ERROR', err);
            process.nextTick(cb, ErrorUtils.toFuseError(err, Fuse.EIO));
        }
    }

    /**
     * Extended attributes are not supported by this filesystem. Returning
     * ENOSYS lets the kernel cache "no xattr here" instead of repeatedly
     * asking. All four ops share the same answer.
     */
    protected _getxattr(_path: string, _name: string, _position: number, cb: (err: number | null) => void): void {
        process.nextTick(cb, Fuse.ENOSYS);
    }

    protected _setxattr(_path: string, _name: string, _value: Buffer, _position: number, _flags: number, cb: (err: number | null) => void): void {
        process.nextTick(cb, Fuse.ENOSYS);
    }

    protected _listxattr(_path: string, cb: (err: number | null) => void): void {
        process.nextTick(cb, Fuse.ENOSYS);
    }

    protected _removexattr(_path: string, _name: string, cb: (err: number | null) => void): void {
        process.nextTick(cb, Fuse.ENOSYS);
    }

    /**
     * mknod
     * @param {string} path
     * @param {number} mode
     * @param {number} dev
     * @param {(err: number | null) => void} cb
     */
    protected async _mknod(path: string, mode: number, dev: number, cb: (err: number | null) => void): Promise<void> {
        this._log(VirtualFSLoggerLevel.debug, `_mknod call: ${path}`);

        try {
            const resolve = this._resolve(path);
            await resolve.fs.mknod(resolve.relPath, mode, dev);

            process.nextTick(cb, 0);
        } catch (err) {
            this._log(VirtualFSLoggerLevel.error, 'MKNOD ERROR', err);
            process.nextTick(cb, ErrorUtils.toFuseError(err, Fuse.EIO));
        }
    }

    /**
     * flush — called per close(2) of a shared fd
     * @param {string} path
     * @param {number} fd
     * @param {(err: number | null) => void} cb
     */
    protected async _flush(path: string, fd: number, cb: (err: number | null) => void): Promise<void> {
        this._log(VirtualFSLoggerLevel.debug, `_flush call: ${path}`);

        try {
            const resolve = this._resolve(path);
            await resolve.fs.flush(resolve.relPath, fd);

            process.nextTick(cb, 0);
        } catch (err: unknown) {
            this._log(VirtualFSLoggerLevel.error, 'FLUSH ERROR', err);
            process.nextTick(cb, ErrorUtils.toFuseError(err, Fuse.EIO));
        }
    }

    /**
     * fsync / fdatasync
     * @param {string} path
     * @param {boolean} datasync true = fdatasync, false = full fsync
     * @param {number} fd
     * @param {(err: number | null) => void} cb
     */
    protected async _fsync(path: string, datasync: boolean, fd: number, cb: (err: number | null) => void): Promise<void> {
        this._log(VirtualFSLoggerLevel.debug, `_fsync call: ${path} (datasync=${datasync})`);

        try {
            const resolve = this._resolve(path);
            await resolve.fs.fsync(resolve.relPath, fd, datasync);

            process.nextTick(cb, 0);
        } catch (err: unknown) {
            this._log(VirtualFSLoggerLevel.error, 'FSYNC ERROR', err);
            process.nextTick(cb, ErrorUtils.toFuseError(err, Fuse.EIO));
        }
    }

    /**
     * release
     * @param {string} path
     * @param {number} fd
     * @param {(err: number | null) => void} cb
     */
    private async _release(path: string, fd: number, cb: (err: number | null) => void): Promise<void> {
        this._log(VirtualFSLoggerLevel.debug, `_release call: ${path}`);

        try {
            const resolve = this._resolve(path);
            await resolve.fs.release(resolve.relPath, fd);

            this._statsMap.delete(`${path}:${fd}`);

            process.nextTick(cb, 0);
        } catch (err: unknown) {
            this._log(VirtualFSLoggerLevel.error, 'RELEASE ERROR', err);
            process.nextTick(cb, ErrorUtils.toFuseError(err, Fuse.EIO));
        }
    }

    protected async _truncate(path: string, size: number, cb: (err: number | null) => void): Promise<void> {
        this._log(VirtualFSLoggerLevel.debug, `_truncate call: ${path}`);

        try {
            const resolve = this._resolve(path);
            await resolve.fs.truncate(resolve.relPath, size);

            process.nextTick(cb, 0);
        } catch (err: unknown) {
            this._log(VirtualFSLoggerLevel.error, 'TRUNCATE ERROR', err);
            process.nextTick(cb, ErrorUtils.toFuseError(err, Fuse.EIO));
        }
    }

    protected async _ftruncate(path: string, fd: number, size: number, cb: (err: number | null) => void): Promise<void> {
        this._log(VirtualFSLoggerLevel.debug, `_ftruncate call: ${path}`);

        try {
            const resolve = this._resolve(path);
            await resolve.fs.ftruncate(resolve.relPath, fd, size);

            process.nextTick(cb, 0);
        } catch (err: unknown) {
            this._log(VirtualFSLoggerLevel.error, 'FTRUNCATE ERROR', err);
            process.nextTick(cb, ErrorUtils.toFuseError(err, Fuse.EIO));
        }
    }

    /**
     * Mount. Returns a Promise that resolves once fuse-native confirms the
     * mount or rejects on failure. Existing fire-and-forget callers can keep
     * ignoring the return value.
     * @param {boolean} processSigInt Install a SIGINT handler that triggers unmount + exit.
     * @return {Promise<void>}
     */
    public mount(processSigInt: boolean = true): Promise<void> {
        if (processSigInt) {
            process.on('SIGINT', () => {
                this.unmount(true).catch(() => {
                    // already logged inside unmount; nothing else to do here
                });
            });
        }

        return new Promise<void>((resolve, reject) => {
            this._fuse.mount((err) => {
                if (err) {
                    this._log(VirtualFSLoggerLevel.error, 'Mount failed', err);
                    reject(err instanceof Error ? err : new Error(String(err)));
                    return;
                }

                this._log(VirtualFSLoggerLevel.log, 'Mounted', this._mountPath);
                resolve();
            });
        });
    }

    /**
     * Unmount. Returns a Promise that resolves once fuse-native confirms the
     * unmount.
     * @param {boolean} processExit Call process.exit(0) on success.
     * @return {Promise<void>}
     */
    public unmount(processExit: boolean = false): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this._fuse.unmount((err) => {
                if (err) {
                    this._log(VirtualFSLoggerLevel.error, 'Unmount failed', err);
                    reject(err instanceof Error ? err : new Error(String(err)));
                    return;
                }

                this._log(VirtualFSLoggerLevel.log, 'Unmounted', this._mountPath);
                resolve();

                if (processExit) {
                    process.exit(0);
                }
            });
        });
    }

}