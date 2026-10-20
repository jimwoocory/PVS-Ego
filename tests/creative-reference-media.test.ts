import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {referenceFixture} from "./creative-reference-fixture.js";
import {sampleResearchReferenceFrames,referencePixelSignature,nearDuplicatePixels} from "../src/adapters/media/research-reference-frames.js";
import {DefaultResearchMediaAnalyzer} from "../src/adapters/research/research-media-analyzer.js";
import type {StructuredAiRequest} from "../src/application/ports/structured-ai-runtime.js";
import {sha256Bytes} from "../src/domain/hashing.js";
const exec=promisify(execFile);

test("reference frame capture retains source media and seek targets, and deduplicates identical sampled visuals",{timeout:90000},async()=>{
 const f=await referenceFixture();try{
  const video=path.join(f.root,"reference.mp4");
  await exec(process.env.FFMPEG_PATH??"ffmpeg",["-hide_banner","-loglevel","error","-f","lavfi","-i","color=c=gray:s=512x512:r=10:d=2","-an","-c:v","libx264","-pix_fmt","yuv420p","-y",video],{windowsHide:true,timeout:30000});
  const frames=await sampleResearchReferenceFrames(video,path.join(f.root,"frames"),3);assert.deepEqual(frames.map(f=>f.timestampMs),[0,950,1900]);
  const sourceBytes=await fs.readFile(video),images=await Promise.all(frames.map(async f=>({bytes:await fs.readFile(f.path),mimeType:f.mimeType,timestampMs:f.timestampMs,frameIndex:f.frameIndex})));
  await f.service.capture({...f.captured,sourceBytes,sourceMimeType:"video/mp4",mediaUrl:"https://example.com/clip.mp4",images});
  const candidates=await f.repo.candidates(f.projectId);assert.equal(candidates.length,3);assert.equal(candidates.filter(c=>c.status==="REVIEWABLE").length,1);assert.equal(candidates.filter(c=>c.status==="DUPLICATE").length,2);
  assert.equal(f.ai.calls.length,1);assert.ok(candidates.every(c=>c.timestampMethod==="EXPLICIT_SEEK_TARGET"));
  const source=(await f.artifacts.findById(candidates[0]!.sourceArtifactId))!;
  await fs.rm(video);await fs.rm(path.join(f.root,"frames"),{recursive:true});
  assert.equal(sha256Bytes(await fs.readFile(path.join(f.projectsRoot,f.projectId,source.relativePath))),sha256Bytes(sourceBytes));
  assert.equal(nearDuplicatePixels(candidates[0]!.pixelSignature!,candidates[1]!.pixelSignature!),true);assert.equal(nearDuplicatePixels("bad","bad"),false);
 }finally{await f.cleanup()}
});

test("existing image Evidence analysis also persists independent reference candidates; transient analysis failure can be retried as a new candidate",{timeout:90000},async()=>{
 const f=await referenceFixture();
 const server=http.createServer((_req,res)=>{res.writeHead(200,{"content-type":"image/png"});res.end(f.bytes)});
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const mediaUrl="http://127.0.0.1:"+(server.address() as {port:number}).port+"/image.png";
 try{
  const oldRuntime={id:"EVIDENCE_FIXTURE",version:"test",generateJson:async(_r:StructuredAiRequest)=>({productIdentityMatch:"CONFIRMED",identityReason:"fixture",summary:"Fixture image evidence",observations:[]})};
  const analyzer=new DefaultResearchMediaAnalyzer(oldRuntime,{allowPrivateNetwork:true},f.service);
  const result=await analyzer.analyze({projectId:f.projectId,runId:f.runId,parentSourceUrl:"https://example.com/product",pageTitle:"fixture",sourceType:"USER_URL",media:[{type:"IMAGE",url:mediaUrl}]});
  assert.equal(result.analyses.length,1);assert.equal(result.analyses[0]!.mediaContext.type,"IMAGE");assert.equal(result.failures.length,0);assert.equal((await f.repo.candidates(f.projectId)).length,1);
  assert.equal(await f.service.current(f.projectId),null);
  f.ai.fail=true;await f.service.capture({...f.captured,mediaUrl:"https://example.com/failure.png"},"failing-operation");
  const failed=(await f.repo.candidates(f.projectId)).find(c=>c.status==="ANALYSIS_FAILED")!;assert.ok(failed);
  assert.ok(failed.blockers.some(message=>/fixture failure/.test(message)));
  f.ai.fail=false;await f.service.reanalyze(f.projectId,failed.id);
  assert.equal((await f.repo.candidate(f.projectId,failed.id))!.status,"ANALYSIS_FAILED");assert.equal((await f.repo.candidates(f.projectId)).length,3);
  assert.ok((await f.repo.candidates(f.projectId)).filter(c=>c.status==="REVIEWABLE").length>=2);
 }finally{await new Promise<void>(r=>server.close(()=>r()));await f.cleanup()}
});
