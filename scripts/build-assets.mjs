import {cpSync,mkdirSync} from 'node:fs';
mkdirSync('dist/build/midnight',{recursive:true});
cpSync('build/midnight/contract','dist/build/midnight/contract',{recursive:true});
