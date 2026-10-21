// Trusted test controller around the production supervisor; no application bypass.
import fs from 'node:fs';
import path from 'node:path';
import {startWorkbench} from '../../scripts/ego-lite-supervisor.mjs';
const workbench=await startWorkbench({env:process.env});let closing;
const send=value=>{if(process.connected)process.send(value,()=>{});};
const stop=()=>closing??=(async()=>{
  const receipt=await workbench.stop();fs.writeFileSync(path.join(workbench.session,'test-application-output.json'),JSON.stringify({stderr:workbench.application.stderr,stdout:workbench.application.stdout}));return receipt;
})();
process.on('message',message=>{
  if(message?.op==='snapshot'){send({requestId:message.requestId,result:workbench.snapshot()});return;}
  if(message?.op==='stop')void stop().then(result=>{send({requestId:message.requestId,result});if(process.connected)process.disconnect();}).catch(error=>{send({requestId:message.requestId,error:error.message});process.exitCode=1;if(process.connected)process.disconnect();});
});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void stop().then(()=>{if(process.connected)process.disconnect();}));
process.once('disconnect',()=>void stop());
send({ready:{origin:workbench.origin,sourceUrl:workbench.sourceUrl,session:workbench.session}});
