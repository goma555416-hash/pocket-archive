import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { aiFixture } from './helpers/ai-fixture.mjs';
import { createEntry, createInboxEnvelope } from '../lib.mjs';
const real = process.argv.includes('--codex');
const taskDefinition=await readFile(new URL('../scripts/windows/task-definition.ps1',import.meta.url),'utf8');
execFileSync('powershell.exe',['-NoProfile','-Command',taskDefinition+`
$ErrorActionPreference='Stop'
$scheduler=New-Object -ComObject Schedule.Service
$definition=$scheduler.NewTask(0)
$definition.XmlText=Get-RunnerTaskXml -Executable 'C:\\fixture & test\\Runner.exe' -Arguments '"a & b" --event' -WorkingDirectory 'C:\\fixture & test' -UserSid ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
if($definition.Triggers.Count -ne 3 -or $definition.Triggers.Item(1).Type -ne 9 -or $definition.Triggers.Item(2).Type -ne 11 -or $definition.Triggers.Item(3).Type -ne 0 -or $definition.Principal.RunLevel -ne 0 -or $definition.Settings.MultipleInstances -ne 2 -or $definition.Settings.WakeToRun -or $definition.Settings.RestartCount -ne 0){throw 'Invalid event task contract'}
if($definition.Actions.Item(1).Path -ne 'C:\\fixture & test\\Runner.exe'){throw 'XML escaping failed'}
foreach($trigger in $definition.Triggers){if($trigger.Repetition.Interval){throw 'Periodic triggers forbidden'}}
`],{stdio:'pipe'});
const root=resolve('.');
const out=resolve('test-results/windows-build');
await mkdir(out,{recursive:true});
const csc='C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
execFileSync(csc,['/nologo','/define:FIXTURE','/out:'+join(out,'BrokerFixture.exe'),'/r:System.Net.Http.dll','/r:System.Web.Extensions.dll','/r:System.ServiceProcess.dll',resolve('scripts/windows/Broker.cs')]);
execFileSync(csc,['/nologo',...(real?[]:['/define:FIXTURE']),'/out:'+join(out,'RunnerTest.exe'),resolve('scripts/windows/Runner.cs')]);
const fx=await aiFixture({dispatchMode:'poll'});
const token=await fx.newAgentToken();
const entry=createEntry({url:'https://www.iana.org/help/example-domains',title:'Public test'});
const exportId='export-auto-'+randomUUID();
const inbox=JSON.stringify(createInboxEnvelope([entry],exportId));
const payload=fx.seedBatch(exportId,{itemIds:[entry.id],inboxContent:inbox});
await fx.session('/api/ai/jobs','POST',payload);
const batches=[payload];
if(!real)for(let i=0;i<2;i++){
  fx.advance(1000);
  const id='export-auto-'+randomUUID(),item=createEntry({url:'https://example.org/'+i,title:'Synthetic'});
  const batch=fx.seedBatch(id,{itemIds:[item.id],inboxContent:JSON.stringify(createInboxEnvelope([item],id))});
  assert.equal((await fx.session('/api/ai/jobs','POST',batch)).status,201);batches.push(batch);
}
let offline=true,claims=0,requests=0,busy=false,expireBeforeSubmit=false,dropAcknowledgement=false,uncertainReadBack=false;
const server=createServer(async(req,res)=>{
  requests++;
  if(offline){res.writeHead(503).end();return;}
  if(busy){res.writeHead(409).end();return;}
  assert.equal(req.headers.authorization,'Bearer fixture-only');
  const chunks=[];for await(const c of req)chunks.push(c);
  if(req.url==='/api/ai/agent/claim')claims++;
  if(expireBeforeSubmit && req.url.includes('/result'))fx.advance(61*60_000);
  if(uncertainReadBack && req.url.includes('/result'))fx.setReadBack('THROW');
  const response=await fx.call(req.url,{method:req.method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(chunks.length?{body:Buffer.concat(chunks)}:{})});
  if(!response.ok)console.log('Fixture rejection',response.status,(await response.clone().json()).error?.code);
  if(dropAcknowledgement && req.url.includes('/result')){res.destroy();return;}
  res.writeHead(response.status,Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const nonce=randomUUID(),pipe='PocketArchiveBroker-'+nonce.replaceAll('-','');
const sid=execFileSync('whoami',['/user','/fo','csv','/nh'],{encoding:'utf8'}).match(/S-1-5-[0-9-]+/)[0];
const children=[];
const launch=(exe,args)=>{const p=spawn(exe,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});p.stderr.on('data',c=>process.stderr.write(c));children.push(p);return p;};
const wait=async(fn,ms=120000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,150));}throw Error('Timed out');};
try{
  const broker=launch(join(out,'BrokerFixture.exe'),[String(server.address().port),nonce]);
  let log='';broker.stdout.on('data',c=>log+=c);broker.stderr.on('data',c=>log+=c);
  await wait(()=>{if(broker.exitCode!==null)throw Error(log);return log.includes('listening');});
  const impostor=launch(join(out,'BrokerFixture.exe'),[String(server.address().port),nonce]);
  await wait(()=>impostor.exitCode!==null);
  assert.notEqual(impostor.exitCode,0,'a second server must not acquire the pipe name');
  const runner=launch(join(out,'RunnerTest.exe'),[root,process.execPath,pipe,sid]);
  let failure='';runner.stderr.on('data',c=>{failure+=c;});
  let started='';runner.stdout.on('data',c=>started+=c);
  await wait(()=>started.includes('runner-started'));
  const duplicate=launch(join(out,'RunnerTest.exe'),[root,process.execPath,pipe,sid]);
  await wait(()=>duplicate.exitCode!==null);
  assert.equal(duplicate.exitCode,3);
  await new Promise(r=>setTimeout(r,1000));assert.equal(fx.row(exportId).status,'queued');
  offline=false;
  await wait(()=>{if(runner.exitCode && runner.exitCode!==0)throw Error('Runner failed: '+failure);return batches.every(x=>fx.row(x.exportId).status==='ready');},real?300000:120000);
  assert.equal(fx.uploads.length,batches.length);assert.deepEqual(fx.uploads.map(x=>x.id),batches.map(x=>x.resultFileId));
  await wait(()=>runner.exitCode!==null,10000);
  assert.equal(runner.exitCode,0,'drain exits after an explicit empty queue');
  assert.equal(claims,batches.length+1,'drain all batches followed by one empty-queue check');
  const stop=resolve('private-data/runner.stop');
  await writeFile(stop,'test graceful stop',{flag:'wx'});
  try { await wait(()=>runner.exitCode!==null,10000); assert.equal(runner.exitCode,0); }
  finally { await rm(stop); }
  broker.kill(); await wait(()=>broker.exitCode!==null || broker.signalCode!==null);
  console.log('Restart test: original processes exited');
  const restarted=launch(join(out,'BrokerFixture.exe'),[String(server.address().port),nonce]);
  let restartedLog='';restarted.stdout.on('data',c=>restartedLog+=c);
  await wait(()=>{if(restarted.exitCode!==null)throw Error('Restarted broker exited');return restartedLog.includes('listening');});
  console.log('Restart test: broker listening');
  const resumed=launch(join(out,'RunnerTest.exe'),[root,process.execPath,pipe,sid]);
  await wait(()=>resumed.exitCode!==null);
  assert.equal(resumed.exitCode,0);
  assert.equal(claims,batches.length+2);
  assert.equal(fx.uploads.length,batches.length,'service restart must not replay acknowledged work');
  await writeFile(stop,'test restart stop',{flag:'wx'});
  try { await wait(()=>resumed.exitCode!==null,10000); assert.equal(resumed.exitCode,0); }
  finally { await rm(stop); }
  if(!real){
    for(const mode of ['offline','busy']){
      offline=mode==='offline';busy=mode==='busy';const before=requests;
      const p=launch(join(out,'RunnerTest.exe'),[root,process.execPath,pipe,sid]);
      await wait(()=>p.exitCode!==null,15000);
      assert.equal(p.exitCode,5,mode+' is not an empty queue');
      assert.equal(requests-before,4,'bounded retries');
    }
    offline=false;busy=false;
    // The event debouncer must avoid sequential duplicate starts, even after an empty drain exits.
    const debounce=resolve('private-data/runner-last-event');
    const saved=await readFile(debounce).catch(()=>null);
    try{
      if(saved)await rm(debounce);
      const before=claims;
      for(let n=0;n<2;n++){
        const p=launch(join(out,'RunnerTest.exe'),[root,process.execPath,pipe,sid,'--event']);
        await wait(()=>p.exitCode!==null,10000);assert.equal(p.exitCode,0);
      }
      assert.equal(claims,before+1,'duplicate event must not claim again');
    }finally{if(saved)await writeFile(debounce,saved);else await rm(debounce,{force:true});}
    for(const mode of ['expired','ack-lost','uncertain']){
      fx.advance(60_000);
      console.log('Resume scenario',mode);
      const id='export-resume-'+randomUUID(),item=createEntry({url:'https://example.org/'+mode,title:'Synthetic sleep scenario'});
      const batch=fx.seedBatch(id,{itemIds:[item.id],inboxContent:JSON.stringify(createInboxEnvelope([item],id))});
      assert.equal((await fx.session('/api/ai/jobs','POST',batch)).status,201);
      expireBeforeSubmit=mode==='expired';dropAcknowledgement=mode==='ack-lost';
      uncertainReadBack=mode==='uncertain';fx.setReadBack(null);
      const before=fx.uploads.length;
      const p=launch(join(out,'RunnerTest.exe'),[root,process.execPath,pipe,sid]);
      await wait(()=>p.exitCode!==null,15000);assert.equal(p.exitCode,4);
      assert.equal(fx.uploads.length,before+(mode==='expired'?0:1));
      assert.equal(fx.row(id).status,mode==='ack-lost'?'ready':'failed');
      if(mode!=='ack-lost')assert.equal(fx.row(id).failure_code,mode==='expired'?'timeout':'writeback_uncertain');
      expireBeforeSubmit=false;dropAcknowledgement=false;uncertainReadBack=false;fx.setReadBack(null);
      fx.advance(61*60_000);await fx.cron();
      const again=launch(join(out,'RunnerTest.exe'),[root,process.execPath,pipe,sid]);
      await wait(()=>again.exitCode!==null,10000);assert.equal(again.exitCode,0);
      assert.equal(fx.uploads.length,before+(mode==='expired'?0:1),'resume cannot replay PATCH');
      if(mode==='uncertain'){
        assert.equal(fx.row(id).failure_code,'writeback_uncertain');
        assert.equal((await fx.session('/api/ai/jobs/'+id+'/retry','POST',{})).status,409);
      }
    }
  }
  console.log(real?'PASS scheduled real Codex: one public batch, same-ID write, empty exit, restart without replay':'PASS event drain: multiple batches, empty exit, offline recovery/exhaustion, busy, duplicate events, expired and uncertain sleep recovery, no replay. classifier=deterministic fixture');
}finally{
  for(const p of children)if(p.exitCode===null)p.kill();
  server.closeAllConnections();await new Promise(r=>server.close(r));
  fx.db.database.close();
}
