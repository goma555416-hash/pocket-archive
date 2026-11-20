import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { aiFixture } from './helpers/ai-fixture.mjs';
import { createEntry, createInboxEnvelope } from '../lib.mjs';
const real = process.argv.includes('--codex');
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
let offline=true,claims=0;
const server=createServer(async(req,res)=>{
  if(offline){res.writeHead(503).end();return;}
  assert.equal(req.headers.authorization,'Bearer fixture-only');
  const chunks=[];for await(const c of req)chunks.push(c);
  if(req.url==='/api/ai/agent/claim')claims++;
  const response=await fx.call(req.url,{method:req.method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(chunks.length?{body:Buffer.concat(chunks)}:{})});
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
  await wait(()=>{if(failure.includes('InvalidOperationException'))throw Error('Executor failed; inspect private diagnostic');return fx.row(exportId).status==='ready';},real?300000:120000);
  assert.equal(fx.uploads.length,1);assert.equal(fx.uploads[0].id,payload.resultFileId);
  assert.equal(claims,1);
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
  await wait(()=>claims>1);
  assert.equal(fx.uploads.length,1,'service restart must not replay acknowledged work');
  await writeFile(stop,'test restart stop',{flag:'wx'});
  try { await wait(()=>resumed.exitCode!==null,10000); assert.equal(resumed.exitCode,0); }
  finally { await rm(stop); }
  console.log('PASS Windows automatic runner: offline recovery, exclusive process, pipe binding, executor, one same-ID write. classifier='+ (real?'Codex':'deterministic fixture'));
}finally{
  for(const p of children)if(p.exitCode===null)p.kill();
  server.closeAllConnections();await new Promise(r=>server.close(r));
  fx.db.database.close();
}
