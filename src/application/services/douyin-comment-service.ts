import type {
  DouyinOpsRepository
} from "../ports/douyin-ops-repository.js";
import type {
  DouyinOpsComment,
  DouyinOpsRuntime
} from "../ports/douyin-ops-runtime.js";
import {
  douyinCommentSchema,
  type DouyinComment,
  type DouyinWorkBinding
} from "../../domain/douyin-ops.js";
import { sha256Text,hashValue } from "../../domain/hashing.js";
import { DomainValidationError } from "../../domain/validation.js";
import {assertOperationsReadAccount} from "./douyin-ops-read-scope.js";
import {commentPageCoverageSchema,type CommentPageCoverage} from "../../domain/douyin-observation.js";
import type {CommentObservation} from "../../domain/douyin-comment-observation.js";
import {observationsForDouyinPage} from "./douyin-read-evidence-audit.js";

export type DouyinCommentSyncResult = {
  projectId: string;
  awemeId: string;
  pages: number;
  syncedCount: number;
  cursor: string;
  hasMore: boolean;
  truncated: boolean;
  partial?:boolean;
  coverage?:CommentPageCoverage;
  observedAt?:string;
};

export class DouyinCommentCursorError extends DomainValidationError {
  constructor(readonly result: DouyinCommentSyncResult) {
    super("抖音评论分页游标没有推进，已停止继续同步");
  }
}

function boundedInt(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

export class DouyinCommentService {
  constructor(
    private readonly repo: DouyinOpsRepository,
    private readonly runtime: DouyinOpsRuntime
  ) {}

  private async resolveBinding(input: {
    projectId: string;
    packageId?: string;
    bindingId?: string;
    awemeId?: string;
  }): Promise<DouyinWorkBinding> {
    const binding = input.bindingId ? await this.repo.findWorkBindingById(input.bindingId) : input.packageId
      ? await this.repo.findWorkBindingByPackage(input.packageId)
      : await this.repo.latestWorkBinding(input.projectId, { preferBound: true });

    if (!binding || binding.projectId !== input.projectId) {
      throw new DomainValidationError(
        "当前项目尚未建立抖音作品绑定"
      );
    }
    if (binding.status !== "BOUND" || !binding.awemeId) {
      throw new DomainValidationError(
        "抖音作品绑定尚未确认，不能同步评论"
      );
    }
    await assertOperationsReadAccount(this.runtime,binding);
    if ((input.packageId && binding.packageId !== input.packageId) ||
        (input.awemeId && binding.awemeId !== input.awemeId)) {
      throw new DomainValidationError("采集作品或发布包与指定绑定不一致");
    }
    return binding;
  }
  async accountForBinding(binding:DouyinWorkBinding){return assertOperationsReadAccount(this.runtime,binding);}
  private async verifyBinding(binding:DouyinWorkBinding){
    const current=await this.repo.findWorkBindingById(binding.id);
    if(!current||current.status!=="BOUND"||current.projectId!==binding.projectId||current.awemeId!==binding.awemeId||current.opsAccountUid!==binding.opsAccountUid)throw new DomainValidationError("评论采集的原作品或账号绑定已改变");
    await assertOperationsReadAccount(this.runtime,binding);
  }

  private toRecord(input: {
    binding: DouyinWorkBinding;
    comment: DouyinOpsComment;
    syncedAt: string;
    parentCid?: string;
    sourceCoverage?:CommentPageCoverage;
    observation:CommentObservation;
  }): DouyinComment {
    const { binding, comment, syncedAt } = input;
    if (!binding.awemeId) {
      throw new DomainValidationError(
        "抖音作品绑定缺少 awemeId"
      );
    }
    if (
      comment.awemeId &&
      comment.awemeId !== binding.awemeId
    ) {
      throw new DomainValidationError(
        "评论所属作品与 PVS 绑定的抖音作品不一致"
      );
    }

    const parentCid =
      input.parentCid?.trim() ||
      comment.parentCid?.trim() ||
      undefined;
    if ((input.parentCid && comment.parentCid?.trim() && comment.parentCid.trim() !== input.parentCid) ||
        (!input.parentCid && comment.parentCid?.trim())) {
      throw new DomainValidationError("评论回复的父评论与本次采集范围不一致");
    }
    const normalized = {
      cid: comment.cid,
      awemeId: binding.awemeId,
      uid: comment.uid,
      secUid: comment.secUid,
      nickname: comment.nickname,
      text: comment.text,
      diggCount: input.observation.counts.diggCount.value,
      replyCount: input.observation.counts.replyCount.value,
      observation:input.observation,
      createdAt: comment.createdAt,
      parentCid: parentCid ?? "",
      avatarUrl: comment.avatarUrl,
      sourceCoverage:input.sourceCoverage
    };
    const rawJson = JSON.stringify(normalized);

    return douyinCommentSchema.parse({
      id: "douyin-comment:" +
        binding.awemeId +
        ":" +
        comment.cid,
      projectId: binding.projectId,
      bindingId: binding.id,
      awemeId: binding.awemeId,
      cid: comment.cid,
      ...(comment.uid ? { uid: comment.uid } : {}),
      ...(comment.secUid
        ? { secUid: comment.secUid }
        : {}),
      nickname: comment.nickname,
      text: comment.text,
      diggCount: input.observation.counts.diggCount.value,
      replyCount: input.observation.counts.replyCount.value,
      observation:input.observation,
      sourceCoverage:input.sourceCoverage,
      ...(comment.createdAt
        ? { platformCreatedAt: comment.createdAt }
        : {}),
      ...(parentCid ? { parentCid } : {}),
      ...(comment.avatarUrl
        ? { avatarUrl: comment.avatarUrl }
        : {}),
      syncedAt,
      rawJson,
      contentHash: sha256Text(rawJson),
      createdAt: syncedAt,
      updatedAt: syncedAt
    });
  }

  private async syncPages(input: {
    binding: DouyinWorkBinding;
    maxPages: number;
    pageSize: number;
    syncedAt: string;
    parentCid?: string;
    cursor?: string;
    beforePersist?:()=>Promise<void>;
  }): Promise<DouyinCommentSyncResult> {
    if (!input.binding.awemeId) {
      throw new DomainValidationError(
        "抖音作品绑定缺少 awemeId"
      );
    }

    if (input.cursor !== undefined && (typeof input.cursor !== "string" || input.cursor.length > 2000)) {
      throw new DomainValidationError("评论分页游标无效");
    }
    let cursor = input.cursor ?? "0";
    let pages = 0;
    let hasMore = true;
    const synced = new Set<string>();
    let coverage:CommentPageCoverage={status:"VISIBLE",truncated:false};

    while (pages < input.maxPages && hasMore) {
      const previousCursor = cursor;
      await this.verifyBinding(input.binding);
      const page = input.parentCid
        ? await this.runtime.getReplies({
            awemeId: input.binding.awemeId,
            cid: input.parentCid,
            cursor,
            count: input.pageSize
          })
        : await this.runtime.getComments({
            awemeId: input.binding.awemeId,
            cursor,
            count: input.pageSize
          });

      await this.verifyBinding(input.binding);
      if(typeof page.cursor!=="string"||page.cursor.length>2000||typeof page.hasMore!=="boolean"||!Array.isArray(page.comments)||page.comments.length>input.pageSize)throw new DomainValidationError("评论分页结构或数量超出本次有界范围");
      const evidence=observationsForDouyinPage(page,{awemeId:input.binding.awemeId,parentCid:input.parentCid,requestCursor:previousCursor,count:input.pageSize});
      const {readEvidence:pageSource,...normalizedPage}=page;
      const pageEvidence=pageSource?{...pageSource,version:"douyin-comment-page-v1" as const,projectId:input.binding.projectId,bindingId:input.binding.id,normalized:normalizedPage}:undefined;
      if(pageEvidence)for(const observation of evidence.observations.values())observation.pageEvidenceId="douyin-comment-page:"+hashValue(pageEvidence);
      const reported=commentPageCoverageSchema.parse(evidence.coverage);
      const rank={VISIBLE:0,UNKNOWN:1,PARTIAL:2,NOT_VISIBLE:3};coverage={...(rank[reported.status]>=rank[coverage.status]?reported:coverage),truncated:coverage.truncated||reported.truncated};
      const records = page.comments.map((comment) =>
        this.toRecord({
          binding: input.binding,
          comment,
          syncedAt: input.syncedAt,
          sourceCoverage:reported,
          observation:evidence.observations.get(comment.cid)!,
          ...(input.parentCid
            ? { parentCid: input.parentCid }
            : {})
        })
      );
      if (records.length) {
        for (const record of records) {
          const existing = await this.repo.findComment({ awemeId: record.awemeId, cid: record.cid });
          if (existing && (existing.projectId !== record.projectId || existing.bindingId !== record.bindingId)) {
            throw new DomainValidationError("评论已属于其他项目或作品绑定，不能静默转移采集数据");
          }
          if(existing&&(existing.parentCid??"")!==(record.parentCid??""))throw new DomainValidationError("同一评论的顶层/父评论关系不能被本次分页悄悄改写");
        }
        for (const record of records) {
          synced.add(record.cid);
        }
      }
      if(records.length||pageEvidence){await input.beforePersist?.();await this.repo.upsertComments(records,pageEvidence);}

      pages += 1;
      cursor = page.cursor || previousCursor;
      hasMore = page.hasMore;

      if (hasMore && cursor === previousCursor) {
        throw new DouyinCommentCursorError({ projectId: input.binding.projectId,
          awemeId: input.binding.awemeId, pages, syncedCount: synced.size,
          cursor, hasMore, truncated: true,partial:true,coverage,observedAt:input.syncedAt });
      }
    }

    return {
      projectId: input.binding.projectId,
      awemeId: input.binding.awemeId,
      pages,
      syncedCount: synced.size,
      cursor,
      hasMore,
      truncated: coverage.truncated||(hasMore && pages >= input.maxPages),
      partial:hasMore||coverage.status!=="VISIBLE"||coverage.truncated,
      coverage,observedAt:input.syncedAt
    };
  }

  async syncComments(input: {
    projectId: string;
    packageId?: string;
    maxPages?: number;
    pageSize?: number;
    syncedAt?: string;
    bindingId?: string;
    awemeId?: string;
    cursor?: string;
    beforePersist?:()=>Promise<void>;
  }): Promise<DouyinCommentSyncResult> {
    const binding = await this.resolveBinding(input);
    return this.syncPages({
      binding,
      maxPages: boundedInt(input.maxPages, 5, 1, 20),
      pageSize: boundedInt(input.pageSize, 20, 1, 20),
      cursor: input.cursor,
      beforePersist:input.beforePersist,
      syncedAt: input.syncedAt ?? new Date().toISOString()
    });
  }

  async syncReplies(input: {
    projectId: string;
    cid: string;
    packageId?: string;
    maxPages?: number;
    pageSize?: number;
    syncedAt?: string;
    bindingId?: string;
    awemeId?: string;
    cursor?: string;
    beforePersist?:()=>Promise<void>;
  }): Promise<DouyinCommentSyncResult> {
    const binding = await this.resolveBinding(input);
    if (!binding.awemeId) {
      throw new DomainValidationError(
        "抖音作品绑定缺少 awemeId"
      );
    }
    const parent = await this.repo.findComment({
      awemeId: binding.awemeId,
      cid: input.cid
    });
    if (!parent || parent.projectId !== input.projectId || parent.bindingId !== binding.id ||
        parent.awemeId !== binding.awemeId || parent.parentCid) {
      throw new DomainValidationError(
        "请先同步并选择一条已存在的抖音评论"
      );
    }

    return this.syncPages({
      binding,
      parentCid: input.cid,
      maxPages: boundedInt(input.maxPages, 5, 1, 20),
      pageSize: boundedInt(input.pageSize, 20, 1, 20),
      cursor: input.cursor,
      beforePersist:input.beforePersist,
      syncedAt: input.syncedAt ?? new Date().toISOString()
    });
  }

  listComments(input: {
    projectId: string;
    awemeId?: string;
    parentCid?: string | null;
    limit?: number;
    offset?: number;
    order?: "asc" | "desc";
  }): Promise<DouyinComment[]> {
    return this.repo.listComments(input);
  }
}
