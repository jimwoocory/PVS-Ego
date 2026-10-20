import "../../isolation/require-isolation.js";
import fs from "node:fs/promises";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {z} from "zod";
import {hashValue,sha256Bytes} from "../../domain/hashing.js";
import {EgoResearchError,type EgoResearchBinding,type EgoResearchCapture,type EgoResearchRuntime} from "../../application/ports/ego-research-runtime.js";

const exec=promisify(execFile);
export const egoResearchConfigSchema=z.object({contract:z.literal("pvs-ego-research-v1"),cliPath:z.string().min(1),cliSha256:z.string().regex(/^[a-f0-9]{64}$/),
  sdkPath:z.string().min(1),sdkSha256:z.string().regex(/^[a-f0-9]{64}$/),dataDir:z.string().min(1),searchUrlTemplate:z.string().min(1),
  allowPrivateNetwork:z.boolean().default(false),maxQueries:z.number().int().min(1).max(6).default(3),maxSources:z.number().int().min(1).max(12).default(6),
  settleMs:z.number().int().min(100).max(10000).default(1500)}).strict();
export type EgoResearchConfig=z.infer<typeof egoResearchConfigSchema>;
/** Uses the pinned independent Windows CLI and its supported SDK; never imports a real browser profile. */
export class EgoCliResearchRuntime implements EgoResearchRuntime{
  readonly identity:string;
  constructor(readonly config:EgoResearchConfig){
    if(![config.cliPath,config.sdkPath,config.dataDir].every(path.isAbsolute))throw new EgoResearchError("BROWSER_PROVIDER_NOT_CONFIGURED");
    this.identity=hashValue(config);
  }
  private async call(body:string){
    for(const [file,sha] of [[this.config.cliPath,this.config.cliSha256],[this.config.sdkPath,this.config.sdkSha256]])
      if(sha256Bytes(await fs.readFile(file!))!==sha)throw new EgoResearchError("BROWSER_SESSION_EXPIRED");
    const env={...process.env,EGO_WINDOWS_DATA_DIR:this.config.dataDir,PSModulePath:path.join(process.env.SystemRoot??"C:/Windows","System32/WindowsPowerShell/v1.0/Modules")};
    // Only these fixed scripts execute. Web text is returned as data and never evaluated as instructions.
    try{const {stdout}=await exec(process.execPath,[this.config.cliPath,"nodejs","--sdk-path",this.config.sdkPath,"-e",body],{env,windowsHide:true,timeout:45000,maxBuffer:2_000_000});
      const line=stdout.split(/\r?\n/).reverse().find(l=>l.startsWith("PVS_EGO_RESULT "));
      if(!line)throw new EgoResearchError("BROWSER_SESSION_EXPIRED","NO_CAPTURE_RESULT");return JSON.parse(line.slice(15));
    }catch(error){if(error instanceof EgoResearchError)throw error;
      const err=error as {stderr?:string;code?:string};const diagnostic=err.stderr??"";
      // Keep only a bounded machine code, never raw browser output, credentials or page text in errors.
      const match=/"error_code"\s*:\s*"([A-Z][A-Z0-9_]{1,99})"/.exec(diagnostic);
      const detail=/timed out: Page\.captureScreenshot/.test(diagnostic)?"SCREENSHOT_TIMEOUT":match?.[1]??(/ETIMEDOUT|ENOENT|EPERM/.exec(String(err.code))?.[0])??"CLI_EXECUTION_FAILED";
      throw new EgoResearchError(/PVS_EGO_SESSION_EXPIRED|EGO_TASK_SPACE|EGO_.*DISCONNECTED|EGO_WINDOWS_HOST_ABSENT|EGO_CONNECTION_CLOSED/.test(diagnostic)?"BROWSER_SESSION_EXPIRED":"BROWSER_PROVIDER_ERROR",detail);}
  }
  async open(spaceName:string):Promise<EgoResearchBinding>{
    const raw=await this.call(`const pvsName=${JSON.stringify(spaceName)};const pvsSpaces=(await ego.listTaskSpaces()).taskSpaces;if(pvsSpaces.some(s=>s.name===pvsName))throw Error('PVS_EGO_SESSION_EXPIRED');const pvsTask=await taskSpace(pvsName);console.log('PVS_EGO_RESULT '+JSON.stringify({instanceId:process.env.EGO_BROWSER_HOST_INSTANCE_ID,spaceId:pvsTask.spaceId,spaceName:pvsName,profileId:'Default'}));`);
    return z.object({instanceId:z.string().min(1),spaceId:z.number().int().positive(),spaceName:z.literal(spaceName),profileId:z.literal("Default")}).parse(raw);
  }
  async read(binding:EgoResearchBinding,input:{url?:string;screenshotPath?:string}):Promise<EgoResearchCapture>{
    const raw=await this.call(`const pvsBinding=${JSON.stringify(binding)};if(process.env.EGO_BROWSER_HOST_INSTANCE_ID!==pvsBinding.instanceId)throw Error('PVS_EGO_SESSION_EXPIRED');const pvsOwned=(await ego.listTaskSpaces()).taskSpaces.find(s=>s.id===pvsBinding.spaceId);if(!pvsOwned||pvsOwned.name!==pvsBinding.spaceName||pvsOwned.profileId!==pvsBinding.profileId||pvsOwned.ownership!=='agent')throw Error('PVS_EGO_SESSION_EXPIRED');const pvsTask=await taskSpace(pvsBinding.spaceId);const pvsPage=pvsTask.page('p1');${input.url?`await pvsPage.goto(${JSON.stringify(input.url)},{waitUntil:'domcontentloaded',timeout:20000});`:""}await pvsPage.waitForSelector('body');await new Promise(r=>setTimeout(r,${this.config.settleMs}));const pvsDoc=await pvsPage.evaluate(()=>{const text=(document.body?.innerText??'').trim();const heading=(document.title+' '+(document.querySelector('h1')?.textContent??''));const blocker=document.querySelector('input[type=password]')?'LOGIN_REQUIRED':/验证码|滑块|安全验证|verify you are human|captcha/i.test(heading)?'CAPTCHA_REQUIRED':/访问过于频繁|异常访问|access denied/i.test(heading)?'RISK_CONTROL':/登录|sign in|log in/i.test(heading)&&document.querySelector('form')?'LOGIN_REQUIRED':undefined;return {finalUrl:location.href,title:document.title,text:text.slice(0,300000),truncated:text.length>300000,blocker,links:Array.from(document.querySelectorAll(document.querySelector('#b_results .b_algo h2 a[href]')?'#b_results .b_algo h2 a[href]':'a[href]')).slice(0,150).map(a=>({url:a.href,title:(a.innerText??'').trim().slice(0,300)}))};});${input.screenshotPath?`if(!pvsDoc.blocker)await pvsPage.screenshot({path:${JSON.stringify(input.screenshotPath)},fullPage:false});`:""}console.log('PVS_EGO_RESULT '+JSON.stringify({...pvsDoc,sourceUrl:${JSON.stringify(input.url??"")},fetchedAt:new Date().toISOString()}));`);
    return z.object({sourceUrl:z.string(),finalUrl:z.string(),title:z.string(),text:z.string().max(300000),fetchedAt:z.string().datetime(),truncated:z.boolean(),
      links:z.array(z.object({url:z.string(),title:z.string()})).max(150),blocker:z.enum(["LOGIN_REQUIRED","CAPTCHA_REQUIRED","RISK_CONTROL"]).optional()}).parse(raw);
  }
}
