import {readFileSync,writeFileSync} from 'node:fs';
import {cpus,platform,arch} from 'node:os';
const evidence=JSON.parse(readFileSync('docs/standard-testnet-evidence.json'));
if(!evidence.complete)throw Error('Completed evidence required');
const rows=evidence.steps.filter(s=>s.circuit).map(s=>({circuit:s.circuit,milliseconds:s.milliseconds,transactionId:s.txId,blockHeight:s.blockHeight}));
if(rows.length!==6||rows.some(r=>!Number.isFinite(r.milliseconds)||r.milliseconds<=0))throw Error('Missing measured duration');
const sorted=rows.map(r=>r.milliseconds).sort((a,b)=>a-b),report={scope:'Six sequential successful calls in one public testnet round trip; total call duration includes transaction preparation, proof, broadcast and finality. Not isolated proving time or a throughput benchmark.',machine:{platform:platform(),architecture:arch(),cpu:cpus()[0]?.model,node:process.version},rows,summary:{samples:rows.length,totalMilliseconds:sorted.reduce((a,b)=>a+b,0),medianMilliseconds:(sorted[2]+sorted[3])/2,minimumMilliseconds:sorted[0],maximumMilliseconds:sorted.at(-1)},limits:['No concurrency/load test was performed.','No throughput or latency SLA is inferred from six samples.','Production performance targets require explicit acceptance.']};
writeFileSync('docs/benchmarks.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report.summary));
