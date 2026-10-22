import type {Prisma} from "@prisma/client";
import type {OperationsWriteFence} from "../../application/ports/operations-write-fence.js";
import {DomainValidationError} from "../../domain/validation.js";

/** Acquire SQLite's write lock before accepting the lease: pause/transfer and data write serialize. */
export async function assertOperationsWriteFence(tx:Prisma.TransactionClient,fence:OperationsWriteFence){
  const now=fence.now();
  if(!Number.isFinite(Date.parse(now))||fence.deadlineAt&&Date.parse(now)>=Date.parse(fence.deadlineAt))throw new DomainValidationError("运营观察窗口已结束，不能保存过期响应");
  const n=await tx.$executeRaw`UPDATE "DouyinOperationsScheduleRecord" SET "leaseOwner"="leaseOwner"
    WHERE "id"=${fence.scheduleId} AND "projectId"=${fence.projectId} AND "revision"=${fence.revision} AND "status"='RUNNING' AND "leaseOwner"=${fence.owner} AND "leaseExpiresAt">${new Date(now)}`;
  if(n!==1)throw new DomainValidationError("运营计划租约已变化，数据写入已停止");
}
