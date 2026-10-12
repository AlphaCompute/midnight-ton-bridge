export const HEX32=/^[0-9a-f]{64}$/i;
/** Decodes 32-byte hex, rejecting anything else. */
export function hex32(value:unknown,what='value'):Buffer{
 if(typeof value!=='string'||!HEX32.test(value))throw new Error(`${what}: expected 32-byte hex`);
 return Buffer.from(value,'hex');
}
/** JSON with bigints as decimal strings and bytes as hex. Buffer.toJSON runs before
 * the replacer, so its `{type:'Buffer',data}` form is handled as well. */
export function toJson(value:unknown,indent=2){
 return JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v instanceof Uint8Array?Buffer.from(v).toString('hex')
  :v&&typeof v==='object'&&v.type==='Buffer'&&Array.isArray(v.data)?Buffer.from(v.data).toString('hex'):v,indent);
}
