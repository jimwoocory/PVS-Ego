import test from "node:test";
import assert from "node:assert/strict";
import { ReviewService } from "../src/application/services/review-service.js";
import { makeValidClip, H, ISO } from "./fixtures.js";
import type { ReviewDecision, GenerationAttempt, ArtifactRecord } from "../src/domain/schemas.js";

test("V8 upstream local redo stales only genuinely dependent accepted clips, never unrelated scene jump",async()=>{
  const flag=process.env.PVS_SCENE_CONTINUITY_V1;
  process.env.PVS_SCENE_CONTINUITY_V1="1";
  try {
    const projectId="v8-cascade-test";
    const [a,b,c]=[0,1,2].map(i=>{
      const clip=makeValidClip();
      return {...clip,id:"clip-"+i,sceneId:i===2?"scene-2":"scene-1",
        contentHash:(i+1).toString(16).repeat(64)};
    });
    b!.openingState={...a!.closingState};
    const plan={contentHash:H.a,v8Source:{screenplayHash:H.b},
      scenes:[{id:"scene-1",clips:[a,b]},{id:"scene-2",clips:[c]}]};
    const attempts=[a,b,c].map((clip,i)=>({
      id:"attempt-"+i,projectId,clipId:clip!.id,status:"SUCCEEDED",
      attemptNumber:1,outputArtifactId:"video-"+i,
      generationRequestId:"request-"+i
    })) as GenerationAttempt[];
    const artifacts=[a,b,c].map((_,i)=>({
      id:"video-"+i,projectId,kind:"GENERATED_VIDEO",sha256:H.c,
      integrityStatus:"READY"
    })) as ArtifactRecord[];
    const decisions: ReviewDecision[]=attempts.map((attempt,i)=>({
      id:"accept-"+i,projectId,clipId:attempt.clipId,
      clipHash:[a,b,c][i]!.contentHash,generationAttemptId:attempt.id,
      outputArtifactId:attempt.outputArtifactId!,outputArtifactHash:H.c,
      source:"USER",decision:"ACCEPT",decidedAt:"2026-10-10T10:00:00.000Z"
    }));
    const changed:string[]=[];
    const flow={getWorkspace:async()=>({productionPlan:plan}),
      setProjectStatus:async(_:string,status:string)=>({status})};
    const generation={markRequestChainStale:async(id:string)=>{changed.push(id);}};
    const workflow={getGenerationAttempt:async(id:string)=>attempts.find(a=>a.id===id)??null,
      listGenerationAttempts:async()=>attempts,listOpenBlockers:async()=>[]};
    const artifactRepo={findById:async(id:string)=>artifacts.find(a=>a.id===id)??null};
    const review={createDecision:async(d:ReviewDecision)=>{decisions.push(d);return d;},
      listDecisions:async()=>decisions};
    const service=new ReviewService(flow as any,generation as any,workflow as any,
      artifactRepo as any,review as any);
    const output=await service.decide({
      projectId,clipId:a!.id,generationAttemptId:attempts[0]!.id,
      decision:"REDO",now:new Date("2026-10-10T11:00:00.000Z")
    });
    assert.equal(output.redoClipId,a!.id);
    assert.deepEqual(changed,["request-0","request-1"]);
    assert.equal(decisions.filter(d=>d.decision==="STALE").length,1);
    const invalidated=decisions.find(d=>d.decision==="STALE")!;
    assert.equal(invalidated.clipId,b!.id);
    assert.equal(invalidated.source,"CONTINUITY_DEPENDENCY");
    assert.ok(Date.parse(invalidated.decidedAt)>Date.parse("2026-10-10T10:00:00.000Z"));
    assert.equal(decisions.find(d=>d.clipId===c!.id)?.decision,"ACCEPT");
  }finally {
    if(flag===undefined)delete process.env.PVS_SCENE_CONTINUITY_V1;
    else process.env.PVS_SCENE_CONTINUITY_V1=flag;
  }
});
