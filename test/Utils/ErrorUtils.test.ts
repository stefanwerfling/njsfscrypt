import {strict as assert} from 'node:assert';
import {describe, it} from 'node:test';
import Fuse from 'fuse-native';
import {ErrorUtils} from '../../src/Utils/ErrorUtils.js';
import {ErrnoFuseCb} from '../../src/Error/ErrnoFuseCb.js';

describe('ErrorUtils.toFuseError', () => {

    it('returns the carried code from an ErrnoFuseCb', () => {
        const e = new ErrnoFuseCb(Fuse.EXDEV, 'cross-mount');
        assert.equal(ErrorUtils.toFuseError(e), Fuse.EXDEV);
    });

    it('maps a node fs error string code to the matching FUSE constant', () => {
        const e: NodeJS.ErrnoException = new Error('not found');
        e.code = 'ENOENT';
        assert.equal(ErrorUtils.toFuseError(e), Fuse.ENOENT);

        const e2: NodeJS.ErrnoException = new Error('exists');
        e2.code = 'EEXIST';
        assert.equal(ErrorUtils.toFuseError(e2), Fuse.EEXIST);

        const e3: NodeJS.ErrnoException = new Error('busy');
        e3.code = 'EBUSY';
        assert.equal(ErrorUtils.toFuseError(e3), Fuse.EBUSY);

        const e4: NodeJS.ErrnoException = new Error('rofs');
        e4.code = 'EROFS';
        assert.equal(ErrorUtils.toFuseError(e4), Fuse.EROFS);
    });

    it('falls back to the supplied default when the code is unknown', () => {
        const e: NodeJS.ErrnoException = new Error('weird');
        e.code = 'EWHATEVER';
        assert.equal(ErrorUtils.toFuseError(e, Fuse.EIO), Fuse.EIO);
    });

    it('normalises a positive numeric errno to negative', () => {
        const e = {errno: 17};
        assert.equal(ErrorUtils.toFuseError(e), -17);
    });

    it('keeps an already-negative numeric errno as-is', () => {
        const e = {errno: -2};
        assert.equal(ErrorUtils.toFuseError(e), -2);
    });

    it('honours a numeric `code` field too', () => {
        const e = {code: -42};
        assert.equal(ErrorUtils.toFuseError(e), -42);
    });

    it('returns the fallback for plain Error instances', () => {
        assert.equal(ErrorUtils.toFuseError(new Error('boom'), Fuse.EIO), Fuse.EIO);
        assert.equal(ErrorUtils.toFuseError('string', Fuse.EIO), Fuse.EIO);
        assert.equal(ErrorUtils.toFuseError(undefined, Fuse.EIO), Fuse.EIO);
    });

});