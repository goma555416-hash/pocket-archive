// Real scheduler invokes this against an empty loopback backend; never the installed service.
import { spawn,execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const source=process.argv[2];
assert.ok(['Logon','Unlock','Resume'].includes(source));
const directory=resolve('test-results/windows-events');await mkdir(directory,{recursive:true});
const sid=execFileSync('whoami',['/user','/fo','csv','/nh'],{encoding:'utf8'}).match(/S-1-5-[0-9-]+/)[0];
let claims=0;const children=[];
const server=createServer((req,res)=>{
  if(req.method!=='POST'||req.url!=='/api/ai/agent/claim'||req.headers.authorization!=='Bearer fixture-only'){res.writeHead(400).end();return;}
  claims++;res.writeHead(204).end();
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const nonce=randomUUID(),pipe='PocketArchiveBroker-'+nonce.replaceAll('-','');
const launch=(file,args)=>{const p=spawn(file,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(p);return p;};
const wait=async(fn)=>{const until=Date.now()+20000;while(Date.now()<until){if(fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Event probe timeout');};
let result={source,startedAt:new Date().toISOString(),pass:false};
try{
  const broker=launch(resolve('test-results/windows-build/BrokerFixture.exe'),[String(server.address().port),nonce]);
  let output='';broker.stdout.on('data',x=>output+=x);broker.stderr.on('data',()=>{});
  await wait(()=>{if(broker.exitCode!==null)throw Error('Fixture broker failed');return output.includes('listening');});
  const runner=launch(resolve('test-results/windows-build/Runner.exe'),[resolve('.'),process.execPath,pipe,sid,'--event']);
  await wait(()=>runner.exitCode!==null);
  assert.equal(runner.exitCode,0);assert.ok(claims===0||claims===1);
  result={...result,pass:true,claims,debounced:claims===0,finishedAt:new Date().toISOString()};
}catch(error){result.error=error.message;process.exitCode=1;}
finally{
  for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill();
  server.closeAllConnections();await new Promise(r=>server.close(r));
  await writeFile(join(directory,source+'.json'),JSON.stringify(result,null,2));
}
