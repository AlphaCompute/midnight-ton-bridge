import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {assertMidnightFinalized} from '../src/midnight-indexer.js';

test('a release is signed only for a retirement in a finalized, canonical Midnight block',async()=>{
 // Mock node: finalized head at height 100; canonical hash at any height is 0xaa..aa.
 const server=createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{
  const {method}=JSON.parse(body) as {method:string};
  const result=method==='chain_getFinalizedHead'?'0xff':method==='chain_getHeader'?{number:'0x64'}:method==='chain_getBlockHash'?'0x'+'aa'.repeat(32):undefined;
  res.end(JSON.stringify(result===undefined?{jsonrpc:'2.0',id:1,error:{message:'unknown'}}:{jsonrpc:'2.0',id:1,result}));});});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 try{
  await assertMidnightFinalized(url,100,'aa'.repeat(32));
  await assertMidnightFinalized(url,7,'0x'+'AA'.repeat(32));
  await assert.rejects(()=>assertMidnightFinalized(url,101,'aa'.repeat(32)),/not finalized/);
  await assert.rejects(()=>assertMidnightFinalized(url,50,'bb'.repeat(32)),/canonical/);
  // Genesis pin: the mock's block 0 hash is 0xaa..aa.
  await assertMidnightFinalized(url,50,'aa'.repeat(32),{genesis:'aa'.repeat(32)});
  await assert.rejects(()=>assertMidnightFinalized(url,50,'aa'.repeat(32),{genesis:'cc'.repeat(32)}),/pinned network/);
 }finally{server.close();}
});
