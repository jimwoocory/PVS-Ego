// Original guarded application and default dependencies, on a new synthetic DB only.
import '../scripts/isolation-guard.mjs';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {createAppServer,createDefaultDependencies} from '../dist/src/web/server.js';
import {prisma} from '../dist/src/adapters/db/prisma-client.js';
await assert.rejects(createDefaultDependencies().agentCycles.catalog.get('research.collect-evidence').run({projectId:'synthetic-default-deny',cycleId:'synthetic-cycle',actionId:'synthetic-action',confirmed:true},{goal:'Synthetic local source only',sourceUrls:[{url:'http://127.0.0.1:3097/bridge-fixture/synthetic-local-only',sourceType:'USER_URL'}]}),/尚未接入/);
const server=createAppServer(createDefaultDependencies({egoLiteReadSource:async({source,projectId,runId,action})=>{
  if(!action.confirmed||action.projectId!==projectId||!runId||source.url!=='http://127.0.0.1:3097/bridge-fixture/synthetic-local-only')throw Error('SYNTHETIC_EGO_SCOPE_DENIED');
  const text='Synthetic local Ego Lite research adapter response. This text is a fixture, not a real browser observation or product fact. '.repeat(3);
  return {sourceUrl:source.url,finalUrl:source.url,title:'Synthetic local fixture',text,excerpt:text,fetchedAt:new Date().toISOString(),sourceType:source.sourceType,contentHash:createHash('sha256').update(text).digest('hex')};
}}));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
console.log(JSON.stringify({ready:true,origin:'http://127.0.0.1:'+server.address().port}));
const input=createInterface({input:process.stdin});
input.once('line',async line=>{
  if(line!=='close')throw Error('FIXTURE_CONTROL_DENIED');
  await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
  await prisma.$disconnect();input.close();process.stdin.destroy();
});
