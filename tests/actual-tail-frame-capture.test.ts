import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ArtifactRepository, PendingArtifactInput } from "../src/application/ports/artifact-repository.js";
import type { ArtifactRecord } from "../src/domain/schemas.js";
import { sha256Bytes } from "../src/domain/hashing.js";
import { captureActualClipTailFrame } from "../src/application/services/actual-tail-frame-capture.js";

const run=promisify(execFile);
class MemoryArtifacts implements ArtifactRepository {
  data=new Map<string,ArtifactRecord>();
  async createPending(input:PendingArtifactInput){
    const value:ArtifactRecord={id:input.id,projectId:input.projectId,kind:input.kind,relativePath:input.relativePath,
      ...(input.mimeType?{mimeType:input.mimeType}:{}),
      integrityStatus:"PENDING",immutable:true,createdAt:"2026-10-10T00:00:00.000Z"};
    this.data.set(value.id,value);return value;
  }
  async markReady(id:string,fields:{sha256:string,sizeBytes:number,mimeType?:string}){
    const current=this.data.get(id)!;
    const v:ArtifactRecord={...current,...fields,integrityStatus:"READY"};this.data.set(id,v);return v;
  }
  async markMissing(id:string){
    const v:ArtifactRecord={...this.data.get(id)!,integrityStatus:"MISSING"};this.data.set(id,v);return v;
  }
  async markCorrupt(id:string){
    const v:ArtifactRecord={...this.data.get(id)!,integrityStatus:"CORRUPT"};this.data.set(id,v);return v;
  }
  async findById(id:string){return this.data.get(id)??null;}
  async listByProject(projectId:string,kind?:ArtifactRecord["kind"]){
    return [...this.data.values()].filter(v=>v.projectId===projectId&&(!kind||v.kind===kind));
  }
  async listPending(){return [...this.data.values()].filter(v=>v.integrityStatus==="PENDING");}
}

test("actual downloaded MP4 tail is extracted once into immutable evidence; never pre-approves",async()=>{
  const projectsRoot=await fs.mkdtemp(path.join(os.tmpdir(),"pvs-continuity-tail-"));
  const root=path.join(projectsRoot,"test-project");
  const relativePath="outputs/clip-1/attempt-1.mp4";
  const videoPath=path.join(root,relativePath);
  await fs.mkdir(path.dirname(videoPath),{recursive:true});
  try {
    await run("ffmpeg",["-hide_banner","-loglevel","error","-f","lavfi","-i",
      "color=c=red:s=120x200:r=10","-t","1.5","-pix_fmt","yuv420p","-y",videoPath],
      {windowsHide:true,timeout:30000});
    const video=await fs.readFile(videoPath);
    const artifacts=new MemoryArtifacts();
    const videoArtifact:ArtifactRecord={
      id:"video-1",projectId:"test-project",kind:"GENERATED_VIDEO",relativePath,
      sha256:sha256Bytes(video),sizeBytes:video.length,mimeType:"video/mp4",integrityStatus:"READY",
      immutable:true,createdAt:"2026-10-10T00:00:00.000Z"
    };
    artifacts.data.set(videoArtifact.id,videoArtifact);
    const params={projectId:"test-project",projectsRoot,artifacts,videoArtifact,
      attempt:{id:"attempt-1",projectId:"test-project",clipId:"clip-1",outputArtifactId:videoArtifact.id}};
    const a=await captureActualClipTailFrame(params);
    assert.equal(a.observation.analysisStatus,"PENDING");
    assert.equal(a.observation.mediaSha256,videoArtifact.sha256);
    assert.ok(a.observation.tailFrameSha256);
    assert.ok(a.observation.tailFrameTimestampMs>1000);
    const image=await artifacts.findById(a.observation.tailFrameArtifactId);
    assert.equal(image?.mimeType,"image/png");
    assert.equal(image?.integrityStatus,"READY");
    const b=await captureActualClipTailFrame(params);
    assert.deepEqual(b,a,"repeat reads the original evidence instead of overwriting or generating a second frame");
    assert.equal(artifacts.data.size,3);
    const savedEvidence=await artifacts.findById(a.evidenceArtifactId);
    assert.ok(savedEvidence);
    const evidenceFile=path.join(root,savedEvidence.relativePath);
    const prior=await fs.readFile(evidenceFile);
    await fs.writeFile(evidenceFile,Buffer.from(prior.toString("utf8").replace('"PENDING"','"REVIEWED"')));
    await assert.rejects(captureActualClipTailFrame(params),/证据哈希/);
    await fs.writeFile(evidenceFile,prior);
    await assert.rejects(
      captureActualClipTailFrame({...params,videoArtifact:{...videoArtifact,sha256:"f".repeat(64)}}),
      /原视频已更改|旧尾帧记录与当前已生成视频不匹配/
    );
  }finally {
    await fs.rm(projectsRoot,{recursive:true,force:true});
  }
});
