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
  const result=await page.evaluate(async input=>{
   const at=()=>new Date().toISOString(),blocked=status=>({status,source:input.source,checkedAt:at()});
   const base=input.source==='LIVE_DOUYIN'?'':location.pathname;
   const get=async url=>{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),7000);try{const r=await fetch(url,{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal});if(!r.ok)throw Error(r.status===401||r.status===403?'AUTH_REQUIRED':'PROVIDER_ERROR');const text=await r.text();if(text.length>2000000)throw Error('PROVIDER_ERROR');return JSON.parse(text);}finally{clearTimeout(timer);}};
   const readIdentity=async()=>{
    const data=await get(input.source==='LIVE_DOUYIN'?'/aweme/v1/web/user/profile/self/?aid=6383':base+'/self');
    if(data.status_code!==0)throw Error('AUTH_REQUIRED');
    const u=data.user??data.data?.user;
    if(!u||!/^[1-9]\d{0,39}$/.test(String(u.uid??'')))throw Error('AUTH_REQUIRED');
    const text=(v,n)=>typeof v==='string'?v.slice(0,n):'';
    return {uid:String(u.uid),secUid:text(u.sec_uid,200),uniqueId:text(u.unique_id,100),shortId:text(u.short_id,100),nickname:text(u.nickname,100)};
   };
   try{
    const user=await readIdentity();
    if(input.operation==='identity')return {status:'READY',source:input.source,checkedAt:at(),identity:user};
    if(user.uid!==input.expectedAccountUid)return blocked('ACCOUNT_CHANGED');
    if(!user.secUid)return blocked('DATA_UNAVAILABLE');
    const url=input.source==='LIVE_DOUYIN'?'/aweme/v1/web/aweme/post/?aid=6383&sec_user_id='+encodeURIComponent(user.secUid)+'&count='+input.count+'&max_cursor=0':base+'/works?count='+input.count;
    const data=await get(url);
    if(data.status_code!==0||!Array.isArray(data.aweme_list))return blocked('DATA_UNAVAILABLE');
    const works=[];const names={plays:'play_count',likes:'digg_count',comments:'comment_count',shares:'share_count',collects:'collect_count'};
    for(const raw of data.aweme_list.slice(0,input.count)){
     if(!/^\d{8,30}$/.test(String(raw.aweme_id??''))||String(raw.author?.uid??'')!==user.uid||!Number.isSafeInteger(raw.video?.duration)||raw.video.duration<0)return blocked('DATA_UNAVAILABLE');
     const metrics={},availability={};
     for(const [key,name]of Object.entries(names)){const value=raw.statistics?.[name];if(Number.isSafeInteger(value)&&value>=0){metrics[key]=value;availability[key]='OBSERVED';}else availability[key]=value===-1?'NOT_VISIBLE':'NOT_PROVIDED';}
     let publishedAt=null;if(Number.isSafeInteger(raw.create_time)&&raw.create_time>0){const date=new Date(raw.create_time*1000);if(Number.isNaN(date.getTime()))return blocked('DATA_UNAVAILABLE');publishedAt=date.toISOString();}
     works.push({awemeId:String(raw.aweme_id),description:typeof raw.desc==='string'?raw.desc.slice(0,2000):'',publishedAt,author:{uid:user.uid,secUid:user.secUid,uniqueId:user.uniqueId,nickname:user.nickname},metrics,metricAvailability:availability,durationMs:raw.video.duration,coverUrl:'',externalUrl:'https://www.douyin.com/video/'+raw.aweme_id});
    }
    const after=await readIdentity();if(after.uid!==user.uid)return blocked('ACCOUNT_CHANGED');
    return {status:'READY',source:input.source,checkedAt:at(),identity:after,works};
   }catch(error){return blocked(['AUTH_REQUIRED','RISK_CONTROL'].includes(error.message)?error.message:'PROVIDER_ERROR');}
  },{source:c.source,operation:c.operation,expectedAccountUid:c.expectedAccountUid,count:c.count});
  const after=(await ego.listTaskSpaces()).taskSpaces.find(s=>s.id===c.binding.spaceId&&s.name===c.spaceName&&s.profileId==='Default');
  if(!after||after.ownership!=='agent')throw Error('CONTROL_USER');
  emit(result);
 }
}catch(error){emit(empty(['CONTROL_USER','SESSION_EXPIRED'].includes(error.message)?error.message:'PROVIDER_ERROR'));}
