import {FileHandle} from 'fs/promises';

export type VirtualFSNativeFH = FileHandle;
export type VirtualFSVirtualFD = number;

/**
 * Virtual FS Handle Entry
 */
export interface VirtualFSHandleEntry {

    /**
     * File Handle
     */
    fh: VirtualFSNativeFH;

    /**
     * Virtual Path
     */
    path: string;

    /**
     * Real Path
     */
    realPath: string;

    /**
     * Falgs
     */
    flags: number;
}