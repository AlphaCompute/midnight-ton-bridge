import {readFileSync,writeFileSync} from 'node:fs';import {createHash} from 'node:crypto';
const file='docs/security-review.pdf',data=readFileSync(file);if(data.length>1_000_000)throw Error('Review exceeds single-block delivery limit');
const digest=createHash('sha256').update(data).digest();const bytes=Buffer.concat([Buffer.from([1,0x55,0x12,0x20]),digest]);
const alphabet='abcdefghijklmnopqrstuvwxyz234567';let bits=0,value=0,base32='';for(const b of bytes){value=(value<<8)|b;bits+=8;while(bits>=5){bits-=5;base32+=alphabet[(value>>>bits)&31];}}if(bits)base32+=alphabet[(value<<(5-bits))&31];
const cid='b'+base32;
writeFileSync('docs/security-review-ipfs.json',JSON.stringify({file,sha256:digest.toString('hex'),cid,codec:'raw',cidVersion:1,published:false,pinned:false,instructions:'After approving publication, use ipfs block put --cid-codec=raw --mhtype=sha2-256 --pin docs/security-review.pdf. Require the returned CID to match, retrieve with ipfs block get CID, compare SHA-256 and verify retained pin from an independent node.',reference:'https://docs.ipfs.tech/reference/kubo/cli/'},null,2)+'\n');console.log('Prepared offline CID; not published or pinned:',cid);
