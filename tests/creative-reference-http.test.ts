import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {Script} from "node:vm";
import fs from "node:fs/promises";
import path from "node:path";
import {referenceFixture} from "./creative-reference-fixture.js";
import {handleCreativeReferenceHttp} from "../src/web/creative-reference-http.js";
import {renderCreativeReferencePage} from "../src/web/creative-reference-ui.js";

test("reference HTTP read is side-effect free, escapes text, and requires exact rights/revision for bulk approval",{timeout:90000},async()=>{
 const f=await referenceFixture();await f.service.capture({...f.captured,title:'"><script>bad()</script>'});
 let collectCalls=0;
 const d={productFlow:f.productFlow,creativeReferences:f.service,collectCreativeReferences:async()=>{collectCalls++;return {mediaCount:0,failures:[]}}};
 const server=http.createServer(async(req,res)=>{try{if(!await handleCreativeReferenceHttp(req,res,new URL(req.url??"/","http://localhost"),d)){res.writeHead(404);res.end()}}catch(e){res.writeHead(500,{"content-type":"application/json"});res.end(JSON.stringify({message:String(e)}))}});
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const base="http://127.0.0.1:"+(server.address() as {port:number}).port,prefix=base+"/api/projects/"+f.projectId+"/creative-references";
 const post=(suffix:string,data:unknown,headers:Record<string,string>={})=>fetch(prefix+suffix,{method:"POST",headers:{"content-type":"application/json",...headers},body:JSON.stringify(data)});
 try{
  const page=await fetch(base+"/projects/"+f.projectId+"/creative-references");assert.equal(page.status,200);const html=await page.text();assert.ok(!html.includes('<script>bad()'));
  for(const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g))new Script(match[1]!);
  assert.equal((await f.repo.state(f.projectId)).revision,0);assert.equal(collectCalls,0);
  const json=await(await fetch(prefix)).json() as any,c=json.candidates[0];
  const input={expectedRevision:json.revision,expectedTruthHash:json.truthHash,acknowledgeRights:true,changes:[{candidateId:c.id,candidateHash:c.contentHash,decision:"INCLUDE",role:"PRODUCT_ANGLE"}]};
  assert.equal((await post('/review',{...input,acknowledgeRights:false})).status,400);
  assert.equal((await post('/review',input,{origin:"https://other-site.invalid"})).status,400);
  assert.equal((await post('/review',input)).status,200);assert.equal((await post('/review',input)).status,400);
  assert.equal((await fetch(base+"/api/projects/other/creative-references")).status,404);
  assert.equal((await post('/collect',{})).status,200);assert.equal(collectCalls,1);
  const data=await f.service.pageData(f.projectId),rendered=renderCreativeReferencePage({id:f.projectId,name:"fixture"},data);assert.match(rendered,/已在确认集合中/);
  const primary=(await f.productInput.latest(f.projectId))!.assets[0]!,source=(await f.artifacts.findById(primary.artifactId))!;
  await fs.rename(path.join(f.projectsRoot,f.projectId,source.relativePath),path.join(f.root,"missing-primary-test.png"));
  const unavailable=await f.service.pageData(f.projectId);assert.match(unavailable.identityBlocker!,/缺失/);assert.ok(unavailable.candidates.every(c=>!c.availableRoles.length));
  const degraded=await fetch(base+"/projects/"+f.projectId+"/creative-references");assert.equal(degraded.status,200);assert.match(await degraded.text(),/本页保留预览/);
  await assert.rejects(f.service.current(f.projectId),/缺失/);
 }finally{await new Promise<void>(r=>server.close(()=>r()));await f.cleanup()}
});
