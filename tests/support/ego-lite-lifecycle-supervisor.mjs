// Trusted test controller around the production supervisor; no application bypass.
import fs from 'node:fs';
import path from 'node:path';
import {Readable} from 'node:stream';
import {startWorkbench} from '../../scripts/ego-lite-supervisor.mjs';
import {installationFile} from '../../scripts/ego-lite-installation.mjs';
const workbench=await startWorkbench({env:process.env});let closing;
const originalStream=fs.createReadStream,pinnedFiles=new Set(JSON.parse(fs.readFileSync(installationFile,'utf8')).pins.map(p=>p.file));let pinVerification,releasePin;
const send=value=>{if(process.connected)process.send(value,()=>{});};
const stop=()=>closing??=(async()=>{
  const receipt=await workbench.stop();fs.createReadStream=originalStream;fs.writeFileSync(path.join(workbench.session,'test-application-output.json'),JSON.stringify({stderr:workbench.application.stderr,stdout:workbench.application.stdout}));return {...receipt,pinVerification};
})();
process.on('message',message=>{
  if(message?.op==='snapshot'){send({requestId:message.requestId,result:{...workbench.snapshot(),pinVerification}});return;}
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
