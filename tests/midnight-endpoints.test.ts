import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {midnightEndpoints,midnightIndexer,redactEndpoints} from '../src/midnight-endpoints.js';

// Calls that see a Blockfrost token install process-wide output redaction, so they run in a
// subprocess rather than patching this test runner's stdout. The subprocess asserts internally.
const module=pathToFileURL(resolve('src/midnight-endpoints.ts')).href;
function inSubprocess(body:string){
 const script=`import assert from 'node:assert/strict';const m=await import(${JSON.stringify(module)});${body}`;
 return spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{encoding:'utf8',timeout:30000});
}

test('preprod Midnight endpoints require a Blockfrost preprod token and never fall back to retired hosts',()=>{
 assert.throws(()=>midnightEndpoints('preprod',{}),/BLOCKFROST_PROJECT_ID/);
 assert.throws(()=>midnightEndpoints('preprod',{BLOCKFROST_PROJECT_ID:'nightmainnetABC'}),/Preprod/);
 assert.throws(()=>midnightEndpoints('mainnet',{BLOCKFROST_PROJECT_ID:'nightpreprodABC'}),/test networks only/);
 assert.equal(midnightEndpoints('preprod',{MIDNIGHT_NODE_URL:'a',MIDNIGHT_NODE_WS:'b',MIDNIGHT_INDEXER_URL:'c',MIDNIGHT_INDEXER_WS:'d'}).indexer,'c');
 assert.equal(midnightEndpoints('local',{}).indexer,'http://127.0.0.1:18088/api/v3/graphql');
 const r=inSubprocess(`const e=m.midnightEndpoints('preprod',{BLOCKFROST_PROJECT_ID:'nightpreprodABC'});
  assert.equal(e.indexer,'https://midnight-preprod.blockfrost.io/api/v0?project_id=nightpreprodABC');assert.equal(e.nodeWS,'wss://rpc.midnight-preprod.blockfrost.io?project_id=nightpreprodABC');
  assert(Object.values(e).every(u=>!u.includes('midnight.network')));
  assert.equal(m.redactEndpoints('request to '+e.indexer+' failed'),'request to https://midnight-preprod.blockfrost.io/api/v0?project_id=REDACTED failed');`);
 assert.equal(r.status,0,r.stderr);
 assert.equal(redactEndpoints('wss://h/ws?a=1&project_id=tok&b=2 "x"'),'wss://h/ws?a=1&project_id=REDACTED&b=2 "x"');
});

test('read-only indexer endpoints derive the WebSocket from an explicit URL or fall back to network defaults',()=>{
 assert.deepEqual(midnightIndexer('preprod',{MIDNIGHT_INDEXER_URL:'https://indexer.example/api/v3/graphql'}),{indexer:'https://indexer.example/api/v3/graphql',indexerWS:'wss://indexer.example/api/v3/graphql/ws'});
 assert.deepEqual(midnightIndexer('local',{MIDNIGHT_INDEXER_URL:'http://127.0.0.1:1/graphql/'}),{indexer:'http://127.0.0.1:1/graphql/',indexerWS:'ws://127.0.0.1:1/graphql/ws'});
 assert.equal(midnightIndexer('preprod',{MIDNIGHT_INDEXER_URL:'https://a',MIDNIGHT_INDEXER_WS:'wss://b'}).indexerWS,'wss://b');
 assert.deepEqual(midnightIndexer('local',{}),{indexer:'http://127.0.0.1:18088/api/v3/graphql',indexerWS:'ws://127.0.0.1:18088/api/v3/graphql/ws'});
 // Without an explicit URL, preprod still needs a Blockfrost token (but never node URLs, see below).
 assert.throws(()=>midnightIndexer('preprod',{}),/BLOCKFROST_PROJECT_ID/);
 const r=inSubprocess(`const e=m.midnightIndexer('preprod',{BLOCKFROST_PROJECT_ID:'nightpreprodABC'});
  assert.deepEqual(e,{indexer:'https://midnight-preprod.blockfrost.io/api/v0?project_id=nightpreprodABC',indexerWS:'wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=nightpreprodABC'});
  const q=m.midnightIndexer('preprod',{MIDNIGHT_INDEXER_URL:'https://midnight-preprod.blockfrost.io/api/v0?project_id=nightpreprodXYZ'});
  assert.equal(q.indexerWS,'wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=nightpreprodXYZ');console.log(q.indexer);`);
 assert.equal(r.status,0,r.stderr);
 // A token inside an explicit indexer URL also switches on output redaction.
 assert(!r.stdout.includes('nightpreprodXYZ'));assert.match(r.stdout,/project_id=REDACTED/);
});

test('a process using a Blockfrost token never writes it to stdout or stderr',()=>{
 const r=inSubprocess("const e=m.midnightEndpoints('preprod',{BLOCKFROST_PROJECT_ID:'nightpreprodSECRET'});console.log(e.indexer);console.error(new Error('disconnected from '+e.nodeWS));process.stderr.write(Buffer.from(e.indexerWS));");
 assert.equal(r.status,0,r.stderr);
 assert(!(r.stdout+r.stderr).includes('nightpreprodSECRET'));
 assert.match(r.stdout,/project_id=REDACTED/);assert.match(r.stderr,/disconnected from wss:\/\/rpc\.midnight-preprod\.blockfrost\.io\?project_id=REDACTED/);
});
