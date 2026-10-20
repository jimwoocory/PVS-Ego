import type {DouyinOpsRuntime} from "../ports/douyin-ops-runtime.js";
import type {DouyinWorkBinding} from "../../domain/douyin-ops.js";
import {DomainValidationError} from "../../domain/validation.js";
export async function assertOperationsReadAccount(runtime:DouyinOpsRuntime,binding:DouyinWorkBinding){
 if(!binding.opsAccountUid)throw new DomainValidationError("原运营绑定未记录账号 UID；保留历史，需明确核对账号后才能继续，不能自动重绑");
 const actual=await runtime.identity();
 if(!actual.uid||actual.uid==="0"||actual.uid!==binding.opsAccountUid)throw new DomainValidationError("运营账号 UID 已改变或无法核验；停止，不切换账号续接");
 return actual.uid;
}
