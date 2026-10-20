import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ClipTransitionContract } from "../src/application/services/clip-continuity-engine.js";
import { inspectClipTransitionMedia } from "../src/application/services/clip-transition-media-qc.js";

const exec=promisify(execFile);
const baseContract:ClipTransitionContract={
  version:"clip-continuity-contract-1",
  sourceClipId:"a",targetClipId:"b",sourceSceneId:"court",targetSceneId:"court",
  relationship:"HARD_CONTINUITY",plannedSourceEndStateHash:"a".repeat(64),
  plannedTargetStartStateHash:"a".repeat(64),approvedProductionPlanHash:"b".repeat(64),
  reason:"卷宗连续",actorAnchors:[],propAnchors:[],requiresSourceGeneration:true,
  requiresHardFirstFrame:true,contentHash:"c".repeat(64)
};
async function sample(dir:string,name:string,color:string,size="120x200"){
  const file=path.join(dir,name+".mp4");
  await exec("ffmpeg",["-hide_banner","-loglevel","error","-f","lavfi","-i",
    "color=c="+color+":s="+size+":r=12","-t","1","-pix_fmt","yuv420p","-y",file],
    {windowsHide:true,timeout:30000});
  return file;
}
test("transition QC checks actual vertical videos, hard continuity frames and required sound",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"pvs-clip-qc-"));
  try{
    const red=await sample(dir,"red","red");
    const red2=await sample(dir,"red2","red");
    const blue=await sample(dir,"blue","blue");
    const wide=await sample(dir,"wide","red","200x120");
    const input={contract:baseContract,sourceVideoPath:red,targetVideoPath:red2,
      requestedRatio:"3:5",nativeAudioRequired:false};
    const match=await inspectClipTransitionMedia(input);
    assert.equal(match.status,"REVIEW_REQUIRED","technical similarity alone never auto-accepts a story");
    assert.equal(match.pixelDistance,0);
    const mismatch=await inspectClipTransitionMedia({...input,targetVideoPath:blue});
    assert.equal(mismatch.status,"BLOCKED");
    assert.ok(mismatch.pixelDistance!>0.16);
    const wrongRatio=await inspectClipTransitionMedia({...input,targetVideoPath:wide});
    assert.equal(wrongRatio.status,"BLOCKED");
    assert.match(wrongRatio.issues.join("；"),/画幅/);
    const silence=await inspectClipTransitionMedia({...input,nativeAudioRequired:true});
    assert.equal(silence.status,"BLOCKED");
    assert.match(silence.issues.join("；"),/没有音轨/);
    const cut=await inspectClipTransitionMedia({...input,targetVideoPath:blue,
      contract:{...baseContract,relationship:"SAME_SCENE_CUT",requiresHardFirstFrame:false}});
    assert.equal(cut.status,"REVIEW_REQUIRED","normal camera cut is not judged by pixel likeness");
    assert.equal(cut.pixelDistance,undefined);
  }finally{
    await fs.rm(dir,{recursive:true,force:true});
  }
});
