import type {IncomingMessage,ServerResponse} from "node:http";
import {z} from "zod";
import type {OperationsEvidenceReader} from "../application/services/operations-evidence-reader.js";
import type {DouyinOperationsScheduleService} from "../application/services/douyin-operations-schedule-service.js";
import {renderScheduleEvidence,renderCandidateEvidence} from "./operations-evidence-ui.js";
function local(req:IncomingMessage){
 const host=req.headers.host??"";if(!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)||req.headers["sec-fetch-site"]==="cross-site")return false;
 if(req.headers.origin){try{const u=new URL(req.headers.origin),protocol=(req.socket as typeof req.socket&{encrypted?:boolean}).encrypted?"https:":"http:";if(u.origin!==protocol+"//"+host||u.username||u.password)return false;}catch{return false;}}
 return true;
}
export async function handleOperationsEvidenceHttp(req:IncomingMessage,res:ServerResponse,url:URL,deps:{operationsEvidence?:OperationsEvidenceReader;douyinSchedules?:DouyinOperationsScheduleService;productFlow:{getProject(id:string):Promise<unknown>}}){
 const match=url.pathname.match(/^(\/api)?\/projects\/([^/]+)\/operations\/(schedules|candidates)\/([^/]+)(\/resume)?$/);if(!match)return false;
 res.setHeader("cache-control","no-store");res.setHeader("x-content-type-options","nosniff");res.setHeader("content-security-policy","default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
 const json=(code:number,value:unknown)=>{res.writeHead(code,{"content-type":"application/json; charset=utf-8"});res.end(JSON.stringify(value));};
 if(!local(req)){json(403,{error:"ORIGIN_REJECTED",message:"仅允许本机同源核对"});return true;}
 let projectId:string,id:string;try{projectId=decodeURIComponent(match[2]!);id=decodeURIComponent(match[4]!);}catch{json(404,{error:"EVIDENCE_NOT_FOUND"});return true;}
 if(!await deps.productFlow.getProject(projectId)){json(404,{error:"EVIDENCE_NOT_FOUND"});return true;}
 if(!deps.operationsEvidence){json(503,{message:"保存证据审阅尚未配置"});return true;}
 const kind=match[3]!,resume=Boolean(match[5]);
 if(resume){
  if(!match[1]||kind!=="schedules"||req.method!=="POST"){res.setHeader("allow","POST");json(405,{message:"请从具体计划提交续接确认"});return true;}
  if(!req.headers["content-type"]?.includes("application/json")){json(415,{message:"续接确认需要JSON"});return true;}
  try{
   let size=0;const chunks=[];for await(const chunk of req){const b=Buffer.from(chunk);size+=b.length;if(size>16000)throw Error("BODY_LIMIT");chunks.push(b);}
   const input=z.object({expectedRevision:z.number().int().positive(),inputHash:z.string().regex(/^[a-f0-9]{64}$/),expectedAccountId:z.string().trim().min(1).max(100),confirmed:z.literal(true)}).strict().parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
   const inspection=await deps.operationsEvidence.schedule(projectId,id);
   if(!inspection){json(404,{message:"当前项目没有这份计划"});return true;}
   if(inspection.status!=="VERIFIED"||!inspection.resumeAllowed||!deps.douyinSchedules){json(409,{message:"原计划存在未收尾读取、范围变化或已达上限，请重新打开核对，不自动重读。"});return true;}
   const result=await deps.douyinSchedules.resume({projectId,id,...input});
   json(200,{result,message:"已保存原范围续接，尚未进行采集"});
  }catch{json(409,{message:"续接未保存：确认内容、计划版本或运营账号已变化。请重新打开原计划核对，不会自动重试。"});}
  return true;
 }
 if(req.method!=="GET"){res.setHeader("allow","GET");json(405,{error:"READ_ONLY",message:"保存证据只允许读取"});return true;}
 const inspection=kind==="schedules"?await deps.operationsEvidence.schedule(projectId,id):await deps.operationsEvidence.candidate(projectId,id);
 if(!inspection){json(404,{error:"EVIDENCE_NOT_FOUND"});return true;}
 const code=inspection.status==="VERIFIED"?200:409;
 if(match[1])json(code,{result:inspection});
 else {const content=kind==="schedules"?renderScheduleEvidence(projectId,id,inspection as NonNullable<Awaited<ReturnType<OperationsEvidenceReader["schedule"]>>>):renderCandidateEvidence(projectId,inspection as NonNullable<Awaited<ReturnType<OperationsEvidenceReader["candidate"]>>>);res.writeHead(code,{"content-type":"text/html; charset=utf-8"});res.end(content);}
 return true;
}
