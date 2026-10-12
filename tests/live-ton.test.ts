import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {openTon} from '../src/live-ton.js';
import {withEnv,withTempDir} from './helpers/env.js';

test('TON sender takes the wallet lock before its journal and releases it when journal initialization fails',async()=>withTempDir(dir=>
 withEnv({BRIDGE_NETWORK:'preprod',MIDNIGHT_NETWORK:'preprod',BRIDGE_STATE_DIR:dir},async()=>{
  const lock=join(dir,'ton-wallet.lock');
  writeFileSync(join(dir,'ton-test-wallet.json'),JSON.stringify({seed:'11'.repeat(32)}),{mode:0o600});
  // A directory where the journal database belongs makes initialization fail before any network access.
  mkdirSync(join(dir,'ton-transactions.sqlite'));
  const ton=openTon();
  // While another process holds the lock, the send is refused and that lock is left alone.
  writeFileSync(lock,'{"pid":0}');
  await assert.rejects(()=>ton.send('must-fail-before-network',[]),/EEXIST/);assert(existsSync(lock));
  // Without it, the send gets past the lock (creating it) and fails at the journal; the lock is then removed.
  rmSync(lock);
  await assert.rejects(()=>ton.send('must-fail-before-network',[]),/unable to open database/);
  assert.equal(existsSync(lock),false);
  await assert.rejects(()=>ton.send('must-fail-before-network',[]),/unable to open database/,'a released lock does not wedge later sends');
 })));
