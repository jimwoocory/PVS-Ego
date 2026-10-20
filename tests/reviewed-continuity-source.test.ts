import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ArtifactRepository, PendingArtifactInput } from "../src/application/ports/artifact-repository.js";
import type { ArtifactRecord, GenerationAttempt, ReviewDecision } from "../src/domain/schemas.js";
import { sha256Bytes } from "../src/domain/hashing.js";
import { loadReviewedContinuitySource } from "../src/application/services/reviewed-continuity-source.js";

const run = promisify(execFile);
class MemoryArtifacts implements ArtifactRepository {
  data = new Map<string, ArtifactRecord>();
  async createPending(input: PendingArtifactInput) {
    const record: ArtifactRecord = { ...input, immutable: true,
      integrityStatus: "PENDING", createdAt: "2026-10-10T00:00:00.000Z" };
    this.data.set(record.id, record);
    return record;
  }
  async markReady(id: string, fields: {sha256:string;sizeBytes:number;mimeType?:string}) {
    const record:ArtifactRecord = {...this.data.get(id)!, ...fields, integrityStatus:"READY"};
    this.data.set(id,record);
    return record;
  }
  async markMissing(id:string) {
    const record:ArtifactRecord={...this.data.get(id)!,integrityStatus:"MISSING"};this.data.set(id,record);return record;
  }
  async markCorrupt(id:string) {
    const record:ArtifactRecord={...this.data.get(id)!,integrityStatus:"CORRUPT"};this.data.set(id,record);return record;
  }
  async findById(id:string) { return this.data.get(id) ?? null; }
  async listByProject(projectId:string,kind?:ArtifactRecord["kind"]) {
    return [...this.data.values()].filter(a=>a.projectId===projectId&&(!kind||a.kind===kind));
  }
  async listPending(){return [...this.data.values()].filter(a=>a.integrityStatus==="PENDING");}
}

test("the latest user ACCEPT alone creates an immutable REVIEWED tail source; REDO/new attempt invalidates",async()=>{
  const projectsRoot=await fs.mkdtemp(path.join(os.tmpdir(),"pvs-reviewed-tail-"));
  const projectId="source-test";const relativePath="videos/one.mp4";
  const file=path.join(projectsRoot,projectId,relativePath);
  await fs.mkdir(path.dirname(file),{recursive:true});
  try {
    await run("ffmpeg",["-hide_banner","-loglevel","error","-f","lavfi","-i",
      "color=c=blue:s=120x200:r=10","-t","1.2","-pix_fmt","yuv420p","-y",file],
      {windowsHide:true,timeout:30000});
    const bytes=await fs.readFile(file);
    const artifacts=new MemoryArtifacts();
    const video:ArtifactRecord={id:"video-1",projectId,kind:"GENERATED_VIDEO",relativePath,
      sha256:sha256Bytes(bytes),sizeBytes:bytes.length,mimeType:"video/mp4",
      integrityStatus:"READY",immutable:true,createdAt:"2026-10-10T00:00:00.000Z"};
    artifacts.data.set(video.id,video);
    const attempt={id:"attempt-1",clipId:"clip-1",projectId,outputArtifactId:video.id,
      status:"SUCCEEDED",attemptNumber:1} as GenerationAttempt;
    const clip={id:"clip-1",contentHash:"a".repeat(64)};
    const decision={id:"review-1",projectId,clipId:clip.id,clipHash:clip.contentHash,
      generationAttemptId:attempt.id,outputArtifactId:video.id,outputArtifactHash:video.sha256,
      decision:"ACCEPT",source:"USER",decidedAt:"2026-10-10T12:00:00.000Z"} as ReviewDecision;
    const params={projectId,projectsRoot,clip,attempts:[attempt],runAttemptIds:[attempt.id],
      decisions:[decision],artifacts};
    await assert.rejects(loadReviewedContinuitySource({...params,decisions:[]}),/人工采用/);
    await assert.rejects(loadReviewedContinuitySource({...params,
      decisions:[{...decision,source:"AI_VISUAL_GATE"}]}),/人工采用/);
    const accepted=await loadReviewedContinuitySource(params);
    assert.equal(accepted.observation.analysisStatus,"REVIEWED");
    assert.equal(accepted.reviewDecisionId,decision.id);
    assert.equal(accepted.sourceVideoSha256,video.sha256);
    const reused=await loadReviewedContinuitySource(params);
    assert.deepEqual(reused,accepted);
    await assert.rejects(loadReviewedContinuitySource({...params,
      decisions:[decision,{...decision,id:"redo-1",decision:"REDO",decidedAt:"2026-10-10T12:01:00.000Z"}]}),/人工采用/);
    await assert.rejects(loadReviewedContinuitySource({...params,
      attempts:[attempt,{...attempt,id:"attempt-2",attemptNumber:2}],
      runAttemptIds:["attempt-1","attempt-2"]}),/人工采用/);
    const reviewedFile=path.join(projectsRoot,projectId,"continuity","clip-1","attempt-1-accepted-review-1.json");
    await fs.writeFile(reviewedFile,JSON.stringify({modified:true}));
    await assert.rejects(loadReviewedContinuitySource(params),/凭据发生变化/);
  } finally {
    await fs.rm(projectsRoot,{recursive:true,force:true});
  }
});
