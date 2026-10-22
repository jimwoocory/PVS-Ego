// Fixed read-only SDK program, embedded in the Go binary. No client-supplied code.
const cfg = globalThis.PVS_GO_BRIDGE_CONFIG;
// SDK round-console buffers until completion; transport events must stream now.
const {stdout} = await import('node:process');
const emit = value => stdout.write('PVS_GO_EVENT ' + JSON.stringify(value) + '\n');
if (cfg.mode !== 'session-open' && cfg.mode !== 'session-read') {
if (process.env.EGO_BROWSER_HOST_INSTANCE_ID !== cfg.instanceId) throw Error('HOST_INSTANCE_CHANGED');
emit({kind:'connected', instanceId:cfg.instanceId});
if (cfg.mode === 'observe' || cfg.mode === 'capture') {
  const task = await taskSpace('pvs-go-local-' + cfg.id);
  const page = task.page('p1');
  await page.goto(cfg.origin + '/bridge-fixture/' + cfg.nonce, {waitUntil:'domcontentloaded',timeout:5000});
  const inspect = () => page.evaluate(() => ({url:location.href,nonce:document.querySelector('meta[name="pvs-go-fixture"]')?.content,tick:Number(document.body.dataset.tick)}));
  let state = await inspect();
  if (state.url !== cfg.origin + '/bridge-fixture/' + cfg.nonce || state.nonce !== cfg.nonce) throw Error('FIXTURE_BINDING_CHANGED');
  emit({kind:'page',spaceId:task.spaceId,targetId:page.targetId});
  if(cfg.mode === 'capture'){
    let ready=false;
    for(let i=0;i<40;i++){
      ready=await page.evaluate(()=>document.body.dataset.researchReady==='1');
      if(ready)break;await new Promise(resolve=>setTimeout(resolve,50));
    }
    if(!ready)throw Error('FIXTURE_DOCUMENT_NOT_READY');
    const descriptor=(await ego.listTaskSpaces()).taskSpaces.find(s=>s.id===task.spaceId);
    if(!descriptor||descriptor.ownership!=='agent'||descriptor.profileId!=='Default')throw Error('CONTROL_CHANGED');
    state=await inspect();
    if(state.url!==cfg.origin+'/bridge-fixture/'+cfg.nonce||state.nonce!==cfg.nonce)throw Error('FIXTURE_BINDING_CHANGED');
    const capturedDocument=await page.evaluate(()=>{
      const text=document.querySelector('[data-pvs-research-document]')?.innerText;
      if(!text)throw Error('FIXTURE_DOCUMENT_MISSING');
      return {sourceUrl:location.href,finalUrl:location.href,title:document.title.slice(0,256),text:text.slice(0,4000),fetchedAt:new Date().toISOString(),truncated:text.length>4000};
    });
    emit({kind:'document',document:capturedDocument});
  }
  for (let i=0;cfg.mode === 'observe' && i<30;i++) {
    const descriptor=(await ego.listTaskSpaces()).taskSpaces.find(s=>s.id===task.spaceId);
    if(!descriptor || descriptor.ownership!=='agent' || descriptor.profileId!=='Default') throw Error('CONTROL_CHANGED');
    state = await inspect();
    if (state.url !== cfg.origin + '/bridge-fixture/' + cfg.nonce || state.nonce !== cfg.nonce || !Number.isSafeInteger(state.tick)) throw Error('FIXTURE_BINDING_CHANGED');
    emit({kind:'sample',tick:state.tick});
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  await page.close();
}
emit({kind:'done'});
}

// Stateful session operations are restricted to the same owned nonce page.
if (cfg.mode === 'session-open' || cfg.mode === 'session-read') {
  try {
    if (process.env.EGO_BROWSER_HOST_INSTANCE_ID !== cfg.instanceId) throw Error('HOST_INSTANCE_CHANGED');
    emit({kind:'connected',instanceId:cfg.instanceId});
    let task, page;
    if (cfg.mode === 'session-open') {
      if ((await ego.listTaskSpaces()).taskSpaces.some(s=>s.name===cfg.spaceName)) throw Error('CONTROL_CHANGED');
      task=await taskSpace(cfg.spaceName);page=task.page('p1');
      await page.goto(cfg.origin+'/bridge-fixture/'+cfg.nonce,{waitUntil:'domcontentloaded',timeout:5000});
    } else {
      const b=cfg.binding,d=(await ego.listTaskSpaces()).taskSpaces.find(s=>s.id===b.spaceId);
      if(!d||d.ownership!=='agent'||d.name!==b.spaceName||d.profileId!=='Default')throw Error('CONTROL_CHANGED');
      task=await taskSpace(b.spaceId);page=(await task.pages()).find(p=>p.label==='p1'&&p.targetId===b.targetId);
      if(!page)throw Error('FIXTURE_BINDING_CHANGED');
    }
    const check=async()=>{
      const d=(await ego.listTaskSpaces()).taskSpaces.find(s=>s.id===task.spaceId);
      if(!d||d.ownership!=='agent'||d.profileId!=='Default'||d.name!==cfg.spaceName)throw Error('CONTROL_CHANGED');
      const v=await page.evaluate(()=>({url:location.href,nonce:document.querySelector('meta[name="pvs-go-fixture"]')?.content,visibility:document.visibilityState}));
      if(v.url!==cfg.origin+'/bridge-fixture/'+cfg.nonce||v.nonce!==cfg.nonce)throw Error('FIXTURE_BINDING_CHANGED');
      // DOM visibility is focus-emulated by this host. Persisted layout is a
      // diagnostic only, never a control grant or proof of live display state.
      const {readFile,lstat}=await import('node:fs/promises');
      const stat=await lstat(cfg.layoutPath);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>512000)throw Error('SESSION_READ_FAILED');
      const layout=JSON.parse(await readFile(cfg.layoutPath,'utf8'));
      if(layout.format!==1||!layout.spaces?.some(s=>s.id===task.spaceId&&s.name===cfg.spaceName&&s.profileId==='Default'))throw Error('SESSION_READ_FAILED');
      return {...v,visibility:layout.selectedSpaceId===task.spaceId?'visible':'hidden'};
    };
    await check();emit({kind:'page',spaceId:task.spaceId,targetId:page.targetId});
    if(cfg.mode==='session-open'){
      emit({kind:'session',binding:{instanceId:cfg.instanceId,spaceId:task.spaceId,spaceName:cfg.spaceName,profileId:'Default',targetId:page.targetId,sessionId:cfg.sessionId}});
    } else {
      let state=await check();emit({kind:'visibility',visibility:state.visibility,visibilitySource:'OWNED_HOST_LAYOUT_SNAPSHOT'});
      if(cfg.captureScreenshot&&state.visibility!=='visible')throw Error('SPACE_HIDDEN');
      let ready=false;for(let i=0;i<40;i++){ready=await page.evaluate(()=>document.body.dataset.researchReady==='1');if(ready)break;await new Promise(r=>setTimeout(r,50));}
      if(!ready)throw Error('SESSION_READ_FAILED');
      await check();
      const doc=await page.evaluate(()=>{const text=document.querySelector('[data-pvs-research-document]')?.innerText;if(!text)throw Error('SESSION_READ_FAILED');return {sourceUrl:location.href,finalUrl:location.href,title:document.title.slice(0,256),text:text.slice(0,4000),fetchedAt:new Date().toISOString(),truncated:text.length>4000};});
      emit({kind:'document',document:doc});
      if(cfg.captureScreenshot){
        state=await check();if(state.visibility!=='visible')throw Error('SPACE_HIDDEN');
        try{await page.screenshot({path:cfg.screenshotPath,fullPage:false});}catch{throw Error('SCREENSHOT_FAILED');}
        const {readFile}=await import('node:fs/promises'),png=await readFile(cfg.screenshotPath);
        if(png.length>1_000_000||!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('SCREENSHOT_FAILED');
        await check();emit({kind:'screenshot',png:png.toString('base64')});
      }
    }
    emit({kind:'done'});
  } catch(error) {
    const allowed=['HOST_INSTANCE_CHANGED','CONTROL_CHANGED','FIXTURE_BINDING_CHANGED','SPACE_HIDDEN','SCREENSHOT_FAILED'];
    emit({kind:'blocked',code:allowed.includes(error.message)?error.message:'SESSION_READ_FAILED'});emit({kind:'done'});
  }
}
