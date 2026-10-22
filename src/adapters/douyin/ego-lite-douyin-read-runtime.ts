import {z} from "zod";
import {DouyinOpsRuntimeError,type DouyinOpsWork} from "../../application/ports/douyin-ops-runtime.js";
import type {AgentCapabilityContext} from "../../application/ports/agent-capability.js";
import type {EgoDouyinReadInput,EgoDouyinSnapshot,EgoLiteDouyinReadPort} from "../../application/ports/ego-lite-douyin-read.js";
import {metricKeys,metricAvailabilitySchema} from "../../domain/douyin-observation.js";

const identity=z.object({uid:z.string().regex(/^[1-9]\d{0,39}$/),secUid:z.string().max(200),uniqueId:z.string().max(100),shortId:z.string().max(100),nickname:z.string().max(100)}).strict();
const metrics=z.object({plays:z.number().int().nonnegative().optional(),likes:z.number().int().nonnegative().optional(),comments:z.number().int().nonnegative().optional(),shares:z.number().int().nonnegative().optional(),collects:z.number().int().nonnegative().optional()}).strict();
const work=z.object({awemeId:z.string().regex(/^\d{8,30}$/),description:z.string().max(2000),publishedAt:z.string().datetime().nullable(),author:identity.omit({shortId:true}),metrics,metricAvailability:metricAvailabilitySchema,durationMs:z.number().int().nonnegative(),coverUrl:z.literal(""),externalUrl:z.string().url()}).strict();
const resultSchema=z.object({status:z.enum(["READY","AUTH_REQUIRED","CONTROL_USER","RISK_CONTROL","PROVIDER_ERROR","SESSION_EXPIRED","ACCOUNT_CHANGED","DATA_UNAVAILABLE"]),source:z.enum(["LIVE_DOUYIN","LOCAL_FIXTURE_ONLY"]),checkedAt:z.string().datetime(),identity:identity.optional(),works:z.array(work).max(20).optional()}).strict();
const messages:Record<string,string>={NOT_CONNECTED:"尚未打开本仓库的独立 Ego Lite 运营会话。",READY:"账号已核验；页面只显示上次明确读取的结果。",AUTH_REQUIRED:"独立会话已打开。请在 Ego Lite 手动登录；登录后归还 Agent 控制，再准备核验账号。",CONTROL_USER:"用户仍持有页面控制。请在 Ego Lite 明确归还 Agent，再准备新的核验动作。",RISK_CONTROL:"平台要求验证，已停止读取；请手动处理，不自动重试。",PROVIDER_ERROR:"页面读取失败，未确认账号或数据；保留未知，不自动重试。",SESSION_EXPIRED:"运营会话已断开或重启，旧动作许可不能继续。",ACCOUNT_CHANGED:"实际账号与确认的 UID 不一致，已停止并清空本次作品结果。",DATA_UNAVAILABLE:"未取得可核验的作品数据，不能解释为零作品或零指标。"};

/** Business process cache only. GET/probe never starts a browser or reads a site. */
export class EgoLiteDouyinReadRuntime implements EgoLiteDouyinReadPort {
  private state:EgoDouyinSnapshot;
  private busy=false;
  constructor(readonly epoch:string,private readonly execute:(context:AgentCapabilityContext,input:EgoDouyinReadInput)=>Promise<{workerExited:boolean;terminal:string;result?:unknown}>,source:EgoDouyinSnapshot["source"]="LIVE_DOUYIN"){
    this.state={epoch,status:"NOT_CONNECTED",message:messages.NOT_CONNECTED!,source,works:[],coverage:"NOT_READ"};
  }
  peek(){return structuredClone(this.state);}
  async perform(context:AgentCapabilityContext,input:EgoDouyinReadInput){
    if(!context.confirmed||!context.localExecution||input.epoch!==this.epoch)throw new DouyinOpsRuntimeError("STALE_CONFIRMATION","需要当前会话的具体动作确认");
    if(this.busy)throw new DouyinOpsRuntimeError("BUSY","本机运营动作仍在执行");
    if(input.operation==="works"&&(!input.expectedAccountUid||input.expectedAccountUid!==this.state.identity?.uid))throw new DouyinOpsRuntimeError("ACCOUNT_CHANGED","请先核验并确认具体账号 UID");
    this.busy=true;
    // Clear visible/cached account data before any new live observation. A failed
    // read must not leave the previous account looking current.
    this.state={epoch:this.epoch,status:"READING",message:"正在执行已确认的本机只读动作。",source:this.state.source,works:[],coverage:"NOT_READ"};
    context.localExecution.report({phase:"CONNECTING",samples:0,workerExited:false});
    try{
      const reply=await this.execute(context,input);
      const phase=reply.terminal==="CANCELLED"?"CANCELLED":reply.terminal==="TIMED_OUT"?"TIMED_OUT":reply.terminal==="SUCCEEDED"?"SUCCEEDED":"FAILED";
      context.localExecution.report({phase,samples:0,workerExited:reply.workerExited===true});
      if(reply.workerExited&&["CANCELLED","TIMED_OUT"].includes(reply.terminal)){
        this.state={epoch:this.epoch,status:reply.terminal,message:reply.terminal==="CANCELLED"?"本次只读动作已取消，工作进程退出已确认；没有自动重试。":"本次只读动作已超时，工作进程退出已确认；没有自动重试。",source:this.state.source,checkedAt:new Date().toISOString(),works:[],coverage:"NOT_READ"};return this.peek();
      }
      if(!reply.workerExited||reply.terminal!=="SUCCEEDED")throw new DouyinOpsRuntimeError("SESSION_EXPIRED","执行未成功或缺少退出确认；旧结果不能复用");
      const value=resultSchema.parse(reply.result);
      if(value.source!==this.state.source)throw new DouyinOpsRuntimeError("PROTOCOL_ERROR","真实平台与合成证据类型不一致");
      if(value.status==="READY"&&!value.identity)throw new DouyinOpsRuntimeError("PROTOCOL_ERROR","未提供可核验的账号 UID");
      const works=value.works??[];
      if(input.operation!=="works"&&works.length)throw new DouyinOpsRuntimeError("PROTOCOL_ERROR","账号核验动作不能顺带采集作品");
      if(input.operation==="works"&&value.status==="READY"&&value.identity?.uid!==input.expectedAccountUid)throw new DouyinOpsRuntimeError("ACCOUNT_CHANGED","返回账号与本次确认不一致");
      if(new Set(works.map(w=>w.awemeId)).size!==works.length)throw new DouyinOpsRuntimeError("PROTOCOL_ERROR","作品重复，停止接受本次数据");
      for(const w of works){
        if(w.author.uid!==value.identity?.uid||w.externalUrl!=="https://www.douyin.com/video/"+w.awemeId)throw new DouyinOpsRuntimeError("ACCOUNT_CHANGED","作品作者或来源不属于确认的本人账号");
        for(const key of metricKeys)if((w.metricAvailability[key]==="OBSERVED")!==(w.metrics[key]!==undefined))throw new DouyinOpsRuntimeError("PROTOCOL_ERROR","指标数值与可见性不一致");
      }
      if(value.status!=="READY"&&(works.length||value.identity))throw new DouyinOpsRuntimeError("PROTOCOL_ERROR","阻断结果不能夹带账号或作品");
      this.state={epoch:this.epoch,status:value.status,message:messages[value.status]!,source:value.source,checkedAt:value.checkedAt,...(value.identity?{identity:value.identity}:{}),works,
        ...(input.operation==="works"&&value.status==="READY"?{worksCheckedAt:value.checkedAt}:{}),coverage:input.operation==="works"&&value.status==="READY"?"FIRST_PAGE_ONLY":"NOT_READ"};
      return this.peek();
    }catch(error){this.state={epoch:this.epoch,status:"SESSION_EXPIRED",message:messages.SESSION_EXPIRED!,source:this.state.source,works:[],coverage:"NOT_READ"};throw error;}
    finally{this.busy=false;}
  }
  async probe(){const s=this.peek();return {ok:s.status==="READY",ready:s.status==="READY",status:s.status,bridgeVersion:"ego-lite-douyin-read-v1",message:s.message,capabilities:{identity:true,myWorks:true,comments:false,replies:false,publish:false,download:false}};}
  async identity(){if(this.state.status!=="READY"||!this.state.identity||!this.state.checkedAt||Date.now()-Date.parse(this.state.checkedAt)>120000)throw new DouyinOpsRuntimeError("AUTH_REQUIRED","没有两分钟内明确核验的账号；请准备新的核验动作");return structuredClone(this.state.identity);}
  async listMyWorks(count=20){await this.identity();if(!this.state.worksCheckedAt)throw new DouyinOpsRuntimeError("DATA_UNAVAILABLE","尚未明确确认并读取作品");return structuredClone(this.state.works.slice(0,Math.min(20,Math.max(1,count))));}
  async getWork(_id:string):Promise<DouyinOpsWork>{throw new DouyinOpsRuntimeError("EXPLICIT_READ_REQUIRED","本阶段只提供明确读取并标记时间的作品快照；不能把缓存重新标记为一次新的平台采集，请准备新的只读动作");}
  private unsupported():never{throw new DouyinOpsRuntimeError("WRITE_OPERATION_DISABLED","本次接入仅核验账号及本人第一页作品指标，不提供搜索、评论、回复、下载或发布");}
  async searchWorks():Promise<never>{return this.unsupported();}async getComments():Promise<never>{return this.unsupported();}async getReplies():Promise<never>{return this.unsupported();}async getDownloadMetadata():Promise<never>{return this.unsupported();}
}
