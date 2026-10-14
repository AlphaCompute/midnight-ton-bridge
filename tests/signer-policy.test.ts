import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {authorizeSignature} from '../src/signer-policy.js';
import {withTempDir} from './helpers/env.js';

const DAY=Date.UTC(2026,9,12,12),NEXT_DAY=DAY+86_400_000;

test('signer quota is durable, idempotent, rejects equivocation and honors stop switch',async()=>withTempDir(dir=>{
 const policy={database:join(dir,'sign.sqlite'),stopFile:join(dir,'STOP'),maxTransfer:'100',maxPerDay:'150'};
 authorizeSignature(policy,'a','payload-a',100n,DAY);authorizeSignature(policy,'a','payload-a',100n,DAY);
 assert.throws(()=>authorizeSignature(policy,'a','conflict',1n,DAY),/conflicting/);
 assert.throws(()=>authorizeSignature(policy,'b','payload-b',51n,DAY),/daily/);
 authorizeSignature(policy,'b','payload-b',50n,DAY);
 assert.throws(()=>authorizeSignature(policy,'c','payload-c',101n,DAY),/transfer exceeds/);
 assert.throws(()=>authorizeSignature(policy,'c','payload-c',0n,DAY),/transfer exceeds/);
 // The daily quota is per UTC day; an identical retry on a later day is still free and conflicts are still refused.
 authorizeSignature(policy,'c','payload-c',100n,NEXT_DAY);authorizeSignature(policy,'a','payload-a',100n,NEXT_DAY);
 assert.throws(()=>authorizeSignature(policy,'a','conflict',1n,NEXT_DAY),/conflicting/);
 writeFileSync(policy.stopFile,'stop');assert.throws(()=>authorizeSignature(policy,'a','payload-a',100n,DAY),/paused/);
 // Relative paths would depend on the working directory, so they are refused.
 assert.throws(()=>authorizeSignature({...policy,stopFile:'STOP'},'d','payload-d',1n,DAY),/absolute/);
 assert.throws(()=>authorizeSignature({...policy,database:'sign.sqlite'},'d','payload-d',1n,DAY),/absolute/);
 // A stop file that cannot be checked (here, a path through a regular file) pauses signing.
 assert.throws(()=>authorizeSignature({...policy,stopFile:join(policy.stopFile,'nested')},'d','payload-d',1n,DAY),/paused/);
}));
