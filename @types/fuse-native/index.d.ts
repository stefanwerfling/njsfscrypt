declare module 'fuse-native' {
    import { Stats } from 'fs';
    import { Buffer } from 'buffer';

    /** Error codes exposed by fuse-native */
    export const EPERM: number;
    export const ENOENT: number;
    export const ESRCH: number;
    export const EINTR: number;
    export const EIO: number;
    export const ENXIO: number;
    export const E2BIG: number;
    export const ENOEXEC: number;
    export const EBADF: number;
    export const ECHILD: number;
    export const EAGAIN: number;
    export const ENOMEM: number;
    export const EACCES: number;
    export const EFAULT: number;
    export const ENOTBLK: number;
    export const EBUSY: number;
    export const EEXIST: number;
    export const EXDEV: number;
    export const ENODEV: number;
    export const ENOTDIR: number;
    export const EISDIR: number;
    export const EINVAL: number;
    export const ENFILE: number;
    export const EMFILE: number;
    export const ENOTTY: number;
    export const ETXTBSY: number;
    export const EFBIG: number;
    export const ENOSPC: number;
    export const ESPIPE: number;
    export const EROFS: number;
    export const EMLINK: number;
    export const EPIPE: number;
    export const EDOM: number;
    export const ERANGE: number;
    export const EDEADLK: number;
    export const ENAMETOOLONG: number;
    export const ENOLCK: number;
    export const ENOSYS: number;

    export interface FuseOps {
        getattr?: (
            path: string,
            cb: (err: number | null, stat?: Stats) => void
        ) => void;

        readdir?: (
            path: string,
            cb: (err: number | null, names?: string[]) => void
        ) => void;

        readlink?: (
            path: string,
            cb: (err: number | null, linkname?: string) => void
        ) => void;

        mknod?: (
            path: string,
            mode: number,
            dev: number,
            cb: (err: number | null) => void
        ) => void;

        mkdir?: (
            path: string,
            mode: number,
            cb: (err: number | null) => void
        ) => void;

        unlink?: (
            path: string,
            cb: (err: number | null) => void
        ) => void;

        rmdir?: (
            path: string,
            cb: (err: number | null) => void
        ) => void;

        symlink?: (
            target: string,
            linkPath: string,
            cb: (err: number | null) => void
        ) => void;

        rename?: (
            src: string,
            dest: string,
            cb: (err: number | null) => void
        ) => void;

        link?: (
            src: string,
            dest: string,
            cb: (err: number | null) => void
        ) => void;

        chmod?: (
            path: string,
            mode: number,
            cb: (err: number | null) => void
        ) => void;

        chown?: (
            path: string,
            uid: number,
            gid: number,
            cb: (err: number | null) => void
        ) => void;

        truncate?: (
            path: string,
            size: number,
            cb: (err: number | null) => void
        ) => void;

        open?: (
            path: string,
            flags: number,
            cb: (err: number | null, fd?: number) => void
        ) => void;

        opendir?: (
            path: string,
            flags: number,
            cb: (err: number | null, fd?: number) => void
        ) => void;

        read?: (
            path: string,
            fd: number,
            buffer: Buffer,
            length: number,
            position: number,
            cb: (bytesRead: number) => void
        ) => void;

        write?: (
            path: string,
            fd: number,
            buffer: Buffer,
            length: number,
            position: number,
            cb: (written: number) => void
        ) => void;

        release?: (
            path: string,
            fd: number,
            cb: (err: number | null) => void
        ) => void;

        releasedir?: (
            path: string,
            fd: number,
            cb: (err: number | null) => void
        ) => void;

        create?: (
            path: string,
            mode: number,
            cb: (err: number | null, fd?: number) => void
        ) => void;
    }

    export interface FuseOptions {
        displayFolder?: boolean;
        force?: boolean;
        debug?: boolean;
        allowOther?: boolean;
        name?: string;
    }

    export default class Fuse {

        public constructor(
            mountPath: string,
            ops: FuseOps,
            opts?: FuseOptions
        );

        public mount(cb: (err?: any) => void): void;
        public unmount(cb: (err?: any) => void): void;

        public static unmount(mountPath: string, cb: (err?: any) => void): void;

    }
}