#!/usr/bin/env node

import readline from 'readline';
import {CryptFS} from './FS/CryptFS.js';
import {VirtualFS} from './FS/VirtualFS.js';
import {CryptKey} from './Key/CryptKey.js';
import chalk from 'chalk';

const args = process.argv.slice(2);

// ---------------------------------------------------------------------------------------------------------------------

const printHelp = (): void => {
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

const pad = (str: string, len: number): string => {
    return str.padEnd(len, ' ');
};

const colorPad = (str: string, len: number, color: (s: string) => string): string => {
    return color(str.padEnd(len, ' '));
};

// ---------------------------------------------------------------------------------------------------------------------

if (args.length === 0) {
    console.log('❌ No arguments provided.\n');
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

        const key = CryptKey.generate(length);

        console.log('🔑 Key generation successful!');
        console.log('----------------------------------------');
        console.log(`✨ Your new key (${length} bytes):`);
        console.log(key);
        console.log('----------------------------------------');
        break;
    }

    // -----------------------------------------------------------------------------------------------------------------

    case '-mount': {

        if (args.length < 4) {
            console.log('❌ Missing arguments for -mount.\n');
            console.log('Required: <storagePath> <mountPath> <hexKey>\n');
            printHelp();
            process.exit(1);
        }

        const storagePath = args[1];
        const mountPath = args[2];
        const hexKey = args[3];

        if (!/^[0-9a-fA-F]+$/u.test(hexKey) || hexKey.length % 2 !== 0) {
            console.log('❌ Invalid hex key. Must contain only [0-9a-f] and have even length.\n');
            process.exit(1);
        }

        const keyBuffer = CryptKey.hexStrToBuffer(hexKey);

        const MOUNT_HEADER_LINES = 6;

        console.log('🔐 Mounting encrypted filesystem...');
        console.log('========================================');
        console.log(`Storage Path : ${storagePath}`);
        console.log(`Mount Path   : ${mountPath}`);
        console.log(`Key Length   : ${keyBuffer.length} bytes`);
        console.log('========================================');

        const vfs = new VirtualFS(mountPath);

        // stats -------------------------------------------------------------------------------------------------------
        setInterval(() => {
            const statsMap = vfs.getStats();

            readline.cursorTo(process.stdout, 0, MOUNT_HEADER_LINES);
            readline.clearScreenDown(process.stdout);

            const col = {
                file: 30,
                readMB: 10,
                writeMB: 10,
                readRate: 12,
                writeRate: 12,
                time: 8,
            };

            const rows: string[] = [];

            rows.push(
                chalk.bold(
                    pad('FILE', 30) +
                    pad('READ MB', 10) +
                    pad('WRITE MB', 10) +
                    pad('READ/s', 12) +
                    pad('WRITE/s', 12) +
                    pad('TIME', 8)
                )
            );

            rows.push(chalk.gray('-'.repeat(82)));

            statsMap.forEach((stats, fileHandler) => {
                const readMB = (stats.readBytesTotal / 1024 / 1024).toFixed(2);
                const writeMB = (stats.writeBytesTotal / 1024 / 1024).toFixed(2);

                const readRate =
                    stats.readBytesDuration > 0
                        ? ((stats.readBytes / 1024 / 1024) / (stats.readBytesDuration / 1000)).toFixed(2)
                        : '0.00';

                const writeRate =
                    stats.writeBytesDuration > 0
                        ? ((stats.writeBytes / 1024 / 1024) / (stats.writeBytesDuration / 1000)).toFixed(2)
                        : '0.00';

                const totalTime = (Math.max(stats.readTimeMs, stats.writeTimeMs) / 1000).toFixed(2);

                const readColor = readRate === '0.00' ? chalk.red : chalk.green;
                const writeColor = writeRate === '0.00' ? chalk.red : chalk.yellow;

                rows.push(
                    colorPad(fileHandler, col.file, chalk.cyan) +
                    pad(readMB, col.readMB) +
                    pad(writeMB, col.writeMB) +
                    colorPad(readRate, col.readRate, readColor) +
                    colorPad(writeRate, col.writeRate, writeColor) +
                    colorPad(totalTime, col.time, chalk.magenta)
                );
            });

            process.stdout.write(`${rows.join('\n')}\n`);
        }, 500);

        // -------------------------------------------------------------------------------------------------------------

        vfs.register('/', new CryptFS({
            encryptionKey: keyBuffer,
            baseDir: storagePath,
            blockSize: 64 * 10124
        }));

        vfs.mount();

        console.log('🚀 Filesystem mounted successfully.');
        break;
    }

    // case '-server': {
    //     const configArg = args[1];
    //     const cliRootPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../');
    //
    //     startSmallNjsFsCryptServer(cliRootPath, configArg).then();
    //     break;
    // }

    // -----------------------------------------------------------------------------------------------------------------

    default:
        console.log(`❌ Unknown CLI argument: "${args[0]}"\n`);
        printHelp();
        process.exit(1);
}