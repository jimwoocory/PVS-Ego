import "../../isolation/require-isolation.js";
import fs from "node:fs/promises";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {z} from "zod";
import {sha256Bytes} from "../../domain/hashing.js";
import {requireDouyinPageContract,type DouyinPageContract} from "../../application/services/ego-douyin-site-proof.js";
import {DomainValidationError} from "../../domain/validation.js";

const hash=z.string().regex(/^[a-f0-9]{64}$/),exec=promisify(execFile);
const configSchema=z.object({cliPath:z.string(),cliSha256:hash,sdkPath:z.string(),sdkSha256:hash,dataDir:z.string(),
 session:z.object({instanceId:z.string().min(1),spaceId:z.number().int().positive(),spaceName:z.string().min(1),targetId:z.string().min(1)}).strict()}).strict();
export type EgoInspectionConfig=z.infer<typeof configSchema>;
/** Executes read-only CDP observation in the existing TaskSpace. No goto/fill/file/click/login API. */
export class EgoDouyinInspectionDriver {
 private readonly cfg:EgoInspectionConfig;
 private readonly contract:DouyinPageContract;
 constructor(config:EgoInspectionConfig,contract:unknown,private readonly localMirror=false){
  this.cfg=configSchema.parse(config);if(![config.cliPath,config.sdkPath,config.dataDir].every(path.isAbsolute))throw new DomainValidationError("Ego 路径必须为绝对路径");
  this.contract=requireDouyinPageContract(contract,config.sdkSha256,new Date(),localMirror);
 }
 async inspect(){
  const c=this.cfg;requireDouyinPageContract(this.contract,c.sdkSha256,new Date(),this.localMirror);
  for(const [file,sha] of [[c.cliPath,c.cliSha256],[c.sdkPath,c.sdkSha256]])if(sha256Bytes(await fs.readFile(file!))!==sha)throw new DomainValidationError("Ego CLI/SDK 内容已变化");
  const read=`(()=>{const s=${JSON.stringify(this.contract.selectors)};const unique=k=>{const nodes=document.querySelectorAll(s[k]);if(nodes.length!==1)throw Error('AMBIGUOUS_'+k);return nodes[0];};
const text=e=>String(e.value??e.innerText??e.textContent??'').trim();const a=text(unique('account'));const m=a.match(/^抖音号[：:]\\s*([A-Za-z0-9_.-]+)$/);if(!m)throw Error('NO_STRONG_UNIQUE_ID');
const selected=unique('selectedDeclaration');if(!(selected.checked===true||selected.getAttribute('aria-checked')==='true'))throw Error('DECLARATION_NOT_SELECTED');
return {accountUniqueId:m[1],title:text(unique('title')),description:text(unique('description')),selectedFileCount:unique('file').files.length,declaration:text(selected.closest('label')??selected),submitLabel:text(unique('submit')),observationOnly:true};})()`;
  const script=`const cfg=${JSON.stringify(c)},contract=${JSON.stringify(this.contract)};
if(process.env.EGO_BROWSER_HOST_INSTANCE_ID!==cfg.session.instanceId)throw Error('INSTANCE_CHANGED');const d=(await ego.listTaskSpaces()).taskSpaces.find(x=>x.id===cfg.session.spaceId);if(!d||d.name!==cfg.session.spaceName||d.ownership!=='agent')throw Error('SPACE_OR_CONTROL_CHANGED');
const t=await taskSpace(cfg.session.spaceId),p=t.page('p1');async function native(){const f=(await p.cdp('Page.getFrameTree')).frameTree.frame;const x=(await t.cdp('Target.getTargetInfo',{targetId:p.targetId})).targetInfo;if(x.targetId!==cfg.session.targetId||x.url!==contract.editorUrl||f.url!==contract.editorUrl)throw Error('PAGE_CHANGED');return f;}
const before=await native(),world=(await p.cdp('Page.createIsolatedWorld',{frameId:before.id,worldName:'pvs-douyin-inspection'})).executionContextId;
const r=await p.cdp('Runtime.evaluate',{contextId:world,returnByValue:true,expression:${JSON.stringify(read)}});if(r.exceptionDetails||!r.result?.value)throw Error('SITE_CONTRACT_NOT_MATCHED');const after=await native();if(before.loaderId!==after.loaderId)throw Error('DOCUMENT_CHANGED');
console.log('PVS_DOUYIN_INSPECT '+JSON.stringify({instanceId:cfg.session.instanceId,spaceId:cfg.session.spaceId,targetId:cfg.session.targetId,frameId:before.id,loaderId:before.loaderId,observedAt:new Date().toISOString(),state:r.result.value}));`;
  try{const {stdout}=await exec(process.execPath,[c.cliPath,"nodejs","--sdk-path",c.sdkPath,"-e",script],{env:{...process.env,EGO_WINDOWS_DATA_DIR:c.dataDir},windowsHide:true,timeout:30000,maxBuffer:1024*1024});const line=stdout.split(/\r?\n/).find(l=>l.startsWith("PVS_DOUYIN_INSPECT "));if(!line)throw Error();return JSON.parse(line.slice(19));}
  catch{throw new DomainValidationError("原会话或实站契约无法核验；停止，不导航、不重开、不填表、不上传、不提交");}
 }
}
