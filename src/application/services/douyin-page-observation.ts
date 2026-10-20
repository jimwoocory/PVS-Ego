import {z} from "zod";
import {DomainValidationError} from "../../domain/validation.js";

const control=z.object({count:z.number().int().nonnegative().nullable(),visibleCount:z.number().int().nonnegative().nullable()}).strict().refine(c=>(c.count===null)===(c.visibleCount===null)&&!(c.count!==null&&c.visibleCount!>c.count));
export const douyinPageObservationSchema=z.object({
 url:z.string().url(),readyState:z.enum(["loading","interactive","complete"]),
 fileInputs:z.array(z.object({selectedCount:z.number().int().nonnegative(),accept:z.string(),multiple:z.boolean()}).strict()),
 uploadEntry:control,title:control,description:control,tags:control,declaration:control,submit:control,
 visibleEditableCount:z.number().int().nonnegative(),
 strongAccountIds:z.array(z.string().regex(/^[A-Za-z0-9_.-]+$/)),
 challenge:z.enum(["NONE","LOGIN","CAPTCHA","RISK"]),loading:z.boolean()
}).strict();
export type DouyinPageObservation=z.infer<typeof douyinPageObservationSchema>;
export function assessDouyinPage(raw:unknown,expectedAccountId?:string){
 const p=douyinPageObservationSchema.parse(raw),u=new URL(p.url);
 if(u.username||u.password||u.search||u.hash)throw new DomainValidationError("OBSERVATION_URL_NOT_PINNED");
 const accountIds=[...new Set(p.strongAccountIds)];
 const complete=[p.title,p.description,p.tags,p.declaration,p.submit].every(c=>c.count===1&&c.visibleCount===1);
 const phase=p.challenge==="LOGIN"?"LOGIN":p.challenge!=="NONE"?"CHALLENGE":p.readyState!=="complete"||p.loading?"LOADING":complete?"EDITOR":p.uploadEntry.visibleCount===1&&p.fileInputs.length===1&&p.visibleEditableCount===0?"UPLOAD_LANDING":"UNKNOWN";
 const blockers:string[]=[];
 if(phase!=="EDITOR")blockers.push(phase==="UPLOAD_LANDING"?"POST_UPLOAD_EDITOR_NOT_OBSERVED":"PAGE_PHASE_"+phase);
 if(accountIds.length!==1)blockers.push(accountIds.length?"AMBIGUOUS_STRONG_ACCOUNT_ID":"STRONG_ACCOUNT_ID_NOT_OBSERVED");
 else if(expectedAccountId&&accountIds[0]!==expectedAccountId)blockers.push("STRONG_ACCOUNT_ID_CHANGED");
 if(p.fileInputs.some(f=>f.selectedCount>0))blockers.push("EXISTING_SELECTED_MEDIA_DO_NOT_RESELECT");
 return {phase,observation:p,blockers,selectedFileCount:p.fileInputs.reduce((n,f)=>n+f.selectedCount,0),editorControlsObserved:complete,
  account:accountIds.length===1?{type:"DOUYIN_UNIQUE_ID" as const,id:accountIds[0]}:undefined,
  /** DOM completeness is observation only; it grants no control, material transfer or submission permission. */
  observationComplete:blockers.length===0,executionAllowed:false as const};
}

/** Uses only live DOM metadata, no input values, scripts, cookies, storage or application state. */
export function douyinReadOnlyDomExpression(selectors:{uploadEntry:string;title:string|null;description:string|null;tags:string|null;declaration:string|null;submit:string|null}){
 return `(()=>{const selectors=${JSON.stringify(selectors)};
const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
const controls=k=>{if(selectors[k]===null)return {count:null,visibleCount:null};const nodes=[...document.querySelectorAll(selectors[k])];return {count:nodes.length,visibleCount:nodes.filter(visible).length};};
const text=document.body?.innerText??'',ids=[...text.matchAll(/(?:^|\\n)\\s*抖音号[：:]\\s*([A-Za-z0-9_.-]+)\\s*(?=\\n|$)/g)].map(m=>m[1]);
const challenge=/验证码|安全验证|滑块验证/.test(text)?'CAPTCHA':/风险验证|操作频繁|访问受限/.test(text)?'RISK':/扫码登录|手机号登录|请先登录/.test(text)?'LOGIN':'NONE';
return {url:location.origin+location.pathname,readyState:document.readyState,fileInputs:[...document.querySelectorAll('input[type="file"]')].map(e=>({selectedCount:e.files.length,accept:e.accept,multiple:e.multiple})),uploadEntry:controls('uploadEntry'),title:controls('title'),description:controls('description'),tags:controls('tags'),declaration:controls('declaration'),submit:controls('submit'),visibleEditableCount:[...document.querySelectorAll('textarea,[contenteditable="true"],input:not([type="hidden"]):not([type="file"]):not([type="password"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"])')].filter(visible).length,strongAccountIds:ids,challenge,loading:/加载中，请稍候/.test(text)};})()`;
}
