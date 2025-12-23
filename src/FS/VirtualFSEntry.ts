import {Stats} from 'fs';
import {StatFs} from 'fuse-native';

export interface VirtualFSEntry {
    init(): Promise<void>;
    isInit(): boolean;
    readdir(path: string): Promise<string[]>;
    getattr(path: string): Promise<Stats>;
    open(path: string, flags: number): Promise<number>;
    read(path: string, fd: number, length: number, offset: number): Promise<Buffer>;
    write(path: string, fd: number, buffer: Buffer, offset: number): Promise<number>;
    release(path: string, fd: number): Promise<void>;
    create(path: string, mode: number): Promise<number>;
    unlink(path: string): Promise<void>;
    mkdir(path: string, mode: number): Promise<void>;
    rmdir(path: string): Promise<void>;
    rename(src: string, dest: string): Promise<void>;
    truncate(path: string, size: number): Promise<void>;
    ftruncate(path: string, fd: number, size: number): Promise<void>;
    access(path: string, mode: number): Promise<void>;
    statfs(path: string): Promise<StatFs>;
}