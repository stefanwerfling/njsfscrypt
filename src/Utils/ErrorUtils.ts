import Fuse from 'fuse-native';
import {ErrnoFuseCb} from '../Error/ErrnoFuseCb.js';
import {ErrnoException} from '../Error/ErrnoException.js';

/**
 * Error Utils
 */
export class ErrorUtils {

    /**
     * Map a node-style fs error code (e.g. 'ENOENT') to the matching FUSE
     * negative error number. Returns null if the code is unknown.
     */
    private static readonly _CODE_MAP: Record<string, number> = {
        ENOENT: Fuse.ENOENT,
        EACCES: Fuse.EACCES,
        EEXIST: Fuse.EEXIST,
        ENOTDIR: Fuse.ENOTDIR,
        EISDIR: Fuse.EISDIR,
        ENOTEMPTY: Fuse.ENOTEMPTY,
        EPERM: Fuse.EPERM,
        EINVAL: Fuse.EINVAL,
        EBADF: Fuse.EBADF,
        EBUSY: Fuse.EBUSY,
        ENOSPC: Fuse.ENOSPC,
        EROFS: Fuse.EROFS,
        EXDEV: Fuse.EXDEV,
        EIO: Fuse.EIO,
        ENAMETOOLONG: Fuse.ENAMETOOLONG,
        ELOOP: Fuse.ELOOP,
        EMFILE: Fuse.EMFILE,
        ENFILE: Fuse.ENFILE
    };

    public static isFsError(err: unknown): err is ErrnoException {
        return (
            typeof err === 'object' &&
            err !== null &&
            'code' in err &&
            typeof (err as any).code === 'string'
        );
    }

    /**
     * Translate any thrown value into a FUSE-style negative errno.
     * Order:
     *  1. ErrnoFuseCb instance — already carries the right code.
     *  2. Node fs error with a string `code` — looked up in the table.
     *  3. Anything with a numeric `errno` — normalised to negative.
     *  4. Anything with a numeric `code` — assumed already FUSE-shaped.
     *  5. Fallback supplied by the caller.
     */
    public static toFuseError(err: unknown, fallback: number = Fuse.EIO): number {
        if (err instanceof ErrnoFuseCb) {
            return err.getFuseError();
        }

        if (this.isFsError(err)) {
            const mapped = this._CODE_MAP[err.code as string];
            if (mapped !== undefined) {
                return mapped;
            }
            if (typeof err.errno === 'number') {
                return err.errno > 0 ? -err.errno : err.errno;
            }
        }

        if (typeof err === 'object' && err !== null) {
            const e = err as {errno?: number; code?: number;};
            if (typeof e.errno === 'number') {
                return e.errno > 0 ? -e.errno : e.errno;
            }
            if (typeof e.code === 'number') {
                return e.code > 0 ? -e.code : e.code;
            }
        }

        return fallback;
    }

}