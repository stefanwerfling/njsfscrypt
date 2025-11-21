#!/usr/bin/env node

import {NjsCryptFS} from './FS/NjsCryptFS.js';
import {NjsCryptKey} from './Key/NjsCryptKey.js';

const args = process.argv.slice(2);

// ---------------------------------------------------------------------------------------------------------------------

const printHelp = () => {
    console.log(`
Usage:
  njsfscrypt -keygen [length]
  njsfscrypt -mount <storagePath> <mountPath> <hexKey>

Commands:
  -keygen               Generates a new encryption key.
                        Optional: length (default 32)

  -mount                Mounts an encrypted filesystem.
                        Requires:
                          1) storagePath  (folder containing encrypted files)
                          2) mountPath    (FUSE mount folder)
                          3) hexKey       (64 or 128 hex chars, depending on key size)

Examples:
  njsfscrypt -keygen
  njsfscrypt -keygen 64
  
  njsfscrypt -mount ./storage ./mnt 012345abcdef...
`);
};

// ---------------------------------------------------------------------------------------------------------------------

if (args.length === 0) {
    console.log("❌ No arguments provided.\n");
    printHelp();
    process.exit(1);
}


switch (args[0]) {
    case '-keygen': {
        let length = 32;

        if (args[1] !== undefined) {
            const parsed = parseInt(args[1], 10);

            if (isNaN(parsed) || parsed <= 0) {
                console.log(`❌ Invalid key length: "${args[1]}"\n   Length must be a positive integer.\n`);
                process.exit(1);
            }

            length = parsed;
        }

        const key = NjsCryptKey.generate(length);

        console.log("🔑 Key generation successful!");
        console.log("----------------------------------------");
        console.log(`✨ Your new key (${length} bytes):`);
        console.log(key);
        console.log("----------------------------------------");
        break;
    }

    // -----------------------------------------------------------------------------------------------------------------

    case "-mount": {

        if (args.length < 4) {
            console.log("❌ Missing arguments for -mount.\n");
            console.log("Required: <storagePath> <mountPath> <hexKey>\n");
            printHelp();
            process.exit(1);
        }

        const storagePath = args[1];
        const mountPath = args[2];
        const hexKey = args[3];

        if (!/^[0-9a-fA-F]+$/.test(hexKey) || hexKey.length % 2 !== 0) {
            console.log("❌ Invalid hex key. Must contain only [0-9a-f] and have even length.\n");
            process.exit(1);
        }

        const keyBuffer = NjsCryptKey.hexStrToBuffer(hexKey);

        console.log("🔐 Mounting encrypted filesystem...");
        console.log("========================================");
        console.log(`Storage Path : ${storagePath}`);
        console.log(`Mount Path   : ${mountPath}`);
        console.log(`Key Length   : ${keyBuffer.length} bytes`);
        console.log("========================================");

        const fsEncrypted = new NjsCryptFS(storagePath, mountPath, keyBuffer);
        fsEncrypted.mount();

        console.log("🚀 Filesystem mounted successfully.");
        break;
    }

    // -----------------------------------------------------------------------------------------------------------------

    default:
        console.log(`❌ Unknown CLI argument: "${args[0]}"\n`);
        printHelp();
        process.exit(1);
}