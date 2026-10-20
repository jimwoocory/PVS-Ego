import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AgentCycleService } from "../application/services/agent-cycle-service.js";
import type { ProductFlowService } from "../application/services/product-flow.js";
import { DomainValidationError } from "../domain/validation.js";
import { renderAgentCyclePage } from "./agent-cycle-ui.js";

const json = (res:ServerResponse,status:number,value:unknown) => {res.writeHead(status,{"content-type":"application/json; charset=utf-8"});res.end(JSON.stringify(value));};
async function readBody(req:IncomingMessage) {
  let size=0;const chunks:Buffer[]=[];
  for await(const chunk of req){const buffer=Buffer.from(chunk);size+=buffer.length;if(size>100000)throw new DomainValidationError("请求过大");chunks.push(buffer);}
  try{return JSON.parse(Buffer.concat(chunks).toString("utf8")||"{}");}catch{throw new DomainValidationError("请求不是有效JSON");}
}
function validLocalRequest(req:IncomingMessage) {
  const host=req.headers.host??"";
  if(!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host))return false;
  const origin=req.headers.origin;
  if(origin){try{const parsed=new URL(origin);const protocol=(req.socket as typeof req.socket & {encrypted?:boolean}).encrypted?"https:":"http:";
    if(parsed.host!==host||parsed.protocol!==protocol||parsed.username||parsed.password||parsed.pathname!=="/"||parsed.search||parsed.hash)return false;
  }catch{return false;}}
  return true;
}
function authenticated(req:IncomingMessage) {
  const secret=process.env.PVS_MCP_TOKEN;
  if(!secret)return true;
  const supplied=req.headers.authorization?.replace(/^Bearer /,"")??"";
  const left=Buffer.from(secret),right=Buffer.from(supplied);
  return left.length===right.length&&timingSafeEqual(left,right);
}

/** Stateless Streamable HTTP: JSON responses, explicit 405 for optional SSE GET. */
export async function handleAgentCycleHttp(req:IncomingMessage,res:ServerResponse,url:URL,deps:{agentCycles?:AgentCycleService;productFlow:ProductFlowService}) {
  const globalPage=url.pathname==="/agent-cycle";
  const page=url.pathname.match(/^\/projects\/([^/]+)\/agent-cycle$/);
  const api=url.pathname.match(/^\/api\/projects\/([^/]+)\/agent-cycles(?:\/([^/]+)(?:\/(confirm|reply|cancel|advance|invoke))?)?$/);
  const mcp=url.pathname==="/api/pvs/mcp";
  if(!globalPage&&!page&&!api&&!mcp)return false;
  if(!validLocalRequest(req)){json(res,403,{error:"ORIGIN_REJECTED",message:"仅允许本机来源访问"});return true;}
  const service=deps.agentCycles;
  if(!service){json(res,503,{message:"Agent工作台尚未配置"});return true;}
  if(mcp){
    if(!authenticated(req)){json(res,401,{error:"UNAUTHORIZED"});return true;}
    if(req.method!=="POST"){res.writeHead(405,{allow:"POST"});res.end();return true;}
    if(!req.headers["content-type"]?.includes("application/json")){json(res,415,{error:"JSON_REQUIRED"});return true;}
    const version=req.headers["mcp-protocol-version"];
    if(version&&!['2025-03-26','2025-06-18','2025-11-25'].includes(String(version))){json(res,400,{error:"UNSUPPORTED_PROTOCOL"});return true;}
    let message:{jsonrpc?:string;id?:unknown;method?:string;params?:Record<string,unknown>};
    try{message=await readBody(req);}catch{json(res,400,{jsonrpc:"2.0",id:null,error:{code:-32700,message:"Parse error"}});return true;}
    if(!message||typeof message!=="object"){json(res,400,{jsonrpc:"2.0",id:null,error:{code:-32600,message:"Invalid request"}});return true;}
    if(message.jsonrpc!=="2.0"||!message.method){json(res,400,{jsonrpc:"2.0",id:message.id??null,error:{code:-32600,message:"Invalid request"}});return true;}
    if(message.id===undefined){if(message.method==="notifications/initialized"||message.method==="notifications/cancelled"){res.writeHead(202);res.end();}else json(res,400,{error:"UNSUPPORTED_NOTIFICATION"});return true;}
    const respond=(result:unknown)=>json(res,200,{jsonrpc:"2.0",id:message.id,result});
    const failure=(code:number,text:string)=>json(res,200,{jsonrpc:"2.0",id:message.id,error:{code,message:text}});
    if(message.method==="initialize"){
      const requested=String(message.params?.protocolVersion??"2025-03-26");
      respond({protocolVersion:['2025-03-26','2025-06-18','2025-11-25'].includes(requested)?requested:"2025-11-25",capabilities:{tools:{}},serverInfo:{name:"pvs-business-agent",version:"0.1.0"}});return true;
    }
    if(message.method==="ping"){respond({});return true;}
    const scopeProperties={projectId:{type:"string"},cycleId:{type:"string"},requestKey:{type:"string"}};
    const toolName=(id:string)=>"pvs_"+id.replace(/[^a-zA-Z0-9_]/g,"_");
    if(message.method==="tools/list"){
      respond({tools:[
        {name:"pvs_create_cycle",description:"幂等创建业务Agent任务，可指定验证阶段；默认覆盖完整业务；不授权发布、回复或付费",inputSchema:{type:"object",properties:{projectId:{type:"string"},goal:{type:"string"},requestKey:{type:"string"},stages:{type:"array",items:{type:"string",enum:["RESEARCH","STRATEGY","PRODUCTION","PUBLICATION","OPERATIONS","FEEDBACK"]},minItems:1,maxItems:6}},required:["projectId","goal","requestKey"],additionalProperties:false}},
        {name:"pvs_get_cycle",description:"读取本项目Agent任务、真实回执和待确认动作",inputSchema:{type:"object",properties:{projectId:{type:"string"},cycleId:{type:"string"}},required:["projectId","cycleId"],additionalProperties:false}},
        ...service.catalog.list().map(cap=>({name:toolName(cap.id),description:`${cap.title}：${cap.description}。发布、费用或业务决定只创建待用户确认动作。`,inputSchema:{type:"object",properties:{...scopeProperties,input:z.toJSONSchema(cap.inputSchema)},required:["projectId","cycleId","requestKey","input"],additionalProperties:false},annotations:{readOnlyHint:cap.effect==="READ",destructiveHint:cap.effect==="EXTERNAL_WRITE"}}))
      ]});return true;
    }
    if(message.method!=="tools/call"){failure(-32601,"Method not found");return true;}
    try{
      const name=String(message.params?.name??"");
      const args=message.params?.arguments;
      const base=z.object({projectId:z.string().min(1)}).passthrough().parse(args);
      let value:unknown;
      if(name==="pvs_create_cycle"){
        const input=z.object({projectId:z.string().min(1),goal:z.string().min(3),requestKey:z.string().min(1),stages:z.array(z.enum(["RESEARCH","STRATEGY","PRODUCTION","PUBLICATION","OPERATIONS","FEEDBACK"])).min(1).max(6).optional()}).strict().parse(args);
        value=await service.create(input.projectId,{goal:input.goal,requestKey:input.requestKey,...(input.stages?{stages:input.stages}:{})});
      }else if(name==="pvs_get_cycle"){
        const input=z.object({projectId:z.string().min(1),cycleId:z.string().min(1)}).strict().parse(args);
        value=await service.get(input.projectId,input.cycleId);if(!value)throw new DomainValidationError("当前项目没有该任务");
      }else{
        const capability=service.catalog.list().find(cap=>toolName(cap.id)===name);
        if(!capability){failure(-32602,"Unknown tool");return true;}
        const input=z.object({projectId:z.string().min(1),cycleId:z.string().min(1),requestKey:z.string().min(1).max(120),input:z.record(z.string(),z.unknown())}).strict().parse(args);
        let cycle=await service.invoke(base.projectId,input.cycleId,{capabilityId:capability.id,arguments:input.input,requestKey:input.requestKey});
        if(cycle.status==="READY"&&cycle.actions.find(action=>action.requestKey===input.requestKey)?.status==="PROPOSED")cycle=await service.advance(base.projectId,input.cycleId);
        const action=cycle.actions.find(item=>item.requestKey===input.requestKey);
        value={cycleId:cycle.id,status:cycle.status,action,reviewHref:`/projects/${encodeURIComponent(base.projectId)}/agent-cycle`};
      }
      respond({content:[{type:"text",text:JSON.stringify(value)}],structuredContent:{result:value}});
    }catch(error){respond({isError:true,content:[{type:"text",text:error instanceof Error?error.message:"调用未完成"}]});}
    return true;
  }
  if((globalPage||page)&&req.method==="GET"){
    const projectId=page?decodeURIComponent(page[1]!):undefined;
    const project=projectId?await deps.productFlow.getProject(projectId):undefined;
    if(projectId&&!project){json(res,404,{message:"项目不存在"});return true;}
    const content=renderAgentCyclePage({project:project?{id:project.id,name:project.name}:undefined,
      projects:projectId?[]:await deps.productFlow.listProjects(),cycles:projectId?await service.list(projectId):[],skills:service.skills.list(),
      snapshot:projectId?await service.catalog.snapshot(projectId):undefined});
    res.writeHead(200,{"content-type":"text/html; charset=utf-8"});res.end(content);return true;
  }
  if(!api){json(res,405,{message:"不支持此操作"});return true;}
  const projectId=decodeURIComponent(api[1]!),cycleId=api[2]?decodeURIComponent(api[2]):undefined,action=api[3];
  if(!await deps.productFlow.getProject(projectId)){json(res,404,{message:"项目不存在"});return true;}
  if(req.method==="GET"&&!action){const result=cycleId?await service.get(projectId,cycleId):await service.list(projectId);json(res,result?200:404,{result});return true;}
  if(req.method!=="POST"||!req.headers["content-type"]?.includes("application/json")){json(res,405,{message:"请用JSON提交操作"});return true;}
  const raw=await readBody(req);
  let result;
  if(!cycleId)result=await service.create(projectId,raw);
  else if(action==="advance")result=await service.advance(projectId,cycleId);
  else if(action==="confirm")result=await service.confirm(projectId,cycleId,z.object({expectedRevision:z.number().int().positive(),actionId:z.string(),inputHash:z.string().length(64)}).strict().parse(raw));
  else if(action==="reply")result=await service.reply(projectId,cycleId,z.object({expectedRevision:z.number().int().positive(),text:z.string().min(1).max(6000)}).strict().parse(raw));
  else if(action==="cancel")result=await service.cancel(projectId,cycleId,z.object({expectedRevision:z.number().int().positive()}).strict().parse(raw).expectedRevision);
  else if(action==="invoke")result=await service.invoke(projectId,cycleId,z.object({capabilityId:z.string(),arguments:z.record(z.string(),z.unknown()),requestKey:z.string().min(1).max(120)}).strict().parse(raw));
  else{json(res,404,{message:"未注册的任务动作"});return true;}
  json(res,200,{result});return true;
}
