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
/** Transport is injected only after existing Agent confirmation. The default
 * factory never registers this executor and the application guard is unchanged. */
export type GoOwnedResearchTransport=(request:GoOwnedResearchRequest)=>Promise<unknown[]>;
const eventSchema=z.object({id:z.string(),type:z.string(),sequence:z.number().int().positive(),scope:z.unknown().optional(),code:z.string().optional(),data:z.any().optional()});

export class GoOwnedEgoResearchRuntime implements EgoResearchRuntime{
  readonly identity:string;
  readonly ownedSourceUrl:string;
  private readonly options:{projectId:string;runId:string;sourceUrl:string;scope:GoResearchScope;executorFingerprint:string;projectsRoot:string};
  constructor(options:{projectId:string;runId:string;sourceUrl:string;scope:GoResearchScope;executorFingerprint:string;projectsRoot:string},private readonly execute:GoOwnedResearchTransport){
    const u=new URL(options.sourceUrl),valid=(v:string)=>/^[A-Za-z0-9-]{1,80}$/.test(v);
    if(!valid(options.projectId)||!valid(options.runId)||options.scope.projectId!==options.projectId||![options.scope.cycleId,options.scope.actionId].every(valid)||!(/^[a-f0-9]{64}$/.test(options.scope.contextHash))||!(/^[a-f0-9]{64}$/.test(options.executorFingerprint))||u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||[3090,3092,9223,19422,19423].includes(Number(u.port))||u.username||u.password||u.search||u.hash||!/^\/bridge-fixture\/[A-Za-z0-9-]{1,80}$/.test(u.pathname)||u.href!==options.sourceUrl)throw new EgoResearchError('BROWSER_PROVIDER_NOT_CONFIGURED','OWNED_SOURCE_REQUIRED');
    this.options=Object.freeze({...options,scope:Object.freeze({...options.scope})});
    this.ownedSourceUrl=options.sourceUrl;
    this.identity='go-owned-research:'+hashValue({projectId:options.projectId,runId:options.runId,sourceUrl:options.sourceUrl,scope:options.scope,executorFingerprint:options.executorFingerprint});
  }
  private async call(mode:GoOwnedResearchRequest['mode'],binding?:GoOwnedResearchBinding,screenshot=false){
    const id=randomUUID(),request:GoOwnedResearchRequest={op:'start',id,mode,timeoutMs:10000,scope:this.options.scope,researchRunId:this.options.runId,...(binding?{binding}:{}),...(screenshot?{captureScreenshot:true}:{})};
    const events=(await this.execute(request)).map(e=>eventSchema.parse(e));
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
    return events;
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
    if(input.screenshotPath){
      const project=await fs.realpath(path.join(this.options.projectsRoot,this.options.projectId)),dir=await fs.realpath(path.dirname(input.screenshotPath));
      if(!path.resolve(input.screenshotPath).startsWith(path.join(project,'.tmp')+path.sep)||!dir.startsWith(path.join(project,'.tmp')+path.sep))throw new EgoResearchError('BROWSER_SESSION_EXPIRED','SCREENSHOT_PATH_DENIED');
    }
    const events=await this.call('session-read',b,Boolean(input.screenshotPath));
    const documents=events.filter(e=>e.type==='document');
    if(documents.length!==1)throw new EgoResearchError('BROWSER_PROVIDER_ERROR','EXECUTION_RECEIPT_INVALID');
    const doc=z.object({sourceUrl:z.literal(this.ownedSourceUrl),finalUrl:z.literal(this.ownedSourceUrl),title:z.string().min(1).max(256),text:z.string().min(1).max(4000),fetchedAt:z.iso.datetime(),truncated:z.boolean()}).strict().parse(documents[0]!.data?.document);
    if(input.screenshotPath){
      const images=events.filter(e=>e.type==='screenshot');
      if(images.length!==1||typeof images[0]!.data?.png!=='string')throw new EgoResearchError('BROWSER_PROVIDER_ERROR','SCREENSHOT_RECEIPT_MISSING');
      const encoded=images[0]!.data.png as string,png=Buffer.from(encoded,'base64');
      if(png.length>1_000_000||png.toString('base64')!==encoded||!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new EgoResearchError('BROWSER_PROVIDER_ERROR','SCREENSHOT_RECEIPT_INVALID');
      await fs.writeFile(input.screenshotPath,png,{flag:'wx'});
    }
    return {...doc,links:[]};
  }
}
