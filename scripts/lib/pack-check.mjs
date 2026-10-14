// Rules for what the published npm package may contain, shared by release.mjs and its tests.
const LOCAL_DIRS=['.state','.tools','.claude','.acton','node_modules','output','logs','tmp'];
// The one tracked .env file: the local Docker indexer's public development defaults.
const ALLOWED=new Set(['infrastructure/local-indexer.env']);
/** Why `path` must not ship, or undefined when it may. Wallet state, seeds, nonces,
 * journals, provider tokens (any *.env, e.g. a copied monitor.env) and local tooling. */
export function privatePathReason(path){
 if(ALLOWED.has(path))return undefined;
 const parts=path.split('/'),name=parts.at(-1)??'';
 if(parts.some(x=>LOCAL_DIRS.includes(x)))return 'local or generated directory';
 if(/(^|\.)env$|^\.env\./.test(name)&&!name.endsWith('.example'))return 'environment file (may hold provider tokens)';
 if(name==='.npmrc')return 'npm credentials';
 if(/(secret|mnemonic|nonce)[^/]*$|\.mnemonic$|(^|-)wallets?\.(json|toml)$|^demo-operators\.json$|^funding\.json$/.test(name))return 'key, seed or nonce material';
 if(/\.sqlite(-shm|-wal|-journal)?$|\.lock$|\.log$/.test(name))return 'journal, lock or log';
 return undefined;
}
const REQUIRED=['dist/src/index.js','dist/src/sdk.js','dist/build/midnight/contract/index.js','README.md','LICENSE','docs/operations.md','examples/notes/env.example','examples/notes/index.html'];
/** Throws on a private path or a missing required file in `npm pack --json` output. */
export function checkPack(pack){
 for(const {path} of pack.files){const reason=privatePathReason(path);if(reason)throw new Error(`Private or generated local path in package: ${path} (${reason})`);}
 for(const required of REQUIRED)if(!pack.files.some(x=>x.path===required))throw new Error(`Missing ${required}`);
 return `Package passed: ${pack.files.length} files, ${pack.size} bytes, ${pack.shasum}`;
}
