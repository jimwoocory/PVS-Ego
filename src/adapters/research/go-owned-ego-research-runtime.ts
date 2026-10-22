import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {hashValue} from '../../domain/hashing.js';
import {EgoResearchError,type EgoResearchRuntime,type EgoResearchBinding,type EgoResearchCapture} from '../../application/ports/ego-research-runtime.js';

const bindingSchema=z.object({instanceId:z.string().min(1),spaceId:z.number().int().positive(),spaceName:z.string().min(1),profileId:z.literal('Default'),targetId:z.string().min(1),sessionId:z.string().regex(/^[a-f0-9]{32}$/)}).strict();
export type GoOwnedResearchBinding=z.infer<typeof bindingSchema>;
export type GoResearchScope={projectId:string;cycleId:string;actionId:string;contextHash:string};
export type GoOwnedResearchRequest={op:'start';id:string;mode:'session-open'|'session-read';timeoutMs:number;scope:GoResearchScope;researchRunId:string;binding?:GoOwnedResearchBinding;captureScreenshot?:boolean};
/** Only the trusted local launcher injects the transport. Each request still
 * requires the existing Agent confirmation; the application guard is unchanged. */
export type GoOwnedResearchTransport=(request:GoOwnedResearchRequest)=>Promise<unknown[]>;
const eventSchema=z.object({id:z.string(),type:z.string(),sequence:z.number().int().positive(),scope:z.unknown().optional(),code:z.string().optional(),data:z.any().optional()});
const documentSchema=(sourceUrl:string)=>z.object({sourceUrl:z.literal(sourceUrl),finalUrl:z.literal(sourceUrl),title:z.string().min(1).max(256),text:z.string().min(1).max(4000),fetchedAt:z.iso.datetime(),truncated:z.boolean()}).strict();
function invalidReceipt():never {throw new EgoResearchError('BROWSER_PROVIDER_ERROR','EXECUTION_RECEIPT_INVALID');}

export class GoOwnedEgoResearchRuntime implements EgoResearchRuntime{
  readonly identity:string;
  readonly ownedSourceUrl:string;
  private readonly options:{projectId:string;runId:string;sourceUrl:string;scope:GoResearchScope;executorFingerprint:string;projectsRoot:string};
  constructor(options:{projectId:string;runId:string;sourceUrl:string;scope:GoResearchScope;executorFingerprint:string;projectsRoot:string},private readonly execute:GoOwnedResearchTransport){
    const u=new URL(options.sourceUrl),valid=(v:string)=>/^[A-Za-z0-9-]{1,80}$/.test(v);
    if(!path.isAbsolute(options.projectsRoot)||!valid(options.projectId)||!valid(options.runId)||options.scope.projectId!==options.projectId||![options.scope.cycleId,options.scope.actionId].every(valid)||!(/^[a-f0-9]{64}$/.test(options.scope.contextHash))||!(/^[a-f0-9]{64}$/.test(options.executorFingerprint))||u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||[3090,3092,9223,19422,19423].includes(Number(u.port))||u.username||u.password||u.search||u.hash||!/^\/bridge-fixture\/[A-Za-z0-9-]{1,80}$/.test(u.pathname)||u.href!==options.sourceUrl)throw new EgoResearchError('BROWSER_PROVIDER_NOT_CONFIGURED','OWNED_SOURCE_REQUIRED');
    this.options=Object.freeze({...options,scope:Object.freeze({...options.scope})});
    this.ownedSourceUrl=options.sourceUrl;
    this.identity='go-owned-research:'+hashValue({projectId:options.projectId,runId:options.runId,sourceUrl:options.sourceUrl,scope:options.scope,executorFingerprint:options.executorFingerprint});
  }
  private async call(mode:GoOwnedResearchRequest['mode'],binding?:GoOwnedResearchBinding,screenshot=false){
    const id=randomUUID(),request:GoOwnedResearchRequest=Object.freeze({op:'start',id,mode,timeoutMs:10000,scope:this.options.scope,researchRunId:this.options.runId,...(binding?{binding:Object.freeze({...binding})}:{}),...(screenshot?{captureScreenshot:true}:{})});
    const raw=await this.execute(request);
    if(!Array.isArray(raw)||raw.length<1||raw.length>66)invalidReceipt();
    let events:Array<z.infer<typeof eventSchema>>;
    try{events=raw.map(e=>eventSchema.parse(e));}catch{invalidReceipt();}
    let sequence=0;
    for(const e of events){
      if(e.id!==id||e.sequence<=sequence||(e.type!=='rejected'&&hashValue(e.scope)!==hashValue(request.scope)))throw new EgoResearchError('BROWSER_PROVIDER_ERROR','EXECUTION_RECEIPT_INVALID');
      sequence=e.sequence;
    }
    const terminal=events.filter(e=>['succeeded','failed','timed_out','cancelled','rejected'].includes(e.type));
    if(terminal.length!==1||events.at(-1)!==terminal[0])throw new EgoResearchError('BROWSER_PROVIDER_ERROR','EXECUTION_RECEIPT_INVALID');
    const end=terminal[0]!;
    if(end.type!=='succeeded'||end.data?.workerExited!==true){
      const code=end.code??end.type.toUpperCase();
      throw new EgoResearchError(['HOST_INSTANCE_CHANGED','CONTROL_CHANGED','FIXTURE_BINDING_CHANGED','SESSION_BINDING_DENIED','SESSION_ALREADY_BOUND'].includes(code)?'BROWSER_SESSION_EXPIRED':'BROWSER_PROVIDER_ERROR',code);
    }
    const expected=mode==='session-open'?['started','connected','page','session','done','succeeded']:['started','connected','page','visibility','document',...(screenshot?['screenshot']:[]),'done','succeeded'];
    if(hashValue(events.map(e=>e.type))!==hashValue(expected)||end.data?.workerStarted!==true)invalidReceipt();
    const host=events[1]!.data,page=events[2]!.data;
    let verifiedBinding:GoOwnedResearchBinding;
    try{verifiedBinding=mode==='session-open'?bindingSchema.parse(events[3]!.data?.binding):bindingSchema.parse(request.binding);}catch{invalidReceipt();}
    if(host?.kind!=='connected'||host.instanceId!==verifiedBinding.instanceId||page?.kind!=='page'||page.spaceId!==verifiedBinding.spaceId||page.targetId!==verifiedBinding.targetId||verifiedBinding.spaceName!=='pvs-research-'+this.options.projectId+'-'+this.options.runId||events.at(-2)!.data?.kind!=='done')invalidReceipt();
    if(mode==='session-open'){if(events[3]!.data?.kind!=='session')invalidReceipt();}
    else {
      const visible=events[3]!.data;
      if(visible?.kind!=='visibility'||visible.visibilitySource!=='OWNED_HOST_LAYOUT_SNAPSHOT'||!['visible','hidden'].includes(visible.visibility)||screenshot&&visible.visibility!=='visible'||events[4]!.data?.kind!=='document')invalidReceipt();
      try{documentSchema(this.ownedSourceUrl).parse(events[4]!.data?.document);}catch{invalidReceipt();}
      if(screenshot&&(events[5]!.data?.kind!=='screenshot'||typeof events[5]!.data?.png!=='string'||events[5]!.data.png.length>1_333_336))invalidReceipt();
    }
    return events;
  }
  private async screenshotTarget(file:string){
    try{
      const root=path.resolve(this.options.projectsRoot),project=path.join(root,this.options.projectId),temp=path.join(project,'.tmp'),target=path.resolve(file),dir=path.dirname(target);
      if(!path.isAbsolute(file)||!target.startsWith(temp+path.sep)||!dir.startsWith(temp+path.sep)||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.png$/i.test(path.basename(target)))throw Error('PATH_DENIED');
      for(let cursor=dir;cursor!==root;cursor=path.dirname(cursor))if((await fs.lstat(cursor)).isSymbolicLink())throw Error('PATH_DENIED');
      if(await fs.realpath(root)!==root||await fs.realpath(project)!==project||await fs.realpath(dir)!==dir)throw Error('PATH_DENIED');
      try{await fs.lstat(target);throw Error('TARGET_EXISTS');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      return target;
    }catch{throw new EgoResearchError('BROWSER_SESSION_EXPIRED','SCREENSHOT_PATH_DENIED');}
  }
  async open(spaceName:string):Promise<EgoResearchBinding>{
    if(spaceName!=='pvs-research-'+this.options.projectId+'-'+this.options.runId)throw new EgoResearchError('BROWSER_SESSION_EXPIRED','SESSION_SCOPE_CHANGED');
    const events=await this.call('session-open'),bindings=events.filter(e=>e.type==='session');
    if(bindings.length!==1)throw new EgoResearchError('BROWSER_PROVIDER_ERROR','EXECUTION_RECEIPT_INVALID');
    const b=bindingSchema.parse(bindings[0]!.data?.binding);
    if(b.spaceName!==spaceName)throw new EgoResearchError('BROWSER_SESSION_EXPIRED','SESSION_SCOPE_CHANGED');
    return b;
  }
  async read(binding:EgoResearchBinding,input:{url?:string;screenshotPath?:string}):Promise<EgoResearchCapture>{
    const b=bindingSchema.parse(binding);
    if(b.spaceName!=='pvs-research-'+this.options.projectId+'-'+this.options.runId||input.url&&input.url!==this.ownedSourceUrl)throw new EgoResearchError('BROWSER_SESSION_EXPIRED','SESSION_SCOPE_CHANGED');
    const screenshotPath=input.screenshotPath?await this.screenshotTarget(input.screenshotPath):undefined;
    const events=await this.call('session-read',b,Boolean(input.screenshotPath));
    const documents=events.filter(e=>e.type==='document');
    if(documents.length!==1)throw new EgoResearchError('BROWSER_PROVIDER_ERROR','EXECUTION_RECEIPT_INVALID');
    const doc=documentSchema(this.ownedSourceUrl).parse(documents[0]!.data?.document);
    if(input.screenshotPath){
      const images=events.filter(e=>e.type==='screenshot');
      if(images.length!==1||typeof images[0]!.data?.png!=='string')throw new EgoResearchError('BROWSER_PROVIDER_ERROR','SCREENSHOT_RECEIPT_MISSING');
      const encoded=images[0]!.data.png as string,png=Buffer.from(encoded,'base64');
      if(png.length>1_000_000||png.toString('base64')!==encoded||!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new EgoResearchError('BROWSER_PROVIDER_ERROR','SCREENSHOT_RECEIPT_INVALID');
      // The executor is asynchronous; the caller's directory may have changed.
      await this.screenshotTarget(screenshotPath!);
      await fs.writeFile(screenshotPath!,png,{flag:'wx'});
    }
    return {...doc,links:[]};
  }
}
