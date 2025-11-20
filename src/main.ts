import {EncryptedFS} from './FS/EncryptedFS.js';
const pathStorage = '/home/swe/Desktop/Unbenannter Ordner/test';
const pathMount2 = '/home/swe/Desktop/Unbenannter Ordner/test2';

const key = Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex');

const fsEncrypted = new EncryptedFS(pathStorage, pathMount2, key);
fsEncrypted.mount();