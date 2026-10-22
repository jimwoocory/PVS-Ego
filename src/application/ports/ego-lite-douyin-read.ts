import type {AgentCapabilityContext} from "./agent-capability.js";
import type {DouyinOpsIdentity,DouyinOpsWork,DouyinOpsRuntime} from "./douyin-ops-runtime.js";

export type EgoDouyinOperation="open"|"identity"|"works";
export type EgoDouyinReadInput={epoch:string;operation:EgoDouyinOperation;expectedAccountUid?:string;count?:number};
export type EgoDouyinSnapshot={epoch:string;status:string;message:string;checkedAt?:string;source:"LIVE_DOUYIN"|"LOCAL_FIXTURE_ONLY";identity?:DouyinOpsIdentity;works:DouyinOpsWork[];worksCheckedAt?:string;coverage:"NOT_READ"|"FIRST_PAGE_ONLY"};
export interface EgoLiteDouyinReadPort extends DouyinOpsRuntime {
  peek():EgoDouyinSnapshot;
  perform(context:AgentCapabilityContext,input:EgoDouyinReadInput):Promise<EgoDouyinSnapshot>;
}
