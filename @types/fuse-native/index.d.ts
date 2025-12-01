declare module 'fuse-native' {
    import { Stats } from 'fs';
    import { Buffer } from 'buffer';

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

        public static EPERM: number;
        public static ENOENT: number;
        public static ESRCH: number;
        public static EINTR: number;
        public static EIO: number;
        public static ENXIO: number;
        public static E2BIG: number;
        public static ENOEXEC: number;
        public static EBADF: number;
        public static ECHILD: number;
        public static EAGAIN: number;
        public static ENOMEM: number;
        public static EACCES: number;
        public static EFAULT: number;
        public static ENOTBLK: number;
        public static EBUSY: number;
        public static EEXIST: number;
        public static EXDEV: number;
        public static ENODEV: number;
        public static ENOTDIR: number;
        public static EISDIR: number;
        public static EINVAL: number;
        public static ENFILE: number;
        public static EMFILE: number;
        public static ENOTTY: number;
        public static ETXTBSY: number;
        public static EFBIG: number;
        public static ENOSPC: number;
        public static ESPIPE: number;
        public static EROFS: number;
        public static EMLINK: number;
        public static EPIPE: number;
        public static EDOM: number;
        public static ERANGE: number;
        public static EDEADLK: number;
        public static ENAMETOOLONG: number;
        public static ENOLCK: number;
        public static ENOSYS: number;
    }
}