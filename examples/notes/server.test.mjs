import {test} from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';import {start} from './server.mjs';
test('starter stores notes, rejects invalid input, and fails closed without bridge config',async()=>{
 const server=start(0);await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 try{const home=await fetch(base);assert.equal(home.status,200);assert.match(await home.text(),/Local notes, public payments/);
 const post=(path,data)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
 const created=await post('/notes',{text:'synthetic acceptance note'});assert.equal(created.status,201);const note=await created.json();assert.match(note.commitment,/^[a-f0-9]{64}$/);
 const read=await (await post('/notes/read',{id:note.id})).json();assert.equal(read.text,'synthetic acceptance note');
 assert.equal((await post('/notes',{text:''})).status,400);assert.equal((await post('/bridge/prepare',{})).status,503);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('note storage is bounded',async()=>{
 const server=start(0,{maxNotes:3});await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 try{const post=data=>fetch(base+'/notes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
  for(let i=0;i<3;i++)assert.equal((await post({text:'n'+i})).status,201);
  assert.equal((await post({text:'overflow'})).status,507);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
