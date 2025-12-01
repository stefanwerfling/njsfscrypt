import {Stats} from 'fs';
import Fuse from 'fuse-native';
import {VirtualFSEntry} from './VirtualFSEntry.js';

export enum VirtualFSLoggerLevel {
    error,
    info,
    warn,
    log
}

/**
 * VirtualFS Logger
 */
export type VirtualFSLogger = (level: VirtualFSLoggerLevel, str: string, e?: unknown) => void;

/**
 * Crypt FS Stats
 */
export type CryptFSStats = {
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
    private _statsMap = new Map<string, CryptFSStats>();

    /**
     * constructor
     * @param {string} mountPath
     */
    public constructor(private mountPath: string) {
        this._mountPath = mountPath;

        this._fuse = new Fuse(mountPath, {
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
            release: this._release.bind(this)
        }, {
            force: true,
            debug: false
        });
    }

    /**
     * Add VirtualFS implementation to the register
     * @param {string|RegExp} pattern
     * @param {VirtualFSEntry} instance
     */
    public register(pattern: string | RegExp, instance: VirtualFSEntry): void {
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
            this._logger(level, str, e);
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
     * @return {Map<number, CryptFSStats>}
     */
    public getStats(): Map<string, CryptFSStats> {
        return this._statsMap;
    }

    /**
     * Resolve by path
     * @param {string} path
     * @return {{ fs: VirtualFSEntry; relPath: string; }}
     * @private
     */
    private _resolve(path: string): {
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
     * readdir
     * @param {string} path
     * @param {(err: number | null, names?: string[]) => void} cb
     */
    private async _readdir(path: string, cb: (err: number | null, names?: string[]) => void): Promise<void> {
        try {
            const resolve = this._resolve(path);
            const names = await resolve.fs.readdir(resolve.relPath);

            cb(0, names);
        } catch (err) {
            this._log(VirtualFSLoggerLevel.error, `READDIR ERROR: ${path}`, err);
            cb(Fuse.ENOENT);
        }
    }

    /**
     * get attr
     * @param {string} path
     * @param {(err: number | null, stat?: Stats) => void} cb
     */
    private async _getattr(path: string, cb: (err: number | null, stat?: Stats) => void): Promise<void> {
        try {
            const resolve = this._resolve(path);
            const stat = await resolve.fs.getattr(resolve.relPath);

            cb(0, stat);
        } catch(err) {
            this._log(VirtualFSLoggerLevel.error, `GETATTR ERROR: ${path}`, err);
            cb(Fuse.ENOENT);
        }
    }

    /**
     * open
     * @param {string} path
     * @param {number} flags
     * @param {(code: number, fd: number) => void} cb
     */
    private async _open(path: string, flags: number, cb: (err: number | null, fd?: number) => void): Promise<void> {
        try {
            const resolve = this._resolve(path);
            const fd = await resolve.fs.open(resolve.relPath, flags);

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

            cb(0, fd);
        } catch(err) {
            this._log(VirtualFSLoggerLevel.error, 'OPEN ERROR', err);
            cb(Fuse.ENOENT);
        }
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

            cb(data.length);
        } catch(err) {
            this._log(VirtualFSLoggerLevel.error, 'READ ERROR', err);
            cb(-Fuse.ENOENT);
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

            cb(written);
        } catch(err) {
            this._log(VirtualFSLoggerLevel.error, 'WRITE ERROR', err);
            cb(-Fuse.ENOENT);
        }
    }

    /**
     * Create
     * @param {string} path
     * @param {number} mode
     * @param {(err: number | null, fd?: number) => void} cb
     */
    private async _create(path: string, mode: number, cb: (err: number | null, fd?: number) => void): Promise<void> {
        try {
            const resolve = this._resolve(path);
            const fd = await resolve.fs.create(resolve.relPath, mode);

            cb(0, fd);
        } catch(err) {
            this._log(VirtualFSLoggerLevel.error, 'CREATE ERROR', err);
            cb(-Fuse.ENOENT);
        }
    }

    /**
     * unlink
     * @param {string} path Path to file
     * @param {(err: number | null) => void} cb
     */
    private async _unlink(path: string, cb: (err: number | null) => void): Promise<void> {
        try {
            const resolve = this._resolve(path);
            await resolve.fs.unlink(resolve.relPath);

            cb(0);
        } catch (err) {
            this._log(VirtualFSLoggerLevel.error, 'UNLINK ERROR', err);
            cb(Fuse.ENOENT);
        }
    }

    /**
     * mkdir
     * @param {string} path Path to directory
     * @param {number} mode
     * @param {(err: number | null) => void} cb
     */
    private async _mkdir(path: string, mode: number, cb: (err: number | null) => void): Promise<void> {
        try {
            const resolve = this._resolve(path);
            await resolve.fs.mkdir(resolve.relPath, mode);

            cb(0);
        } catch (err) {
            this._log(VirtualFSLoggerLevel.error, 'MKDIR ERROR', err);
            cb(Fuse.ENOENT);
        }
    }

    /**
     * rmdir
     * @param {string} path Path to directory
     * @param {(err: number | null) => void} cb
     */
    private async _rmdir(path: string, cb: (err: number | null) => void): Promise<void> {
        try {
            const resolve = this._resolve(path);
            await resolve.fs.rmdir(resolve.relPath);

            cb(0);
        } catch (err) {
            this._log(VirtualFSLoggerLevel.error, 'RMDIR ERROR', err);
            cb(Fuse.ENOENT);
        }
    }

    /**
     * rename
     * @param {string} src
     * @param {string} dest
     * @param {(err: number | null) => void} cb
     */
    private async _rename(src: string, dest: string, cb: (err: number | null) => void): Promise<void> {
        try {
            let tDest = dest;

            const resolve = this._resolve(src);

            try {
                const resolve2 = this._resolve(tDest);

                tDest = resolve2.relPath;
            } catch {
                //
            }

            await resolve.fs.rename(resolve.relPath, tDest);

            cb(0);
        } catch (err) {
            this._log(VirtualFSLoggerLevel.error, 'RENAME ERROR', err);
            cb(Fuse.ENOENT);
        }
    }

    /**
     * To fuse error
     * @param {unknown} err
     * @return {number}
     * @protected
     */
    protected _toFuseError(err: unknown): number {
        if (typeof err === 'object' && err !== null) {
            const e = err as { errno?: number; code?: number; };
            if (typeof e.errno === 'number') {
                return e.errno;
            }

            if (typeof e.code === 'number') {
                return e.code;
            }
        }

        return -Fuse.ENOENT;
    }

    /**
     * release
     * @param {string} path
     * @param {number} fd
     * @param {(err: number | null) => void} cb
     */
    private async _release(path: string, fd: number, cb: (err: number | null) => void): Promise<void> {
        try {
            const resolve = this._resolve(path);
            await resolve.fs.release(resolve.relPath, fd);

            this._statsMap.delete(`${path}:${fd}`);

            cb(0);
        } catch (err: unknown) {
            cb(this._toFuseError(err));
        }
    }

    /**
     * Mount
     * @param {boolean} processSigInt
     */
    public mount(processSigInt: boolean = true): void {
        this._fuse.mount(err => {
            if (err) {
                this._log(VirtualFSLoggerLevel.error, 'Mount failed', err);
            } else {
                this._log(VirtualFSLoggerLevel.log, 'Mounted', this._mountPath);
            }
        });

        if (processSigInt) {
            process.on('SIGINT', () => this.unmount(true));
        }
    }

    /**
     * Unmount
     * @param {boolean} processExit
     */
    public unmount(processExit: boolean = false): void {
        if (this._fuse === null) {
            return;
        }

        this._fuse.unmount(err => {
            if (err) {
                this._log(VirtualFSLoggerLevel.error, 'Unmount failed', err);
            } else {
                this._log(VirtualFSLoggerLevel.log, 'Unmounted', this._mountPath);
            }

            if (processExit) {
                process.exit(0);
            }
        });
    }

}