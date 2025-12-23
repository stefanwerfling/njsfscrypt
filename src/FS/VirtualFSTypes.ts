import {FileHandle} from 'fs/promises';

export type VirtualFSNativeFH = FileHandle;
export type VirtualFSVirtualFD = number;

export interface VirtualFSHandleEntry {
    fh: VirtualFSNativeFH;
    path: string;
    realPath: string;
    flags: number;
}