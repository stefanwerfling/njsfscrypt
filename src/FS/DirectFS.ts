import Fuse, {StatFs} from 'fuse-native';
import {stat, mkdir, readdir, rename, rmdir, truncate, unlink} from 'node:fs/promises';
import tpath from 'path';
import {ErrnoFuseCb} from '../Error/ErrnoFuseCb.js';
import {VirtualFSEntry} from './VirtualFSEntry.js';
import {VirtualFSHandler} from './VirtualFSHandler.js';
import {constants} from 'node:fs';
import * as fs from 'fs/promises';
import {Stats} from 'fs';

/**
 * Direct FileSystem options
 */
interface DirectFSOptions {
    baseDir: string;
}

/**
 * Direct FileSystem
 */
export class DirectFS implements VirtualFSEntry {

    /**
     * Options
     * @private
     */
    private _options: DirectFSOptions;

    /**
     * Is dfs init
     * @private
     */
    private _isInit: boolean = false;

    /**
     * Handler
     * @private
     */
    private _handler: VirtualFSHandler = new VirtualFSHandler();

    /**
     * Constructor
     * @param {DirectFSOptions} options
     */
    public constructor(options: DirectFSOptions) {
        this._options = options;
    }

    public async init(): Promise<void> {
        const st = await stat(this._options.baseDir);

        if (!st.isDirectory()) {
            throw new Error(`baseDir is not a directory: ${this._options.baseDir}`);
        }

        this._isInit = true;
    }

    public isInit(): boolean {
        return this._isInit;
    }

    /**
     * Access file/directory
     * @param {string} path
     * @param {number} mode
     */
    public async access(path: string, mode: number): Promise<void> {
        //const dpath = this._mapPath(path);
        //await fs.access(dpath, mode);
    }

    /**
     * Create file
     * @param {string} path
     * @param {number} mode
     * @return {number}
     */
    public async create(path: string, mode: number): Promise<number> {
        const dpath = this._mapPath(path);
        const flags =
            // eslint-disable-next-line no-bitwise
            constants.O_CREAT |
            constants.O_TRUNC |
            constants.O_RDWR;

        const nativeFH = await fs.open(dpath, flags, mode);
        return this._handler.allocHandle({
            fh: nativeFH,
            path: path,
            realPath: dpath,
            flags: flags
        });
    }

    /**
     * Open file
     * @param {string} path
     * @param {number} flags
     */
    public async open(path: string, flags: number): Promise<number> {
        const dpath = this._mapPath(path);
        const nativeFH = await fs.open(dpath, flags);
        return this._handler.allocHandle({
            fh: nativeFH,
            path: path,
            realPath: dpath,
            flags: flags
        });
    }

    /**
     * Read buffer
     * @param {string} path
     * @param {number} fd
     * @param {number} length
     * @param {number} offset
     */
    public async read(path: string, fd: number, length: number, offset: number): Promise<Buffer> {
        const { fh } = this._handler.getHandle(fd);

        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await fh.read(buffer, 0, length, offset);

        return buffer.subarray(0, bytesRead);
    }

    /**
     * Write buffer
     * @param {string} path
     * @param {number} fd
     * @param {Buffer} buffer
     * @param {number} offset
     */
    public async write(path: string, fd: number, buffer: Buffer, offset: number): Promise<number> {
        const { fh } = this._handler.getHandle(fd);

        const { bytesWritten } = await fh.write(buffer, 0, buffer.length, offset);

        return bytesWritten;
    }

    /**
     * ftruncate
     * @param {string} path
     * @param {number} fd
     * @param {number} size
     */
    public async ftruncate(path: string, fd: number, size: number): Promise<void> {
        const { fh } = this._handler.getHandle(fd);

        await fh.truncate(size);
    }

    /**
     * Get attr
     * @param {string} path
     * @return {Stats}
     */
    public async getattr(path: string): Promise<Stats> {
        const dpath = this._mapPath(path);
        const st = await stat(dpath);

        if (path === '/' && !st.isDirectory()) {
            throw new ErrnoFuseCb(Fuse.ENOTDIR, 'Root is not a directory');
        }

        return st;
    }

    public async statfs(_path: string): Promise<StatFs> {
        return {
            bsize: 4096,
            frsize: 4096,
            blocks: 1000000,
            bfree: 500000,
            bavail: 500000,
            files: 1000000,
            ffree: 500000,
            favail: 500000,
            fsid: 1234,
            flag: 0,
            namemax: 255
        };
    }

    /**
     * mkdir
     * @param {string} path
     * @param {number} mode
     */
    public async mkdir(path: string, mode: number): Promise<void> {
        if (path === '/') {
            return;
        }

        const dpath = this._mapPath(path);

        try {
            await mkdir(dpath, { mode: mode });
        } catch (err: any) {
            if (err.code === 'EEXIST') {
                const st = await stat(dpath);
                if (!st.isDirectory()) {
                    throw err; 
                }
                return;
            }
            throw err;
        }
    }

    /**
     * Read dir
     * @param {string} path
     * @return {string[]}
     */
    public readdir(path: string): Promise<string[]> {
        const dpath = this._mapPath(path);
        return readdir(dpath) as Promise<string[]>;
    }

    /**
     * Release
     * @param {string} path
     * @param {number} fd
     */
    public async release(path: string, fd: number): Promise<void> {
        const entry = this._handler.getHandle(fd);

        if (!entry) {
            return;
        }

        try {
            await entry.fh.close();
        } finally {
            this._handler.freeHandle(fd);
        }
    }

    /**
     * Rename
     * @param {string} src
     * @param {string} dest
     */
    public async rename(src: string, dest: string): Promise<void> {
        const spath = this._mapPath(src);
        const dpath = this._mapPath(dest);

        await rename(spath, dpath);
    }

    /**
     * Remove dir
     * @param {string} path
     */
    public async rmdir(path: string): Promise<void> {
        const dpath = this._mapPath(path);

        await rmdir(dpath);
    }

    /**
     * truncate
     * @param {string} path
     * @param {number} size
     */
    public async truncate(path: string, size: number): Promise<void> {
        const dpath = this._mapPath(path);

        await truncate(dpath, size);
    }

    /**
     * unlink
     * @param {string} path
     */
    public async unlink(path: string): Promise<void> {
        const dpath = this._mapPath(path);

        await unlink(dpath);
    }

    /**
     * Map a path
     * @param {string} mountPath
     * @return {string}
     * @private
     */
    private _mapPath(mountPath: string): string {
        const parts = mountPath.split('/').filter(Boolean);
        return tpath.join(this._options.baseDir, ...parts);
    }

}