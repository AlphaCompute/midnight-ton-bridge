import type {TestNetwork} from './environment.js';
/** Midnight network ID for a bridge network: the local dev chain is `undeployed`. */
export const midnightNetworkId=(network:TestNetwork)=>network==='local'?'undeployed':'preprod';
