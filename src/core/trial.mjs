import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createTask, enableTask, readDefinition, safePath, taskPaths } from './definitions.mjs';
import { resolveLayout, withTaskLayout } from '../layout.mjs';
import { resolveRuntimeLayout, checkedPath } from '../service-runtime.mjs';
import { DECISION_OPTIONS } from '../types/common.mjs';
import { startRun, collectTask, verifyGeneric } from './runtime.mjs';

/** Offline fixture rehearsal only. No production service, answers, or output are touched. */
export function trialTask(options) { return withTaskLayout(options.root, () => trialInLayout(options)); }
async function trialInLayout({root,id,result,memory,answers,now=new Date(),runtimeHome}) {
  const definition=readDefinition(root,id);
  const layout=resolveLayout(root);
  const trialDirectory=checkedPath(path.join(resolveRuntimeLayout({projectRoot:root,runtimeHome}).runtimeDir,'trials',`${id}-${randomUUID()}`),{directory:true});
  const target=path.join(trialDirectory,'project');
  fs.mkdirSync(target,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(target,'longrun.config.json'),JSON.stringify({schemaVersion:1,tasksDir:layout.tasksDir})+'\n',{flag:'wx'});
  for(const input of definition.inputs){const out=path.join(target,input);fs.mkdirSync(path.dirname(out),{recursive:true});fs.copyFileSync(safePath(root,input),out);}
  const brief=fs.readFileSync(taskPaths(root,id).brief,'utf8');
  await createTask({root:target,id,definition,brief,now});
  await enableTask({root:target,id,reason:'Offline fixture trial; no production authorization',now});
  let text;const ticketId=`trial-${randomUUID()}`;
  const workspace=path.join(trialDirectory,'workspace');fs.mkdirSync(workspace);
  const client={submit:async value=>{text=value;return ticketId;},snapshot:async()=>snapshot,changes:async()=>changed,jobs:async()=>[],cancel:async()=>{}};
  const run=await startRun({root:target,id,client,now});
  const base=`${layout.tasksDir}/${id}/runs/${run.runId}`;
  const fixture=structuredClone(result);const at=now.toISOString();
  const captures=[];
  if(definition.review.mode==='items'&&fixture.items?.length){
    const pending=structuredClone(fixture);for(const item of pending.items){item.status='pending';delete item.reason;}
    const content=JSON.stringify(pending)+'\n';
    captures.push({ticketId,attentionId:'trial-attention',at,files:[{path:`${base}/result.json`,content,sha256:createHash('sha256').update(content).digest('hex')}],decision:{items:pending.items.map(i=>({id:i.id,title:i.title,summary:i.summary})),options:DECISION_OPTIONS,reason:'required'}});
  }
  const snapshot={status:'completed',workspacePath:workspace,attentionSnapshots:captures,answers:answers?[{ticketId,attentionId:'trial-attention',kind:'structured',via:'offline-fixture',at,answers}]:[]};
  const changed=['result.json','memory.md'].map(name=>({path:`${base}/${name}`}));
  fs.mkdirSync(path.join(workspace,base),{recursive:true});
  fs.writeFileSync(path.join(workspace,base,'result.json'),JSON.stringify(fixture)+'\n');
  fs.writeFileSync(path.join(workspace,base,'memory.md'),memory??'# Memory\n\nOffline trial.\n');
  fs.writeFileSync(path.join(target,'TRIAL.json'),JSON.stringify({kind:'offline-fixture',production:false,taskId:id,at},null,2));
  const outcome=await collectTask({root:target,id,client,now});
  return {mode:'offline-fixture',production:false,directory:target,result:outcome,verification:verifyGeneric({root:target,id})};
}
