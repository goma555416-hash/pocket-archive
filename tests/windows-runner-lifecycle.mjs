import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { aiFixture } from './helpers/ai-fixture.mjs';
const directory=resolve('test-results/lifecycle-'+randomUUID());
await mkdir(directory,{recursive:true});
const csc='C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
for(const name of ['Runner','Broker']){
  execFileSync(csc,['/nologo','/define:FIXTURE','/out:'+join(directory,name+'.exe'),
    '/r:System.Net.Http.dll','/r:System.Web.Extensions.dll','/r:System.ServiceProcess.dll',resolve('scripts/windows/'+name+'.cs')]);
}
const fx=await aiFixture({dispatchMode:'poll'}),token=await fx.newAgentToken();
const exportId='export-lifecycle-'+randomUUID();
await fx.session('/api/ai/jobs','POST',fx.seedBatch(exportId));
const server=createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);
  const response=await fx.call(req.url,{method:req.method,headers:{Authorization:'Bearer '+token},...(chunks.length?{body:Buffer.concat(chunks)}:{})});
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const nonce=randomUUID(),pipe='PocketArchiveBroker-'+nonce.replaceAll('-','');
const sid=execFileSync('whoami',['/user','/fo','csv','/nh'],{encoding:'utf8'}).match(/S-1-5-[0-9-]+/)[0];
const children=[];
const launch=(file,args,env=process.env)=>{const child=spawn(file,args,{env,windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(child);return child;};
const wait=async(fn,ms=10000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Lifecycle assertion timed out');};
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
let descendants;
try{
  const broker=launch(join(directory,'Broker.exe'),[String(server.address().port),nonce]);
  let log='';broker.stdout.on('data',c=>log+=c);broker.stderr.on('data',c=>log+=c);
  await wait(()=>{if(broker.exitCode!==null)throw Error(log);return log.includes('listening');});
  let previousExport=exportId;
  for(const mode of ['termination','timeout','failure']) {
  const currentExport=mode==='termination'?exportId:'export-timeout-'+randomUUID();
  if(mode!=='termination') {
    fx.advance(2*60*60*1000);await fx.cron();
    assert.equal(fx.row(previousExport).status,'failed');
    assert.equal(fx.row(previousExport).failure_code,'timeout');
    assert.equal((await fx.session('/api/ai/jobs','POST',fx.seedBatch(currentExport))).status,201);
  }
  const marker=join(directory,mode+'.json');
  const runner=launch(join(directory,'Runner.exe'),[resolve('.'),process.execPath,pipe,sid],{...process.env,PA_TEST_PROCESS_MARKER:marker,PA_TEST_EXIT_AFTER_SPAWN:mode==='failure'?'1':''});
  let error='';runner.stderr.on('data',c=>error+=c);
  await wait(async()=>{try{descendants=JSON.parse(await readFile(marker,'utf8'));return true;}catch{if(runner.exitCode!==null)throw Error(error);return false;}});
  if(mode!=='failure'){assert.ok(alive(descendants.parent));assert.ok(alive(descendants.child));}
  if(mode==='termination')runner.kill();
  await wait(()=>runner.exitCode!==null||runner.signalCode!==null);
  if(mode!=='termination')assert.equal(runner.exitCode,4);
  await wait(()=>!alive(descendants.parent)&&!alive(descendants.child),3000);
  assert.equal(fx.uploads.length,0);
  assert.equal(fx.row(currentExport).status,'running','abnormal stop must leave recovery to Worker timeout');
  console.log('PASS runner '+mode+' reclaims executor and grandchild, with no write or replay');
  previousExport=currentExport;
  }
}finally{
  for(const pid of Object.values(descendants||{})){try{process.kill(pid);}catch{}}
  for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill();
  server.closeAllConnections();await new Promise(r=>server.close(r));fx.db.database.close();
}

