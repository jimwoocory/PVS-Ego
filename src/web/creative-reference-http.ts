import type {IncomingMessage,ServerResponse} from "node:http";
import {z} from "zod";
import {DomainValidationError} from "../domain/validation.js";
import type {CreativeReferenceService} from "../application/services/creative-reference-service.js";
import type {ProductFlowService} from "../application/services/product-flow.js";
import {renderCreativeReferencePage} from "./creative-reference-ui.js";
const json=(res:ServerResponse,status:number,data:unknown)=>{res.writeHead(status,{"content-type":"application/json; charset=utf-8"});res.end(JSON.stringify(data));};
async function body(req:IncomingMessage){
 if(!req.headers["content-type"]?.includes("application/json"))throw new DomainValidationError("审核请求必须使用JSON格式");
 const chunks:Buffer[]=[];let bytes=0;for await(const chunk of req){const b=Buffer.from(chunk);bytes+=b.length;if(bytes>150000)throw new DomainValidationError("审核请求过大");chunks.push(b)}
 try{return JSON.parse(Buffer.concat(chunks).toString("utf8")||"{}")}catch{throw new DomainValidationError("请求格式无效")}
}
export async function handleCreativeReferenceHttp(req:IncomingMessage,res:ServerResponse,url:URL,d:{
 productFlow:ProductFlowService;creativeReferences?:CreativeReferenceService;collectCreativeReferences?:(projectId:string)=>Promise<{failures:string[];mediaCount:number}>
}):Promise<boolean>{
 const page=url.pathname.match(/^\/projects\/([^/]+)\/creative-references$/),api=url.pathname.match(/^\/api\/projects\/([^/]+)\/creative-references(?:\/(review|reanalyze|collect))?$/);
 if(!page&&!api)return false;
 if(!d.creativeReferences){json(res,503,{message:"创作素材池尚未部署"});return true}
 const projectId=decodeURIComponent((page??api)![1]!),workspace=await d.productFlow.getWorkspace(projectId);
 if(!workspace){json(res,404,{message:"项目不存在"});return true}
 try{
  if(req.method==="GET"&&!api?.[2]){
   const data=await d.creativeReferences.pageData(projectId);
   if(page){res.writeHead(200,{"content-type":"text/html; charset=utf-8"});res.end(renderCreativeReferencePage(workspace.project,data))}else json(res,200,data);
   return true;
  }
  if(req.method!=="POST"||!api?.[2]){json(res,405,{message:"不支持此操作"});return true}
  if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)throw new DomainValidationError("不接受其他网页发起的审核操作");
  const input=await body(req);
  if(api[2]==="review"){json(res,200,await d.creativeReferences.review(projectId,input));return true}
  if(api[2]==="reanalyze"){
   const parsed=z.object({candidateId:z.string().min(1)}).strict().parse(input);
   json(res,200,await d.creativeReferences.reanalyze(projectId,parsed.candidateId));return true;
  }
  z.object({}).strict().parse(input);
  if(!d.collectCreativeReferences)throw new DomainValidationError("现有研究候选提取尚未配置，请运行深度研究");
  json(res,200,await d.collectCreativeReferences(projectId));return true;
 }catch(error){if(error instanceof DomainValidationError||error instanceof z.ZodError){json(res,400,{message:error.message});return true}throw error}
}
