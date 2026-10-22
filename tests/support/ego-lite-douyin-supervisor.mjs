import fs from 'node:fs';import {Readable} from 'node:stream';
import {startWorkbench} from '../../scripts/ego-lite-supervisor.mjs';
let workbench,stopping;const originalStream=fs.createReadStream;
const send=value=>{if(process.connected)process.send(value,()=>{});};
const stop=()=>stopping??=(async()=>{if(!workbench)return;const receipt=await workbench.stop();send({stopped:receipt});if(process.connected)process.disconnect();})();
process.on('message',message=>{
 if(message.init&&!workbench){void startWorkbench({env:process.env,opsFixture:message.init.fixture}).then(value=>{workbench=value;send({ready:{origin:value.origin,session:value.session}});}).catch(error=>{send({error:error.message});process.exitCode=1;if(process.connected)process.disconnect();});return;}
 if(message.op==='pin-delay'){fs.createReadStream=message.enabled?(...args)=>Readable.from((async function*(){for await(const chunk of originalStream(...args)){await new Promise(r=>setTimeout(r,10));yield chunk;}})()):originalStream;send({requestId:message.requestId,result:{enabled:Boolean(message.enabled)}});return;}
 if(message.op==='snapshot'){send({requestId:message.requestId,result:workbench.snapshot()});return;}
 if(message.op==='stop')void stop();
});
process.once('disconnect',()=>void stop());
