declare module 'fuse-native' {
    import { Stats } from 'fs';
    import { Buffer } from 'buffer';

    export interface StatFs {
        // block size
        bsize: number;
        // fragment size
        frsize: number;
        // total data blocks
        blocks: number;
        // free blocks
        bfree: number;
        // free blocks for unprivileged users
        bavail: number;
        // total file nodes (inodes)
        files: number;
        // free file nodes
        ffree: number;
        // free nodes for unprivileged users
        favail: number;
        // filesystem id
        fsid: number;
        // mount flags
        flag: number;
        // maximum filename length
        namemax: number;
    }

    export interface FuseOps {
        access?: (
            path: string,
            mode: number,
            cb: (err: number | null) => void
        ) => void;

        statfs?: (
            path: string,
            cb: (err: number | null, stat?: StatFs) => void
        ) => void;

        getattr?: (
            path: string,
            cb: (err: number | null, stat?: Stats) => void
        ) => void;

        setattr?: (
            path: string,
            attr: Partial<Stats>,
            cb: (err: number | null) => void
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

        ftruncate?: (
            path: string,
            fd: number,
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
        allow_other?: boolean;
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
        public static ENOTEMPTY: number;
        public static ELOOP: number;
        public static EWOULDBLOCK: number;
        public static ENOMSG: number;
        public static EIDRM: number;
        public static ECHRNG: number;
        public static EL2NSYNC: number;
        public static EL3HLT: number;
        public static EL3RST: number;
        public static ELNRNG: number;
        public static EUNATCH: number;

    }
}