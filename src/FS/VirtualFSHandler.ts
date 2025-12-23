import {VirtualFSHandleEntry, VirtualFSVirtualFD} from './VirtualFSTypes.js';

/**
 * Virtual Filesystem handler
 */
export class VirtualFSHandler {

    /**
     * next free handle id
     * @protected
     */
    protected _nextFD = 1;

    /**
     * workend handles map
     * @protected
     */
    protected _handles = new Map<VirtualFSVirtualFD, VirtualFSHandleEntry>();

    /**
     * alloc a new Handle
     * @param {VirtualFSHandleEntry} entry
     * @return {VirtualFSVirtualFD}
     */
    public allocHandle(entry: VirtualFSHandleEntry): VirtualFSVirtualFD {
        const vfd = this._nextFD++;
        this._handles.set(vfd, entry);
        return vfd;
    }

    /**
     * Return a handle entry
     * @param {VirtualFSVirtualFD} vfd
     * @return {VirtualFSHandleEntry}
     */
    public getHandle(vfd: VirtualFSVirtualFD): VirtualFSHandleEntry {
        const h = this._handles.get(vfd);

        if (!h) {
            throw new Error(`Invalid FD ${vfd}`);
        }

        return h;
    }

    /**
     * Free the open virtual handle
     * @param {VirtualFSVirtualFD} vfd
     */
    public freeHandle(vfd: VirtualFSVirtualFD): void {
        this._handles.delete(vfd);
    }

}