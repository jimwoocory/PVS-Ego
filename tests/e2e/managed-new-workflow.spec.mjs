import {test,expect} from "@playwright/test";

test("newly created workflow is durably granted in managed mode without touching paid or historical runs",async({page,request})=>{
  test.skip(process.env.PVS_SMART_WORKER_MANAGED_NEW_RUNS!=="1","managed-mode test requires an isolated opt-in test server");
  // Never add historical runs to the shared e2e-draft fixture; subsequent
  // Task Center tests assert the pre-seeded task count.
  const projectName="E2E Isolated Managed Project "+Date.now();
  const projectResponse=await request.post("/api/projects",{
    data:{name:projectName,targetDurationMs:30000}
  });
  expect(projectResponse.status()).toBe(201);
  const projectId=(await projectResponse.json()).project.id;
  const created=await request.post("/api/projects/"+projectId+"/smart-runs",{
    data:{requestKey:"managed-e2e-"+Date.now(),options:{
      requestText:"本地模拟：创建新的完整创作任务",
      directorVersion:3,
      generationSettings:{requestedModelVersion:"seedance2.0mini",
        aspectRatio:"9:16",videoResolution:"720p",nativeAudioOutputRequested:false},
      reviewMode:"MANUAL",
      useExistingResearch:false,
      useResearchReferences:false
    }}
  });
  expect(created.status()).toBe(201);
  const run=(await created.json()).run;
  try{
    expect(run.status).toBe("PLANNING");
    expect(run.stage).toBe("SOURCES");
    expect(run.autoAdvanceGrant).toMatchObject({
      projectId,runId:run.id,source:"USER_CREATED"
    });
    expect(run.consent).toBeUndefined();
    expect(run.assetConsent).toBeUndefined();
    expect(run.attemptIds).toEqual([]);
    await page.goto("/projects/"+projectId+"/smart");
    await expect(page.locator(".run")).toHaveCount(1);
    await expect(page.locator(".run")).not.toContainText("后台编排已暂停");
    await expect(page.locator('[data-action="authorize-worker"]')).toHaveCount(0);
    const persisted=await request.get("/api/projects/"+projectId+"/smart-runs/"+run.id);
    expect(persisted.status()).toBe(200);
    expect((await persisted.json()).run.autoAdvanceGrant?.runId).toBe(run.id);
    const legacy=await request.get("/api/projects/e2e-ready/smart-runs/e2e-workflow-truth-run");
    expect(legacy.status()).toBe(200);
    expect((await legacy.json()).run.autoAdvanceGrant).toBeUndefined();
  } finally {
    // Isolated e2e database cleanup only. Never touches user projects.
    const cancelled=await request.post("/api/projects/"+projectId+"/smart-runs/"+run.id+"/cancel",{data:{}});
    expect(cancelled.status()).toBe(200);
    const deletion=await request.delete("/api/projects/"+projectId,{
      data:{confirmName:projectName}
    });
    expect(deletion.status()).toBe(200);
  }
});
