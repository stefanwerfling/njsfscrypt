import {NjsCryptFS, NjsCryptFSLoggerLevel} from './FS/NjsCryptFS.js';

const pathStorage = '/home/swe/Desktop/Unbenannter Ordner/test';
const pathMount2 = '/home/swe/Desktop/Unbenannter Ordner/test2';

// crypto.randomBytes(32)
const key = Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex');

const fsEncrypted = new NjsCryptFS(pathStorage, pathMount2, key);
fsEncrypted.setLogger((level, str, e) => {
    switch (level) {
        case NjsCryptFSLoggerLevel.error:
            console.error(str, e);
            break;

        case NjsCryptFSLoggerLevel.log:
            console.log(str, e);
    }
});

fsEncrypted.mount();

setInterval(() => {
    const statsMap = fsEncrypted.getStats();

    statsMap.forEach((stats, fileHandler) => {
        const rb = (stats.readBytesTotal / 1024 / 1024).toFixed(2);
        const wb = (stats.writeBytesTotal / 1024 / 1024).toFixed(2);
        const rt = (stats.readTimeMs / 1000).toFixed(2);
        const wt = (stats.writeTimeMs / 1000).toFixed(2);

        console.log(`[READ: ${fileHandler}] ${stats.readBytes} bytes in ${(stats.readBytesDuration/1000).toFixed(3)}s = ${((stats.readBytes/1024/1024)/(stats.readBytesDuration/1000)).toFixed(2)} MB/s`);
        console.log(`[WRITE: ${fileHandler}] ${stats.writeBytes} bytes in ${(stats.writeBytesDuration/1000).toFixed(3)}s = ${((stats.writeBytes/1024/1024)/(stats.writeBytesDuration/1000)).toFixed(2)} MB/s`);
        console.log(`[STATS: ${fileHandler}] Read: ${rb} MB in ${rt}s, Write: ${wb} MB in ${wt}s`);
    });
}, 1000);