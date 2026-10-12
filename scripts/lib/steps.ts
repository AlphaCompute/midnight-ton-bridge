import type {MessageRelaxed} from '@ton/core';
import type {Journal} from '../../src/journal.js';

/** Resumable demonstration steps backed by a saved evidence file. A step is done once its
 * evidence is saved; on resume, finished steps are skipped and their recorded results
 * reused, so nothing that already executed is sent again. */
export type Step={key?:string;id?:string;circuit?:string;deposit?:{asset:number}}&Record<string,unknown>;
export function evidenceSteps(evidence:{steps:Step[]},save:()=>void,tonJournal:Journal,send:(id:string,messages:MessageRelaxed[])=>Promise<Record<string,unknown>>){
 const keyOf=(step:Step,seen:Map<string,number>)=>{
  if(step.key)return step.key;
  if(step.circuit){const n=seen.get(step.circuit)??0;seen.set(step.circuit,n+1);return `${step.circuit}:${n}`;}
  if(step.deposit)return `receipt:${step.deposit.asset}`;
  return String(step.id).replace(/#\d+$/,'');
 };
 const done=()=>{const seen=new Map<string,number>(),out=new Map<string,Step>();for(const step of evidence.steps)out.set(keyOf(step,seen),step);return out;};
 /** Runs `fn` once per key; its returned step (recorded with that key) is reused on resume. */
 const once=async(key:string,fn:()=>Promise<Record<string,unknown>>):Promise<Step>=>{const prior=done().get(key);if(prior)return prior;const step={key,...await fn()};evidence.steps.push(step);save();return step;};
 /** Sends once per logical ID. A confirmed earlier attempt counts as done; only a proven
  * rejection may be retried, and anything unresolved must be reconciled first. */
 const tonOnce=async(id:string,messages:MessageRelaxed[])=>{
  const prior=done().get(id);if(prior)return prior;
  const attempts=tonJournal.list().filter(r=>r.id===id||r.id.startsWith(`${id}#`));
  if(attempts.some(r=>r.stage!=='confirmed'&&r.stage!=='rejected'))throw new Error(`Send ${id} is unresolved; run reconcile:ton first`);
  const confirmed=attempts.find(r=>r.stage==='confirmed');
  const step:Step=confirmed?{id:confirmed.id,reconciled:'wallet execution confirmed by reconcile:ton'}:await send(id,messages);
  evidence.steps.push(step);save();return step;
 };
 return {done,once,tonOnce};
}
