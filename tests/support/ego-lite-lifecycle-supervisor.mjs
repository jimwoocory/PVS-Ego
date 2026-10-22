// Trusted test controller around the production supervisor; no application bypass.
import fs from 'node:fs';
import path from 'node:path';
import {Readable} from 'node:stream';
import {startWorkbench} from '../../scripts/ego-lite-supervisor.mjs';
import {installationFile} from '../../scripts/ego-lite-installation.mjs';
const workbench=await startWorkbench({env:process.env});let closing;
const originalStream=fs.createReadStream,pinnedFiles=new Set(JSON.parse(fs.readFileSync(installationFile,'utf8')).pins.map(p=>p.file));let pinVerification,releasePin;
const originalWrite=fs.writeFileSync;let watchdogProbe;
// Only this trusted controller instruments the fresh generated research entry.
// Installed host files, production options and the OS clock are never changed.
fs.writeFileSync=(file,data,...options)=>{
  if(watchdogProbe&&typeof file==='string'){
    const relative=path.relative(workbench.session,file),parts=relative.split(path.sep);
    const owned=parts.length===2&&/^go-bridge-action-[a-f0-9-]{36}$/.test(parts[0]);
    if(owned&&parts[1]==='host.mjs'){
      const marker='await import(',index=String(data).lastIndexOf(marker);if(index<0)throw Error('RESEARCH_HOST_ENTRY_CHANGED');
      const mode=watchdogProbe.mode,dir=path.dirname(file),out=path.join(dir,'test-clock-probe.json');watchdogProbe.dir=dir;
      // Load the unmodified original host immediately. Buffer only its actual ready
      // line while the watchdog is exercised; never fabricate readiness or leave
      // a pending top-level import across Electron shutdown.
      const sweep=mode==='clock-sweep',duration=sweep?2400:7500;
      const prelude=`import {performance as testClock} from 'node:perf_hooks';const testRealNow=Date.now.bind(Date),testStart=testClock.now(),testSteps=[],testWrite=process.stdout.write.bind(process.stdout),testTimers=[];let testOffset=0,testReleased=false,testObserved=false,testReady;const testRecord=()=>fs.writeFileSync(${JSON.stringify(out)},JSON.stringify({hostPid:process.pid,steps:testSteps,readyReleased:testReleased,originalReadyObserved:testObserved,elapsedMs:testClock.now()-testStart}));process.stdout.write=(chunk,...args)=>{if(String(chunk).startsWith('EGO_WINDOWS_HOST_READY ')){testObserved=true;testRecord();if(!testReleased){testReady=[chunk,...args];return true;}}return testWrite(chunk,...args);};const testStep=offset=>{testOffset=offset;Date.now=()=>testRealNow()+testOffset;let age;try{age=testRealNow()-fs.statSync(${JSON.stringify(path.join(dir,'supervisor-heartbeat'))}).mtimeMs;}catch{}testSteps.push({offset,elapsedMs:testClock.now()-testStart,heartbeatAgeMs:age});testRecord();};testStep(${sweep?3600000:-3600000});${sweep?'testTimers.push(setTimeout(()=>testStep(-3600000),800),setTimeout(()=>testStep(0),1600));':''}testTimers.push(setTimeout(()=>{Date.now=testRealNow;testReleased=true;testRecord();if(testReady)testWrite(...testReady);},${duration}));app.on('before-quit',()=>{for(const timer of testTimers)clearTimeout(timer);testRecord();});`;
      data=String(data).slice(0,index)+prelude+String(data).slice(index);
    }
    if(owned&&/^supervisor-heartbeat(?:\.[a-f0-9-]{36}\.tmp)?$/.test(parts[1])){
      watchdogProbe.writes++;try{
        const beat=JSON.parse(String(data));if(beat.version===1){
          if(!watchdogProbe.readyWrite){try{if(JSON.parse(fs.readFileSync(path.join(path.dirname(file),'test-clock-probe.json'),'utf8')).originalReadyObserved)watchdogProbe.readyWrite=watchdogProbe.writes;}catch{}}
          const corrupt=watchdogProbe.readyWrite&&watchdogProbe.writes>=watchdogProbe.readyWrite+2;
          if(watchdogProbe.mode==='frozen-heartbeat')beat.sequence=0;
          if(corrupt&&watchdogProbe.mode==='regressed-heartbeat')beat.sequence=0;
          if(corrupt&&watchdogProbe.mode==='wrong-lease')beat.leaseId='wrong-test-lease';
          data=JSON.stringify(beat);watchdogProbe.lastPublished=beat;
        }
      }catch{}
    }
  }
  return originalWrite(file,data,...options);
};
const send=value=>{if(process.connected)process.send(value,()=>{});};
const stop=()=>closing??=(async()=>{
  const receipt=await workbench.stop();fs.createReadStream=originalStream;fs.writeFileSync=originalWrite;fs.writeFileSync(path.join(workbench.session,'test-application-output.json'),JSON.stringify({stderr:workbench.application.stderr,stdout:workbench.application.stdout}));return {...receipt,pinVerification,watchdogProbe};
})();
process.on('message',message=>{
  if(message?.op==='snapshot'){send({requestId:message.requestId,result:{...workbench.snapshot(),pinVerification,watchdogProbe}});return;}
  if(['clock-sweep','frozen-heartbeat','regressed-heartbeat','wrong-lease'].includes(message?.op)){
    if(watchdogProbe||workbench.snapshot().active){send({requestId:message.requestId,error:'WATCHDOG_PROBE_ALREADY_ACTIVE'});return;}
    watchdogProbe={mode:message.op,writes:0};send({requestId:message.requestId,result:{enabled:true}});return;
  }
  if(message?.op==='hold-pins'){
    if(pinVerification){send({requestId:message.requestId,error:'PIN_GATE_ALREADY_SET'});return;}
    pinVerification={held:false,released:false,files:0,bytes:0,complete:0};const gate=new Promise(resolve=>releasePin=resolve);
    fs.createReadStream=(file,options)=>{
      if(!pinnedFiles.has(file))return originalStream(file,options);
      const input=originalStream(file,options);pinVerification.files++;
      return Readable.from((async function*(){try{for await(const chunk of input){if(!pinVerification.held){pinVerification.held=true;await gate;}pinVerification.bytes+=chunk.length;yield chunk;}pinVerification.complete++;}finally{input.destroy();}})(),{objectMode:false});
    };
    send({requestId:message.requestId,result:{enabled:true}});return;
  }
  if(message?.op==='release-pins'){if(pinVerification){pinVerification.released=true;releasePin();}send({requestId:message.requestId,result:{released:Boolean(pinVerification)}});return;}
  if(message?.op==='stop')void stop().then(result=>{send({requestId:message.requestId,result});if(process.connected)process.disconnect();}).catch(error=>{send({requestId:message.requestId,error:error.message});process.exitCode=1;if(process.connected)process.disconnect();});
});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void stop().then(()=>{if(process.connected)process.disconnect();}));
process.once('disconnect',()=>void stop());
send({ready:{origin:workbench.origin,sourceUrl:workbench.sourceUrl,session:workbench.session}});
