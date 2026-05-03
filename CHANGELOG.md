# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-05-04

### Added
- **AES-256-GCM authenticated encryption per block** for file contents.
  Every encrypted block on disk now carries a fresh random 12-byte IV, a
  16-byte GCM auth tag, and the block index bound in as Additional
  Authenticated Data (AAD). Tampering with the ciphertext, the tag, or
  swapping blocks within a file all cause `read()` to fail with `EIO`
  instead of silently returning corrupted plaintext.
- New on-disk header carries a `"NJSc"` magic + `version=2` marker so the
  format can be detected and old files rejected with a clear error.

### Changed
- **Breaking on-disk format change for `CryptFS`**. Files written by 1.1.x
  (AES-256-CTR with a per-file nonce) cannot be read by 1.2.x. Decrypt and
  re-encrypt them against a 1.2.0 mount before upgrading; the new format
  starts every encrypted file with `"NJSc"` + uint32 version, which lets
  any future tooling distinguish the layouts.
- README claim about authenticated encryption is now accurate — it was
  previously only true for filenames; file contents used unauthenticated
  CTR mode.

### Internal
- New helpers `_encryptBlock` / `_decryptBlock` / `_buildHeader` /
  `_readHeader` / `_physicalSize` / `_blockDiskOffset` / `_plainLenOfBlock`
  in `CryptFS`.
- `truncate` and `ftruncate` share a single `_resize()` implementation
  that re-encrypts the boundary block when the new size lands mid-block.
- Removed `_encryptCTR` / `_decryptCTR` / `_deriveCounterIV` and the
  `NONCE_SIZE` / `AES_BLOCK` constants.
- New tests cover ciphertext tampering, auth-tag tampering, and the
  format-version sentinel.

## [1.1.0] - 2026-05-03

### Added
- **Test suite**: Node-native `node:test` runner covering `CryptKey`, `VirtualFSHandler`,
  `DirectFS`, `CryptFS`, `ErrorUtils` and the `VirtualFS` routing layer (86 tests).
  New `npm test` script and `tsconfig.test.json`.
- **Full FUSE operation coverage**:
  - `chmod`, `chown`, `utimens` are now registered and translated into `setattr`
    calls on the entry. Previously the registered `setattr` op was never invoked
    by `fuse-native`, so `chmod` / `chown` / `touch` had no effect.
  - `flush` and `fsync` (with `datasync` flag) — applications that call
    `fsync(2)` no longer receive `ENOSYS`.
  - `symlink`, `readlink`, `link` (hard link), `mknod` for regular files.
  - `init` and `error` lifecycle hooks wired to the existing logger.
  - `getxattr` / `setxattr` / `listxattr` / `removexattr` registered as
    `ENOSYS` stubs so the kernel can cache "no xattr support" cleanly.
- **Promise-based mount lifecycle**: `mount()` and `unmount()` now return
  `Promise<void>` that resolves once `fuse-native` confirms the operation.
  Existing fire-and-forget callers continue to work unchanged.
- **Configurable mount options**: new third constructor argument
  `VirtualFSMountOptions` exposes `force`, `allowOther` and `name`. Default
  for `force` remains `true` for backward compatibility.
- **CryptFS feature parity with DirectFS**:
  - Encrypted symlink targets — the on-disk symlink stores the target string
    encrypted with the same name-encoding scheme as filenames; the kernel
    only ever sees the decrypted target via `readlink`.
  - Hard links via `link()` — both encoded names share a single encrypted inode.
  - `mknod` for regular files (creates the standard CryptFS header). Other
    file types still return `ENOSYS`.
- **Centralised FUSE error translation**: `ErrorUtils.toFuseError(err, fallback)`
  understands `ErrnoFuseCb`, Node-style fs error codes (`ENOENT`, `EACCES`,
  `EEXIST`, `EBUSY`, `EROFS`, `ENOTEMPTY`, …), numeric `errno`/`code` fields,
  and falls back to the caller-supplied default. All 17+ wrappers now route
  through this helper instead of swallowing every error as `ENOENT`.
- **Stats survival across `rename`**: open-file stats keyed on the source
  path are re-keyed onto the destination path so `getStats()` keeps tracking
  the same file descriptor.
- **`_create` initialises stats**: files created via `touch` now appear in
  `getStats()` like files opened via `open()`.

### Fixed
- **Path-routing bugs in `VirtualFS`** (`setattr`, `access`, `truncate`,
  `ftruncate`): the wrappers passed the full mount path to the entry instead
  of the resolved relative path, breaking sub-mount registrations such as
  `vfs.register('/crypt', cryptFs)`.
- **Cross-mount `rename` and `link`**: previously silently performed in the
  wrong filesystem; now correctly rejected with `EXDEV`.
- **`getattr` on symlinks**: `DirectFS` now uses `lstat` so symbolic links are
  reported as links rather than their resolution targets. `CryptFS` does the
  same and returns the decoded target length as `size`.
- **`_setattr` was dead code**: `fuse-native` never calls a `setattr` op —
  it dispatches `chmod`/`chown`/`utimens` separately. The corresponding
  ops are now registered.

### Changed
- `src/main.ts` reduced to a re-export of `index.ts`. The previous content was
  hard-coded developer test scaffolding (specific local paths and a hex key)
  that does not belong in a published entry point.
- Public surface in `src/index.ts` now also exports `VirtualFSMountOptions`.
- `VirtualFSEntry` interface gained `flush`, `fsync`, `symlink`, `readlink`,
  `link`, `mknod`. Custom entry implementations need to provide these methods.

### Internal
- Several wrappers in `VirtualFS` are now `protected` to allow targeted unit
  testing of the routing layer through a test subclass.
- New `@types/fuse-native/index.d.ts` declarations for `init`, `error`,
  `utimens`, `flush`, `fsync`, `getxattr`/`setxattr`/`listxattr`/`removexattr`.
- New `dist-test/` build target ignored via `.gitignore`.

## [1.0.1]

Initial public release.