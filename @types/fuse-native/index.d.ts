declare module 'fuse-native' {
    import {Buffer} from 'buffer';
    import {Stats} from 'fs';

    type Stat = Stats;

    interface Statfs {
        blockSize: number;
        totalBlocks: number;
        freeBlocks: number;
        availableBlocks: number;
    }

    interface StatArray {
        dev: number;
        ino: number;
        mode: number;
        nlink: number;
        uid: number;
        gid: number;
        rdev: number;
        size: number;
        blksize: number;
        blocks: number;
        atime: number;
        mtime: number;
        ctime: number;
    }

    interface Opcodes {
        // eslint-disable-next-line @typescript-eslint/ban-types
        op: Function;
        defaults?: any[];
    }

    interface FuseOptions {
        timeout?: number | false;
        force?: boolean;
        mkdir?: boolean;
        debug?: boolean;
        allowOther?: boolean;
        allowRoot?: boolean;
        autoUnmount?: boolean;
        defaultPermissions?: boolean;
        blkdev?: boolean;
        blksize?: number;
        maxRead?: number;
        fd?: number;
        userId?: number;
        fsname?: string;
        subtype?: string;
        kernelCache?: boolean;
        autoCache?: boolean;
        umask?: number;
        uid?: number;
        gid?: number;
        entryTimeout?: number;
        attrTimeout?: number;
        acAttrTimeout?: number;
        noforget?: boolean;
        remember?: boolean;
        modules?: string;
        displayFolder?: boolean;
        name?: string;
    }

    interface FuseOps {
        init?: (cb: (err: any) => void) => void;
        error?: (cb: (err: any) => void) => void;
        getattr?: (
            path: string,
            cb: (
                err: any,
                stat: Stat
            ) => void
        ) => void;
        fgetattr?: (
            path: string,
            fd: number,
            cb: (
                err: any,
                stat: Stat
            ) => void
        ) => void;
        access?: (
            path: string,
            mode: number,
            cb: (err: any) => void
        ) => void;
        statfs?: (
            path: string,
            cb: (
                err: any,
                statfs: any
            ) => void
        ) => void;
        flush?: (
            path: string,
            fd: number,
            cb: (err: any) => void
        ) => void;
        fsync?: (
            path: string,
            datasync: boolean,
            fd: number,
            cb: (err: any) => void
        ) => void;
        fsyncdir?: (
            path: string,
            datasync: boolean,
            fd: number,
            cb: (err: any) => void
        ) => void;
        readdir?: (
            path: string,
            cb: (
                err: any,
                names: string[],
                stats: Stat[]
            ) => void
        ) => void;
        truncate?: (
            path: string,
            size: number,
            cb: (err: any) => void
        ) => void;
        ftruncate?: (
            path: string,
            fd: number,
            size: number,
            cb: (err: any) => void
        ) => void;
        utimens?: (
            path: string,
            atime: number,
            mtime: number,
            cb: (err: any) => void
        ) => void;
        readlink?: (
            path: string,
            cb: (
                err: any,
                linkname: string
            ) => void
        ) => void;
        chown?: (
            path: string,
            uid: number,
            gid: number,
            cb: (err: any) => void
        ) => void;
        chmod?: (
            path: string,
            mode: number,
            cb: (err: any) => void
        ) => void;
        mknod?: (
            path: string,
            mode: number,
            dev: number,
            cb: (err: any) => void
        ) => void;
        setxattr?: (
            path: string,
            name: string,
            value: Buffer,
            position: number,
            flags: number,
            cb: (err: any) => void
        ) => void;
        getxattr?: (
            path: string,
            name: string,
            position: number,
            cb: (
                err: any,
                value: Buffer
            ) => void
        ) => void;
        listxattr?: (
            path: string,
            cb: (
                err: any,
                list: string[]
            ) => void
        ) => void;
        removexattr?: (
            path: string,
            name: string,
            cb: (err: any) => void
        ) => void;
        open?: (
            path: string,
            flags: number,
            cb: (
                err: any,
                fd: number
            ) => void
        ) => void;
        opendir?: (
            path: string,
            flags: number,
            cb: (
                err: any,
                fd: number
            ) => void
        ) => void;
        create?: (
            path: string,
            mode: number,
            cb: (
                err: any,
                fd: number
            ) => void
        ) => void;
        unlink?: (
            path: string,
            cb: (err: any) => void
        ) => void;
        rename?: (
            src: string,
            dest: string,
            cb: (err: any) => void
        ) => void;
        link?: (
            src: string,
            dest: string,
            cb: (err: any) => void
        ) => void;
        symlink?: (
            src: string,
            dest: string,
            cb: (err: any) => void
        ) => void;
        mkdir?: (
            path: string,
            mode: number,
            cb: (err: any) => void
        ) => void;
        rmdir?: (
            path: string,
            cb: (err: any) => void
        ) => void;
    }

    export class Fuse {

        public constructor(
            mnt: string,
            ops: FuseOps,
            opts?: FuseOptions
        );

        public static unmount(
            mnt: string,
            cb: (err: any) => void
        ): void;

        public mount(cb: (err: any) => void): void;

        public unmount(cb: (err: any) => void): void;

        public errno(code: string): number;

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