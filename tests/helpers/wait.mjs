export async function waitFor(check, milliseconds=10000, {
  resumeGrace=false, now=Date.now,
  pause=()=>new Promise(resolve=>setTimeout(resolve,100))
}={}) {
  let previous=now(),deadline=previous+milliseconds;
  for(;;){
    const at=now();
    // Manual sleep probes must allow process-exit notifications to arrive after a long suspension.
    if(resumeGrace && at-previous>1000)deadline=at+10000;
    if(await check())return;
    if(at>=deadline)throw Error('Lifecycle assertion timed out');
    previous=at;
    await pause();
  }
}
