import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { aiFixture } from './helpers/ai-fixture.mjs';
import { waitFor as wait } from './helpers/wait.mjs';
const directory=resolve('test-results/lifecycle-'+randomUUID());
const real=process.argv.includes('--codex');
const sleep=process.argv.includes('--sleep');
assert.ok(!(real&&sleep));
await mkdir(directory,{recursive:true});
const csc='C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
for(const name of ['Runner','Broker']){
  execFileSync(csc,['/nologo','/define:'+(real?'FIXTURE;CODEX_PROBE':sleep?'FIXTURE;SLEEP_PROBE':'FIXTURE'),'/out:'+join(directory,name+'.exe'),
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
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
let descendants;
try{
  const broker=launch(join(directory,'Broker.exe'),[String(server.address().port),nonce]);
  let log='';broker.stdout.on('data',c=>log+=c);broker.stderr.on('data',c=>log+=c);
  await wait(()=>{if(broker.exitCode!==null)throw Error(log);return log.includes('listening');});
  let previousExport=exportId;
  for(const mode of real?['termination']:sleep?['sleep']:['termination','timeout','failure']) {
  const currentExport=['termination','sleep'].includes(mode)?exportId:'export-timeout-'+randomUUID();
  if(['timeout','failure'].includes(mode)) {
    fx.advance(2*60*60*1000);await fx.cron();
    assert.equal(fx.row(previousExport).status,'failed');
    assert.equal(fx.row(previousExport).failure_code,'timeout');
    assert.equal((await fx.session('/api/ai/jobs','POST',fx.seedBatch(currentExport))).status,201);
  }
  const marker=join(directory,mode+'.json');
  const runner=launch(join(directory,'Runner.exe'),[resolve('.'),process.execPath,pipe,sid],{...process.env,PA_TEST_REAL_CODEX:real?'1':'',PA_TEST_PROCESS_MARKER:marker,PA_TEST_EXIT_AFTER_SPAWN:mode==='failure'?'1':''});
  let error='';runner.stderr.on('data',c=>error+=c);
  await wait(async()=>{try{descendants=JSON.parse(await readFile(marker,'utf8'));return true;}catch{if(runner.exitCode!==null)throw Error(error);return false;}});
  if(mode!=='failure'){assert.ok(alive(descendants.parent));assert.ok(alive(descendants.child));}
  if(real){
    await wait(async()=>{
      try{const tool=JSON.parse(await readFile(marker+'.tool','utf8'));descendants.tool=tool.pid;return true;}catch{}
      const code=await readFile(marker+'.exit','utf8').catch(()=>null);
      if(code!==null)throw Error('Real Codex exited before starting the shell probe (code '+code+'); inspect local diagnostic '+marker+'.codex.log');
      return false;
    },180000);
    assert.ok(alive(descendants.tool),'real Codex shell tool must be running before cancellation');
  }
  if(mode==='termination')runner.kill();
  const waitingAt=Date.now();
  if(sleep)console.log('SLEEP NOW: put Windows to sleep within 45 seconds, wait at least 75 seconds, then wake. Synthetic executor is running; local fixture deadline is 60 seconds.');
  await wait(()=>runner.exitCode!==null||runner.signalCode!==null,sleep?180000:10000,{resumeGrace:sleep});
  if(mode!=='termination')assert.equal(runner.exitCode,4);
  await wait(()=>Object.values(descendants).every(pid=>!alive(pid)),5000);
  assert.equal(fx.uploads.length,0);
  assert.equal(fx.row(currentExport).status,'running','abnormal stop must leave recovery to Worker timeout');
  if(sleep){
    await mkdir(resolve('test-results/windows-events'),{recursive:true});
    await writeFile(resolve('test-results/windows-events/Sleep-pending.json'),JSON.stringify({waitingAt,checkedAt:Date.now(),exitCode:runner.exitCode,patches:0,descendantsReclaimed:true},null,2));
    let times;
    // Power-Troubleshooter can publish after the runner has already exited on resume.
    await wait(()=>{
      const raw=execFileSync('powershell.exe',['-NoProfile','-Command',"$e=Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='Microsoft-Windows-Power-Troubleshooter';Id=1} -MaxEvents 1; $xml=[xml]$e.ToXml(); $times=@{}; foreach($d in $xml.Event.EventData.Data){if($d.Name -in @('SleepTime','WakeTime')){$times[$d.Name]=$d.'#text'}}; $times|ConvertTo-Json -Compress"],{encoding:'utf8'});
      times=JSON.parse(raw);return Date.parse(times.SleepTime)>=waitingAt;
    },60000,{pause:()=>new Promise(r=>setTimeout(r,1000))});
    assert.ok(Date.parse(times.SleepTime)<waitingAt+60000,'executor must still be running when sleep began');
    assert.ok(Date.parse(times.WakeTime)>=waitingAt+60000,'wake must cross the shortened fixture deadline');
    await writeFile(resolve('test-results/windows-events/Sleep.json'),JSON.stringify({pass:true,...times,shortenedLocalDeadlineSeconds:60,patches:0,descendantsReclaimed:true},null,2));
  }
  console.log('PASS runner '+mode+' reclaims executor and '+(real?'real Codex CLI and live shell tool':'grandchild')+', with no write or replay');
  previousExport=currentExport;
  }
}finally{
  for(const pid of Object.values(descendants||{})){try{process.kill(pid);}catch{}}
  for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill();
  server.closeAllConnections();await new Promise(r=>server.close(r));fx.db.database.close();
}

