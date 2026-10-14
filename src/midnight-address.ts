import {MidnightBech32m,UnshieldedAddress} from '@midnight-ntwrk/wallet-sdk-address-format';
import type {TestNetwork} from './environment.js';
import {midnightNetworkId} from './midnight-network.js';

/** Midnight claim recipient as the 32-byte unshielded address the contract mints to.
 * Accepts an unshielded bech32m address for the route's network (`mn_addr_preprod…`) or
 * raw 32-byte hex. A wrong 32-byte value mints to an address nobody controls and recorded
 * deposits have no refund path, so the all-zero address is refused. */
export function parseMidnightRecipient(value:unknown,network:TestNetwork='preprod'):Buffer{
 if(typeof value!=='string'||!value.trim())throw new Error('Midnight recipient required');
 const v=value.trim();let bytes:Buffer;
 if(/^[a-f0-9]{64}$/i.test(v))bytes=Buffer.from(v,'hex');
 else{
  const id=midnightNetworkId(network);let parsed:MidnightBech32m;
  try{parsed=MidnightBech32m.parse(v);}catch{throw new Error(`Midnight recipient must be an mn_addr_${id}… address or 32-byte hex`);}
  if(parsed.type!=='addr')throw new Error('Use an unshielded Midnight address (mn_addr…), not a shielded or dust address');
  if(parsed.network!==id)throw new Error(`This route only accepts Midnight ${id} addresses`);
  bytes=Buffer.from(UnshieldedAddress.codec.decode(id,parsed).data);
 }
 if(bytes.every(b=>b===0))throw new Error('The all-zero Midnight address cannot receive a claim');
 return bytes;
}
/** The unshielded bech32m form of a 32-byte recipient, for showing users what they will receive. */
export function formatMidnightRecipient(bytes:Uint8Array,network:TestNetwork='preprod'):string{
 const id=midnightNetworkId(network);
 return UnshieldedAddress.codec.encode(id,new UnshieldedAddress(Buffer.from(bytes))).asString();
}
