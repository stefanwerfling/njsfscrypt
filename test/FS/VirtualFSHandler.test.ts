import {strict as assert} from 'node:assert';
import {describe, it} from 'node:test';
import type {FileHandle} from 'node:fs/promises';
import {VirtualFSHandler} from '../../src/FS/VirtualFSHandler.js';

const fakeFh = {} as FileHandle;

describe('VirtualFSHandler', () => {

    it('allocates increasing file descriptor ids starting at 1', () => {
        const handler = new VirtualFSHandler();

        const fd1 = handler.allocHandle({fh: fakeFh, path: '/a', realPath: '/r/a', flags: 0});
        const fd2 = handler.allocHandle({fh: fakeFh, path: '/b', realPath: '/r/b', flags: 0});

        assert.equal(fd1, 1);
        assert.equal(fd2, 2);
    });

    it('returns the registered handle for a known fd', () => {
        const handler = new VirtualFSHandler();
        const entry = {fh: fakeFh, path: '/x', realPath: '/r/x', flags: 7};

        const fd = handler.allocHandle(entry);

        assert.equal(handler.getHandle(fd), entry);
    });

    it('throws for an unknown fd', () => {
        const handler = new VirtualFSHandler();

        assert.throws(() => handler.getHandle(999), /Invalid FD 999/u);
    });

    it('frees a handle so subsequent lookups throw', () => {
        const handler = new VirtualFSHandler();
        const fd = handler.allocHandle({fh: fakeFh, path: '/x', realPath: '/r/x', flags: 0});

        handler.freeHandle(fd);

        assert.throws(() => handler.getHandle(fd));
    });

    it('does not reuse fd numbers after free', () => {
        const handler = new VirtualFSHandler();
        const fd1 = handler.allocHandle({fh: fakeFh, path: '/a', realPath: '/r/a', flags: 0});

        handler.freeHandle(fd1);

        const fd2 = handler.allocHandle({fh: fakeFh, path: '/b', realPath: '/r/b', flags: 0});

        assert.notEqual(fd1, fd2);
    });

});