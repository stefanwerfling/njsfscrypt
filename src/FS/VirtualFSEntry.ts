import {Stats} from 'fs';

export interface VirtualFSEntry {
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
}