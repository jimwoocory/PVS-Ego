import {z} from "zod";
import type {DouyinBrowserPublishResult} from "./douyin-browser-publisher-runtime.js";

export const browserPageBindingSchema=z.object({runtimeId:z.string().min(1),instanceId:z.string().min(1),spaceId:z.string().min(1),pageId:z.string().min(1),documentId:z.string().min(1),accountKey:z.string().min(1)}).strict();
export type BrowserPageBinding=z.infer<typeof browserPageBindingSchema>;
export const browserPublishScopeSchema=z.object({projectId:z.string().min(1),packageId:z.string().min(1),providerType:z.literal("DOUYIN_BROWSER_AUTOMATION"),assemblyId:z.string().min(1),artifactId:z.string().min(1),videoSha256:z.string().regex(/^[a-f0-9]{64}$/),title:z.string().min(1),description:z.string(),tags:z.array(z.string()),declaration:z.literal("内容由AI生成"),accountKey:z.string().min(1),account:z.object({type:z.literal("DOUYIN_UNIQUE_ID"),id:z.string().min(1)}).strict(),runtimeId:z.string().min(1),expiresAt:z.string().datetime()}).strict();
export type BrowserPublishScope=z.infer<typeof browserPublishScopeSchema>;
export type BrowserPageSnapshot={binding:BrowserPageBinding;account:{type:"DOUYIN_UNIQUE_ID";id:string};title:string;description:string;tags:string[];declaration:string;videoSha256:string;uploadComplete:boolean;challenge:"NONE"|"CAPTCHA"|"LOGIN"|"RISK";control:"AGENT"|"USER";connected:boolean};
/** Optional staged candidate under the existing runtime. prepare must NEVER submit; resume must NEVER upload/fill/submit. */
export interface BrowserPublishPreparationRuntime {
 readonly identity:string;
 prepare(scope:BrowserPublishScope,videoPath:string):Promise<BrowserPageSnapshot>;
 inspect(binding:BrowserPageBinding):Promise<BrowserPageSnapshot>;
 handoff(binding:BrowserPageBinding):Promise<void>;
 resume(binding:BrowserPageBinding):Promise<BrowserPageSnapshot>;
 /** Revalidate the same binding/scope immediately before its single submit action; never upload, reopen or retry. */
 submit(binding:BrowserPageBinding,scope:BrowserPublishScope):Promise<DouyinBrowserPublishResult>;
}
export const browserPublishCheckpointSchema=z.object({
 id:z.string().min(1),projectId:z.string().min(1),packageId:z.string().min(1),version:z.number().int().positive(),
 phase:z.enum(["PREPARING","WAITING_PLATFORM_VERIFICATION","HANDOFF_PENDING","WAITING_USER_CONTROL","RESUMING","RESTORED_WAITING_CONTINUE","READY_FOR_CONFIRMATION","SUBMITTING","SUBMISSION_UNKNOWN","PUBLISHED_CONFIRMED","BLOCKED"]),
 scope:browserPublishScopeSchema,scopeHash:z.string().regex(/^[a-f0-9]{64}$/),binding:browserPageBindingSchema.optional(),reason:z.string().optional(),createdAt:z.string().datetime(),contentHash:z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
export type BrowserPublishCheckpoint=z.infer<typeof browserPublishCheckpointSchema>;
export interface BrowserPublishCheckpointRepository {
 latest(projectId:string,packageId:string):Promise<BrowserPublishCheckpoint|null>;
 append(checkpoint:BrowserPublishCheckpoint,expectedVersion:number):Promise<boolean>;
}
