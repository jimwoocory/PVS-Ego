// Fixed account/first-page read program. No caller-supplied script, URL, login,
// signature generation, cookies, publication, reply or automatic control claim.
const c=globalThis.PVS_EGO_OPS;
const {stdout}=await import('node:process');
const emit=v=>stdout.write('PVS_EGO_OPS '+JSON.stringify(v)+'\n');
const empty=status=>({status,source:c.source,checkedAt:new Date().toISOString()});
let task,page;
const openedBinding=()=>({instanceId:c.base.instanceId,spaceId:task.spaceId,spaceName:c.spaceName,profileId:'Default',targetId:page.targetId,sessionId:c.base.nonce});
try{
 if(process.env.EGO_BROWSER_HOST_INSTANCE_ID!==c.base.instanceId)throw Error('SESSION_EXPIRED');
 if(c.operation==='open'){
  if((await ego.listTaskSpaces()).taskSpaces.some(s=>s.name===c.spaceName))throw Error('SESSION_EXPIRED');
  task=await taskSpace(c.spaceName);page=task.page('p1');
  const destination=c.source==='LIVE_DOUYIN'?'https://www.douyin.com/user/self':c.base.origin+'/bridge-fixture/'+c.base.nonce;
  let opened=true;try{await page.goto(destination,{waitUntil:'domcontentloaded',timeout:12000});}
  catch(error){opened=false;if(page.targetId){emit({...empty('PROVIDER_ERROR'),binding:openedBinding()});}else emit(empty('PROVIDER_ERROR'));}
  if(opened)emit({...empty('AUTH_REQUIRED'),binding:openedBinding()});
 }else{
  const d=(await ego.listTaskSpaces()).taskSpaces.find(s=>s.id===c.binding.spaceId&&s.name===c.spaceName&&s.profileId==='Default');
  if(!d)throw Error('SESSION_EXPIRED');if(d.ownership!=='agent')throw Error('CONTROL_USER');
  task=await taskSpace(d.id);page=(await task.pages()).find(p=>p.targetId===c.binding.targetId&&p.label==='p1');
  if(!page)throw Error('SESSION_EXPIRED');
  const destination=c.source==='LIVE_DOUYIN'?'https://www.douyin.com/user/self':c.base.origin+'/bridge-fixture/'+c.base.nonce;
  const current=await page.evaluate(()=>location.href);
  if(c.source==='LIVE_DOUYIN'){
   if(new URL(current).origin!=='https://www.douyin.com')throw Error('SESSION_EXPIRED');
   if(!new URL(current).pathname.startsWith('/user/'))await page.goto(destination,{waitUntil:'domcontentloaded',timeout:10000});
  }else if(current!==destination)throw Error('SESSION_EXPIRED');
  // The site owns its request construction. Observe only a fresh, bounded
  // first-page response on this already-owned Page; never copy query secrets,
  // synthesize a signature, replay a captured URL or inspect request headers.
  const issue=(reason,httpStatus)=>Object.assign(Error('PROVIDER_ERROR'),{reason,httpStatus});
  const blocked=(stage,error)=>({...empty(['AUTH_REQUIRED','RISK_CONTROL'].includes(error.message)?error.message:'PROVIDER_ERROR'),failure:{stage,reason:['HTTP_ERROR','RESPONSE_TOO_LARGE','EMPTY_RESPONSE','INVALID_JSON','TIMEOUT','NETWORK_ERROR','NATIVE_REQUEST_NOT_OBSERVED','READ_FAILED'].includes(error.reason)?error.reason:'READ_FAILED',...(Number.isInteger(error.httpStatus)&&error.httpStatus>=100&&error.httpStatus<=599?{httpStatus:error.httpStatus}:{}),...(error.networkCode?{networkCode:error.networkCode}:{})}});
  const readIdentity=()=>page.evaluate(async source=>{
   const fail=(status,reason,httpStatus)=>{throw Object.assign(Error(status),{reason,httpStatus});};
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),4000);
   try{
    const url=source==='LIVE_DOUYIN'?'/aweme/v1/web/user/profile/self/?aid=6383':location.pathname+'/self';
    const r=await fetch(url,{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal});
    if(!r.ok)fail(r.status===401||r.status===403?'AUTH_REQUIRED':'PROVIDER_ERROR','HTTP_ERROR',r.status);
    const text=await r.text();if(text.length>2000000)fail('PROVIDER_ERROR','RESPONSE_TOO_LARGE');if(!text.trim())fail('PROVIDER_ERROR','EMPTY_RESPONSE');
    let data;try{data=JSON.parse(text);}catch{fail('PROVIDER_ERROR','INVALID_JSON');}
    if(data.status_code!==0)fail('AUTH_REQUIRED','READ_FAILED');const u=data.user??data.data?.user;
    if(!u||!/^[1-9]\d{0,39}$/.test(String(u.uid??'')))fail('AUTH_REQUIRED','READ_FAILED');
    const str=(v,n)=>typeof v==='string'?v.slice(0,n):'';
    return {identity:{uid:String(u.uid),secUid:str(u.sec_uid,200),uniqueId:str(u.unique_id,100),shortId:str(u.short_id,100),nickname:str(u.nickname,100)}};
   }catch(error){return {status:['AUTH_REQUIRED','RISK_CONTROL'].includes(error.message)?error.message:'PROVIDER_ERROR',reason:['HTTP_ERROR','RESPONSE_TOO_LARGE','EMPTY_RESPONSE','INVALID_JSON','READ_FAILED'].includes(error.reason)?error.reason:error.name==='AbortError'?'TIMEOUT':'NETWORK_ERROR',...(Number.isInteger(error.httpStatus)?{httpStatus:error.httpStatus}:{})};}finally{clearTimeout(timer);}
  },c.source);
  const freshIdentity=async()=>{const r=await readIdentity();if(!r.identity)throw Object.assign(Error(r.status),{reason:r.reason,httpStatus:r.httpStatus});return r.identity;};
  const pageWorks=async user=>{
   const frame=(await page.cdp('Page.getFrameTree')).frameTree.frame.id;
   await page.cdp('Network.enable',{maxTotalBufferSize:4000000,maxResourceBufferSize:2000000});await page.events();
   let requestId,observed=false,finished=false,httpStatus;
   const accept=p=>{try{const u=new URL(p.request.url);return p.frameId===frame&&p.request.method==='GET'&&!p.redirectResponse&&u.origin===(c.source==='LIVE_DOUYIN'?'https://www.douyin.com':c.base.origin)&&u.pathname===(c.source==='LIVE_DOUYIN'?'/aweme/v1/web/aweme/post/':'/bridge-fixture/'+c.base.nonce+'/works')&&u.searchParams.get('sec_user_id')===user.secUid&&u.searchParams.get('max_cursor')==='0'&&/^[1-9]\d?$/.test(u.searchParams.get('count')??'')&&Number(u.searchParams.get('count'))<=c.count;}catch{return false;}};
   const consume=async()=>{for(const e of await page.events()){const p=e.params??{};
    if(e.method==='Network.requestWillBeSent'){
     if(p.requestId===requestId&&p.redirectResponse)throw issue('NETWORK_ERROR');
     if(!requestId&&accept(p)){requestId=p.requestId;observed=true;}
    }
    if(requestId&&p.requestId===requestId){
     if(e.method==='Network.responseReceived'){const u=new URL(p.response.url);if(u.origin!==(c.source==='LIVE_DOUYIN'?'https://www.douyin.com':c.base.origin)||u.pathname!==(c.source==='LIVE_DOUYIN'?'/aweme/v1/web/aweme/post/':'/bridge-fixture/'+c.base.nonce+'/works'))throw issue('NETWORK_ERROR');httpStatus=p.response.status;if(httpStatus<200||httpStatus>=300)throw Object.assign(Error(httpStatus===401||httpStatus===403?'AUTH_REQUIRED':'PROVIDER_ERROR'),{reason:'HTTP_ERROR',httpStatus});}
     if(e.method==='Network.loadingFailed'){const code=['net::ERR_EMPTY_RESPONSE','net::ERR_ABORTED','net::ERR_BLOCKED_BY_CLIENT','net::ERR_BLOCKED_BY_ORB','net::ERR_FAILED'].includes(p.errorText)?p.errorText:'OTHER';throw Object.assign(issue(code==='net::ERR_EMPTY_RESPONSE'?'EMPTY_RESPONSE':'NETWORK_ERROR',httpStatus),{networkCode:code});}
     if(e.method==='Network.loadingFinished'){if(p.encodedDataLength>2000000)throw issue('RESPONSE_TOO_LARGE');finished=true;}
    }
   }};
   const deadline=Date.now()+7000;
   if(c.source==='LIVE_DOUYIN')await page.reload({waitUntil:'domcontentloaded',timeout:7000});
   else await page.evaluate(input=>{window.dispatchEvent(new CustomEvent('pvs-fixture-read',{detail:input}));},{count:c.count,secUid:user.secUid});
   while(Date.now()<deadline&&!finished){await consume();if(!finished)await new Promise(r=>setTimeout(r,50));}
   if(!finished)throw issue(observed?'TIMEOUT':'NATIVE_REQUEST_NOT_OBSERVED');
   const response=await page.cdp('Network.getResponseBody',{requestId},{timeout:2000});
   if(response.body.length>2800000)throw issue('RESPONSE_TOO_LARGE');
   const text=response.base64Encoded?Buffer.from(response.body,'base64').toString('utf8'):response.body;
   if(Buffer.byteLength(text)>2000000)throw issue('RESPONSE_TOO_LARGE');if(!text.trim())throw issue('EMPTY_RESPONSE');
   try{return JSON.parse(text);}catch{throw issue('INVALID_JSON');}
  };
  let stage=c.operation==='identity'?'IDENTITY':'IDENTITY_BEFORE',result;
  try{
   const user=await freshIdentity();
   if(c.operation==='identity')result={...empty('READY'),identity:user};
   else if(user.uid!==c.expectedAccountUid)result=empty('ACCOUNT_CHANGED');
   else if(!user.secUid)result=empty('DATA_UNAVAILABLE');
   else{
    stage='WORKS';const data=await pageWorks(user);
    if(data.status_code!==0||!Array.isArray(data.aweme_list)||data.aweme_list.length>c.count)result=empty('DATA_UNAVAILABLE');
    else{
     const works=[],names={plays:'play_count',likes:'digg_count',comments:'comment_count',shares:'share_count',collects:'collect_count'};let invalid=false;
     for(const raw of data.aweme_list){
      if(!/^\d{8,30}$/.test(String(raw.aweme_id??''))||String(raw.author?.uid??'')!==user.uid||!Number.isSafeInteger(raw.video?.duration)||raw.video.duration<0){invalid=true;break;}
      const metrics={},availability={};for(const [key,name]of Object.entries(names)){const v=raw.statistics?.[name];if(Number.isSafeInteger(v)&&v>=0){metrics[key]=v;availability[key]='OBSERVED';}else availability[key]=v===-1?'NOT_VISIBLE':'NOT_PROVIDED';}
      let publishedAt=null;if(Number.isSafeInteger(raw.create_time)&&raw.create_time>0){const date=new Date(raw.create_time*1000);if(Number.isNaN(date.getTime())){invalid=true;break;}publishedAt=date.toISOString();}
      works.push({awemeId:String(raw.aweme_id),description:typeof raw.desc==='string'?raw.desc.slice(0,2000):'',publishedAt,author:{uid:user.uid,secUid:user.secUid,uniqueId:user.uniqueId,nickname:user.nickname},metrics,metricAvailability:availability,durationMs:raw.video.duration,coverUrl:'',externalUrl:'https://www.douyin.com/video/'+raw.aweme_id});
     }
     if(invalid)result=empty('DATA_UNAVAILABLE');
     else{stage='IDENTITY_AFTER';const afterUser=await freshIdentity();result=afterUser.uid!==user.uid?empty('ACCOUNT_CHANGED'):{...empty('READY'),identity:afterUser,works,readMethod:'PAGE_RESPONSE'};}
    }
   }
  }catch(error){result=blocked(stage,error);}
  const after=(await ego.listTaskSpaces()).taskSpaces.find(s=>s.id===c.binding.spaceId&&s.name===c.spaceName&&s.profileId==='Default');
  if(!after||after.ownership!=='agent')throw Error('CONTROL_USER');
  emit(result);
 }
}catch(error){emit(empty(['CONTROL_USER','SESSION_EXPIRED'].includes(error.message)?error.message:'PROVIDER_ERROR'));}
