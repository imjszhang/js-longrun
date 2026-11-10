import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { withLongrunLock } from '../lock.mjs';
import { readDefinition, validateDefinition, taskPaths, loadState, saveState, safePath, listTasks } from './definitions.mjs';
import { getType, prepareTypeContext } from '../types/index.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const read = (file, fallback) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : fallback;
const readJSON = (file, fallback) => JSON.parse(read(file, JSON.stringify(fallback)));
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, value, {flag:'wx'}); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp,{force:true}); }
}
function file(root, relative) { return safePath(root, relative); }
function weekId(now, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map(p => [p.type,p.value]));
  const date = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  return `${date.getUTCFullYear()}-W${String(Math.ceil(((date - Date.UTC(date.getUTCFullYear(),0,1))/86400000+1)/7)).padStart(2,'0')}`;
}
function refreshBudget(state, definition, now) {
  const id = weekId(now, definition.trigger.timezone);
  if (state.week.id !== id) state.week = { id, runs: 0, subtasks: 0 };
}
function definition(root,id) {
  const value = JSON.parse(fs.readFileSync(taskPaths(root,id).definition,'utf8')), check = validateDefinition(value);
  if(value.id!==id)throw new Error('Definition identity mismatch');
  if (!check.ok) throw new Error(check.errors.join('; '));
  return value;
}
function artifacts(root,id) {
  const base=`research/longrun/${id}/artifacts`;
  const names=new Set();
  const walk=(relative='')=>{const dir=file(root,relative?`${base}/${relative}`:base);if(!fs.existsSync(dir))return;for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const name=relative?`${relative}/${entry.name}`:entry.name;file(root,`${base}/${name}`);if(entry.isDirectory())walk(name);else names.add(name);}};walk();
  const files=Object.fromEntries([...names].map(name=>[name,read(file(root,`${base}/${name}`),null)]));
  return {files,baseline:Object.fromEntries(Object.entries(files).map(([name,content])=>[name,hash(content)]))};
}
function inputs(root, paths) {
  let size=0;
  return paths.map(p=>{
    const f=file(root,p);if(!fs.statSync(f).isFile())throw new Error(`Input is not a file: ${p}`);
    size+=fs.statSync(f).size;
    if(size>1_048_576)throw new Error('Frozen inputs exceed 1 MiB');
    const content=new TextDecoder('utf-8',{fatal:true}).decode(fs.readFileSync(f));
    return {path:p,content,sha256:hash(content)};
  });
}
export function planTask({root,id,now=new Date(),kind='round',selectedKeys=[]}) {
  if(!['round','review'].includes(kind))throw new Error('Unknown run kind');
  const def=definition(root,id), p=taskPaths(root,id), state=loadState(root,id);
  const runId=kind==='review'?`RV${String((state.reviewCount??0)+1).padStart(4,'0')}`:`R${String(state.round+1).padStart(4,'0')}`;
  const prior=artifacts(root,id);
  const typeContext=prepareTypeContext({type:def.type,definition:def,kind,files:prior.files,selectedKeys,readInputs:paths=>inputs(root,paths),readOriginalRun:runId=>{
    if(!/^R\d{4,}$/.test(runId))throw new Error('Invalid original run');
    const original=readJSON(file(root,`research/longrun/${id}/runs/${runId}/draft.json`),null);
    if(!original||original.taskId!==id)throw new Error('Missing original source snapshot');
    return original;
  }});
  const context={definition:def,taskId:id,runId,kind,brief:fs.readFileSync(p.brief,'utf8'),baseline:prior.baseline,...typeContext};
  const plan=getType(def.type).prepareRun(context);
  for(const output of plan.allowedPaths) {
    if(!output.startsWith(`research/longrun/${id}/runs/${runId}/`))throw new Error('Execution plan escapes its run');
    file(root,output);
  }
  if(plan.attentionSnapshotPaths.some(p=>!plan.allowedPaths.includes(p)))throw new Error('Snapshot path not in output scope');
  return {schemaVersion:1,...context,plan,createdAt:now.toISOString(),definitionHash:hash(json(def))};
}
export function genericStatus({root,id,now=new Date()}) {
  const def=definition(root,id), state=structuredClone(loadState(root,id));refreshBudget(state,def,now);
  const reasons=[];
  if(!listTasks(root).some(row=>row.id===id))reasons.push('unregistered');
  if(state.control!=='enabled')reasons.push(state.control);
  if(state.running)reasons.push('active-run');
  if(state.nextDueAt&&Date.parse(state.nextDueAt)>+now)reasons.push('not-due');
  if(state.week.runs>=def.limits.weeklyRuns)reasons.push('weekly-budget');
  if(state.failures>=2)reasons.push('failures');
  return {definition:def,state,gates:{ok:!reasons.length,reasons}};
}
export async function startRun(options) {return withLongrunLock(options.root,()=>startUnlocked(options));}
async function startUnlocked({root,id,client,now=new Date(),kind='round',selectedKeys=[]}) {
  const {state,definition:def,gates}=genericStatus({root,id,now});
  const reasons=gates.reasons.filter(x=>!(kind==='review'&&['not-due','weekly-budget'].includes(x)));
  if(reasons.length)return {action:'hold',taskId:id,reasons};
  const frozen=planTask({root,id,now,kind,selectedKeys});
  const base=`research/longrun/${id}/runs/${frozen.runId}`;
  // Frozen run is authoritative for all subsequent collection, even after definition edits.
  write(file(root,`${base}/draft.json`),json(frozen));
  if(kind==='review')state.reviewCount=(state.reviewCount??0)+1;
  else {state.round++;state.week.runs++;}
  state.running={runId:frozen.runId,kind,ticketId:null,phase:'submitting',submittedAt:now.toISOString()};
  saveState(root,state);
  try {
    const ticket=await client.submit(frozen.plan.text,{attentionSnapshotPaths:frozen.plan.attentionSnapshotPaths,operatorNotifications:def.review.mode==='items',managedJobs:false});
    if(typeof ticket!=='string'||!ticket)throw new Error('Missing ticket id');
    state.running.ticketId=ticket;state.running.phase='queued';saveState(root,state);
    write(file(root,`${base}/binding.json`),json({taskId:id,runId:frozen.runId,ticketId:ticket,definitionHash:frozen.definitionHash}));
    return {action:'opened',taskId:id,ticketId:ticket,runId:frozen.runId};
  } catch(error) {
    // Submission may have succeeded remotely: never silently submit a duplicate.
    state.running.phase='needs_attention';state.running.error=String(error.message??error);saveState(root,state);
    return {action:'blocked',taskId:id,error:state.running.error};
  }
}
function nextDue(def,now) {
  if(def.trigger.kind==='after-settlement')return new Date(+now+def.trigger.minIntervalHours*3600000).toISOString();
  const anchor=Date.parse(def.trigger.anchor), ms=def.trigger.intervalHours*3600000;
  return new Date(anchor+Math.max(0,Math.floor((+now-anchor)/ms)+1)*ms).toISOString();
}
function finish(root,id,state,frozen,outcome,now) {
  const record={schemaVersion:1,taskId:id,runId:frozen.runId,kind:frozen.kind,ticketId:state.running?.ticketId,status:outcome.status,summary:outcome.summary??'',errors:outcome.errors??[],finishedAt:now.toISOString()};
  const target=file(root,`research/longrun/${id}/runs/${frozen.runId}/outcome.json`);
  const existing=readJSON(target,null);if(!existing)write(target,json(record));
  state.running=null;
  if(outcome.status==='settled')state.failures=0;else if(!['expired','cancelled'].includes(outcome.status))state.failures++;
  if(frozen.kind==='round')state.nextDueAt=nextDue(frozen.definition,now);
  if(state.failures>=2&&state.control==='enabled'){state.control='paused';state.pauseReason='failures';}
  state.updatedAt=now.toISOString();saveState(root,state);
  return {action:'collected',taskId:id,record:existing??record};
}
function apply(root,id,state,frozen,transaction,now) {
  for(const change of transaction.writes) {
    if(!change.path.startsWith(`research/longrun/${id}/artifacts/`))throw new Error('Settlement write outside instance artifacts');
    const target=file(root,change.path), current=read(target,null), digest=current===null?null:hash(current);
    if(digest===change.after)continue;
    if(digest!==change.before)throw new Error(`Settlement conflict: ${change.path}`);
    write(target,change.content);
  }
  transaction.status='applied';write(file(root,`research/longrun/${id}/runs/${frozen.runId}/settlement.json`),json(transaction));
  return finish(root,id,state,frozen,{status:transaction.outcomeStatus??'settled',summary:transaction.summary},now);
}
export async function collectTask(options) {return withLongrunLock(options.root,()=>collectUnlocked(options));}
async function collectUnlocked({root,id,client,now=new Date()}) {
  const state=loadState(root,id), active=state.running;
  if(!active)return {action:'none',taskId:id};
  const base=`research/longrun/${id}/runs/${active.runId}`;
  const frozen=readJSON(file(root,`${base}/draft.json`),null);
  if(!frozen||frozen.taskId!==id||frozen.runId!==active.runId)throw new Error('Frozen run identity mismatch');
  const priorOutcome=readJSON(file(root,`${base}/outcome.json`),null);
  if(priorOutcome)return finish(root,id,state,frozen,priorOutcome,new Date(priorOutcome.finishedAt));
  const transaction=readJSON(file(root,`${base}/settlement.json`),null);
  if(transaction)return apply(root,id,state,frozen,transaction,now);
  if(!active.ticketId)return {action:'blocked',taskId:id,error:'Submission needs inspection; no bound ticket'};
  const snapshot=await client.snapshot(active.ticketId);
  const age=+now-Date.parse(active.submittedAt), limit=frozen.definition.limits;
  if(snapshot.status==='queued'||snapshot.status==='running'||['failed','interrupted'].includes(snapshot.status)) {
    if(snapshot.status==='running'&&(active.phase!=='running'||!active.executionSince))active.executionSince=now.toISOString();
    const timeout=snapshot.status==='queued'?age>limit.queueTimeoutHours*3600000:
      +now-Date.parse(active.executionSince??active.submittedAt)>limit.maxExecutionMinutes*60000;
    if(timeout){await client.cancel(active.ticketId);return finish(root,id,state,frozen,{status:'failed',errors:['Execution or queue timeout']},now);}
    active.phase=snapshot.status;saveState(root,state);return {action:'pending',taskId:id,ticket:snapshot.status};
  }
  if(snapshot.status==='cancelled')return finish(root,id,state,frozen,{status:'cancelled'},now);
  if(!['waiting','completed'].includes(snapshot.status))return {action:'pending',taskId:id,ticket:snapshot.status};
  // Use only allowed regular files within this actual ticket workspace.
  const changes=await client.changes(active.ticketId);
  const errors=changes.filter(c=>!frozen.plan.allowedPaths.includes(c.path)).map(c=>`Out-of-scope change: ${c.path}`);
  if(client.jobs&&(await client.jobs(active.ticketId)).length)errors.push('This execution profile forbids managed jobs');
  let result,memoryOutput;
  try {
    result=JSON.parse(fs.readFileSync(file(snapshot.workspacePath,`${base}/result.json`),'utf8'));
    memoryOutput=fs.readFileSync(file(snapshot.workspacePath,`${base}/memory.md`),'utf8');
  }catch(error){errors.push(`Cannot read result: ${error.message}`);}
  const context={...frozen,ticketId:active.ticketId,result,memoryOutput,snapshot,allowPending:snapshot.status==='waiting'};
  let checked;
  if(!errors.length){checked=getType(frozen.definition.type).validateResult(context);errors.push(...checked.errors);}
  if(errors.length){if(snapshot.status==='waiting')await client.cancel(active.ticketId);return finish(root,id,state,frozen,{status:'invalid',errors},now);}
  let expired=false;
  if(snapshot.status==='waiting') {
    const since=checked.review?.since??snapshot.attentionSnapshots?.at(-1)?.at??active.reviewSince??now.toISOString();
    active.reviewSince??=since;active.phase='awaiting_input';delete active.executionSince;
    if(+now-Date.parse(active.reviewSince)>=frozen.definition.review.timeoutHours*3600000) {
      await client.cancel(active.ticketId);
      expired=true;
    }
    if(!expired){saveState(root,state);return {action:'awaiting_review',taskId:id,runId:active.runId};}
  }
  for(const [name,before]of Object.entries(frozen.baseline)) {
    const current=read(file(root,`research/longrun/${id}/artifacts/${name}`),null);
    if((current===null?null:hash(current))!==before)return finish(root,id,state,frozen,{status:'conflict',errors:[`Artifact changed since run started: ${name}`]},now);
  }
  const plan=getType(frozen.definition.type).planSettlement({...context,expired,validated:checked.value});
  const seen=new Set();
  let writes;
  try { writes=plan.artifacts.map(item=>{
    if(typeof item.path!=='string'||seen.has(item.path)||typeof item.content!=='string')throw new Error('Invalid settlement artifact');seen.add(item.path);
    const target=`research/longrun/${id}/artifacts/${item.path}`, resolved=file(root,target);
    if(!resolved.startsWith(safePath(root,`research/longrun/${id}/artifacts`)+path.sep))throw new Error('Artifact path escapes instance');
    const current=read(resolved,null);
    if((current===null?null:hash(current))!==(frozen.baseline[item.path]??null))throw Object.assign(new Error(`Settlement target changed since run started: ${item.path}`),{code:'LONGRUN_CONFLICT'});
    return {path:target,before:current===null?null:hash(current),after:hash(item.content),content:item.content};
  });
  } catch(error) {
    if(error.code==='LONGRUN_CONFLICT')return finish(root,id,state,frozen,{status:'conflict',errors:[error.message]},now);
    throw error;
  }
  const receipt={schemaVersion:1,key:`${id}:${active.runId}:1`,status:'applying',outcomeStatus:expired?'expired':'settled',summary:plan.summary,writes};
  write(file(root,`${base}/settlement.json`),json(receipt));
  active.phase='applying';saveState(root,state);
  return apply(root,id,state,frozen,receipt,now);
}
export async function tickTask({root,id,client,now=new Date(),open=false}) {
  if(loadState(root,id).running)return collectTask({root,id,client,now});
  return open?startRun({root,id,client,now}):{action:'hold',taskId:id};
}
export function verifyGeneric({root,id}) {
  const errors=[];try {
    definition(root,id);const p=taskPaths(root,id);loadState(root,id);
    if(fs.existsSync(p.runs))for(const name of fs.readdirSync(p.runs)) {
      if(!/^(R|RV)\d{4,}$/.test(name))continue;
      const outcome=readJSON(file(root,`research/longrun/${id}/runs/${name}/outcome.json`),null);
      if(outcome?.status==='settled'&&readJSON(file(root,`research/longrun/${id}/runs/${name}/settlement.json`),null)?.status!=='applied')errors.push(`${name}: settlement receipt missing`);
    }
  }catch(error){errors.push(error.message);}return {ok:!errors.length,errors};
}
