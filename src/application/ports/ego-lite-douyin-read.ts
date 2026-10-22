import type {AgentCapabilityContext} from "./agent-capability.js";
import type {DouyinOpsIdentity,DouyinOpsWork,DouyinOpsRuntime} from "./douyin-ops-runtime.js";

export type EgoDouyinOperation="open"|"identity"|"works";
export type EgoDouyinReadInput={epoch:string;operation:EgoDouyinOperation;expectedAccountUid?:string;count?:number};
export type EgoDouyinReadFailure={stage:"IDENTITY"|"IDENTITY_BEFORE"|"WORKS"|"IDENTITY_AFTER";reason:"HTTP_ERROR"|"RESPONSE_TOO_LARGE"|"EMPTY_RESPONSE"|"INVALID_JSON"|"TIMEOUT"|"NETWORK_ERROR"|"READ_FAILED"|"NATIVE_REQUEST_NOT_OBSERVED";httpStatus?:number;networkCode?:"net::ERR_EMPTY_RESPONSE"|"net::ERR_ABORTED"|"net::ERR_BLOCKED_BY_CLIENT"|"net::ERR_BLOCKED_BY_ORB"|"net::ERR_FAILED"|"OTHER"};
export type EgoDouyinSnapshot={epoch:string;status:string;message:string;checkedAt?:string;source:"LIVE_DOUYIN"|"LOCAL_FIXTURE_ONLY";identity?:DouyinOpsIdentity;failure?:EgoDouyinReadFailure;works:DouyinOpsWork[];worksCheckedAt?:string;worksReadMethod?:"PAGE_RESPONSE";coverage:"NOT_READ"|"FIRST_PAGE_ONLY"};
export interface EgoLiteDouyinReadPort extends DouyinOpsRuntime {
  peek():EgoDouyinSnapshot;
  perform(context:AgentCapabilityContext,input:EgoDouyinReadInput):Promise<EgoDouyinSnapshot>;
}
