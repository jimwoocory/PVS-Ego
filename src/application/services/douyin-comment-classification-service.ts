import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DouyinOpsRepository } from "../ports/douyin-ops-repository.js";
import {
  generateStructuredJson,
  type StructuredAiRuntime
} from "../ports/structured-ai-runtime.js";
import {
  douyinCommentCategorySchema,
  douyinCommentClassificationSchema,
  douyinCommentPrioritySchema,
  douyinCommentSentimentSchema,
  type DouyinComment,
  type DouyinCommentClassification
} from "../../domain/douyin-ops.js";
import { DomainValidationError } from "../../domain/validation.js";

const classificationItemSchema = z.object({
  cid: z.string().trim().regex(/^\d{1,40}$/),
  sentiment: douyinCommentSentimentSchema,
  category: douyinCommentCategorySchema,
  priority: douyinCommentPrioritySchema,
  rationale: z.string().trim().max(240).optional()
});

const classificationBatchSchema = z.object({
  items: z.array(classificationItemSchema).min(1).max(20)
});

export type DouyinCommentClassificationResult = {
  projectId: string;
  requestedCount: number;
  classifiedCount: number;
  skippedCount: number;
  commentIds: string[];
  execution?: {
    runtimeId: string;
    runtimeVersion: string;
    providerId?: string;
    modelId?: string;
    executionId?: string;
    configVersion?: number;
  };
};

function boundedLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 20;
  return Math.max(1, Math.min(20, Math.trunc(value)));
}

function uniqueCids(values: string[] | undefined): string[] {
  if (!values) return [];
  return [
    ...new Set(
      values
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ].slice(0, 20);
}

function hasCurrentClassification(
  comment: DouyinComment,
  latest: DouyinCommentClassification | null
): boolean {
  return Boolean(
    comment.sentiment &&
      comment.category &&
      comment.priority &&
      latest &&
      latest.sourceContentHash === comment.contentHash
  );
}

export class DouyinCommentClassificationService {
  constructor(
    private readonly repo: DouyinOpsRepository,
    private readonly runtime: StructuredAiRuntime
  ) {}

  private async resolveComments(input: {
    projectId: string;
    awemeId?: string;
    cids?: string[];
    limit?: number;
  }): Promise<DouyinComment[]> {
    const cids = uniqueCids(input.cids);
    if (input.cids && !cids.length) {
      throw new DomainValidationError(
        "至少选择一条需要分类的抖音评论"
      );
    }

    if (cids.length) {
      const comments =
        await this.repo.findCommentsByCids(
          input.projectId,
          cids
        );
      if (
        input.awemeId &&
        comments.some(
          (comment) =>
            comment.awemeId !== input.awemeId
        )
      ) {
        throw new DomainValidationError(
          "所选评论不属于当前绑定的抖音作品"
        );
      }
      if (comments.length > cids.length) {
        throw new DomainValidationError(
          "评论 ID 在当前项目内存在歧义，已停止分类"
        );
      }
      const found = new Set(comments.map((item) => item.cid));
      const missing = cids.filter((cid) => !found.has(cid));
      if (missing.length) {
        throw new DomainValidationError(
          "部分评论不存在或不属于当前项目：" +
            missing.join("、")
        );
      }
      const byCid = new Map(
        comments.map((item) => [item.cid, item])
      );
      return cids
        .map((cid) => byCid.get(cid))
        .filter(
          (item): item is DouyinComment =>
            item !== undefined
        );
    }

    return this.repo.listComments({
      projectId: input.projectId,
      ...(input.awemeId
        ? { awemeId: input.awemeId }
        : {}),
      limit: 500,
      order: "desc"
    });
  }

  async classify(input: {
    projectId: string;
    awemeId?: string;
    cids?: string[];
    limit?: number;
    force?: boolean;
    classifiedAt?: string;
  }): Promise<DouyinCommentClassificationResult> {
    const comments = await this.resolveComments(input);
    if (!comments.length) {
      return {
        projectId: input.projectId,
        requestedCount: 0,
        classifiedCount: 0,
        skippedCount: 0,
        commentIds: []
      };
    }

    const candidates: DouyinComment[] = [];
    let skippedCount = 0;
    const batchLimit = boundedLimit(input.limit);

    for (const comment of comments) {
      const latest =
        await this.repo.latestCommentClassification(
          comment.id
        );
      if (
        input.force !== true &&
        hasCurrentClassification(comment, latest)
      ) {
        skippedCount += 1;
        continue;
      }
      candidates.push(comment);
      if (candidates.length >= batchLimit) break;
    }

    if (!candidates.length) {
      return {
        projectId: input.projectId,
        requestedCount: comments.length,
        classifiedCount: 0,
        skippedCount,
        commentIds: []
      };
    }

    const classifiedAt =
      input.classifiedAt ?? new Date().toISOString();

    const result = await generateStructuredJson(
      this.runtime,
      {
        task: "DOUYIN_COMMENT_CLASSIFICATION",
        instructions: [
          "你负责对已经同步到 Product Video Studio 的抖音评论做运营分类。",
          "只分析输入中提供的评论，不补充、不猜测、不创建新的 cid。",
          "必须对每个输入 cid 恰好返回一条结果，不能遗漏、不能重复。",
          "sentiment 只能是 POSITIVE、NEUTRAL、NEGATIVE、MIXED。",
          "category 只能是 PRODUCT_QUESTION、PURCHASE_INTENT、USAGE_FEEDBACK、PRAISE、COMPLAINT、GENERAL_INTERACTION、SPAM_OR_IRRELEVANT。",
          "priority 只能是 HIGH、MEDIUM、LOW。",
          "HIGH 用于明确产品问题、购买意向、需要处理的投诉或高价值反馈；普通互动通常为 LOW；不确定时使用 MEDIUM。",
          "rationale 用简短中文说明判断依据，不超过 240 字。",
          "分类只是内部运营标签，不代表要自动回复。"
        ].join("\n"),
        input: {
          comments: candidates.map((comment) => ({
            cid: comment.cid,
            text: comment.text,
            diggCount:comment.diggCount,
            replyCount:comment.replyCount,
            sourceCoverage:comment.sourceCoverage,observation:comment.observation,
            ...(comment.parentCid
              ? { parentCid: comment.parentCid }
              : {})
          }))
        },
        outputContract: {
          items: [
            {
              cid: "输入中的原始 cid",
              sentiment:
                "POSITIVE|NEUTRAL|NEGATIVE|MIXED",
              category:
                "PRODUCT_QUESTION|PURCHASE_INTENT|USAGE_FEEDBACK|PRAISE|COMPLAINT|GENERAL_INTERACTION|SPAM_OR_IRRELEVANT",
              priority: "HIGH|MEDIUM|LOW",
              rationale: "简短中文依据"
            }
          ]
        },
        context: {
          projectId: input.projectId,
          step: "DOUYIN_OPS"
        }
      }
    );

    const parsedResult =
      classificationBatchSchema.safeParse(
        result.data
      );
    if (!parsedResult.success) {
      throw new Error(
        "AI 评论分类结果格式无效"
      );
    }
    const parsed = parsedResult.data;

    const expected = new Set(
      candidates.map((item) => item.cid)
    );
    const actual = new Set<string>();
    for (const item of parsed.items) {
      if (actual.has(item.cid)) {
        throw new DomainValidationError(
          "AI 评论分类结果包含重复 cid：" +
            item.cid
        );
      }
      actual.add(item.cid);
      if (!expected.has(item.cid)) {
        throw new DomainValidationError(
          "AI 评论分类结果引用了不存在的 cid：" +
            item.cid
        );
      }
    }

    const missing = [...expected].filter(
      (cid) => !actual.has(cid)
    );
    if (missing.length) {
      throw new DomainValidationError(
        "AI 评论分类结果遗漏 cid：" +
          missing.join("、")
      );
    }
    if (parsed.items.length !== candidates.length) {
      throw new DomainValidationError(
        "AI 评论分类结果数量与输入评论不一致"
      );
    }

    const commentByCid = new Map(
      candidates.map((item) => [item.cid, item])
    );
    const metadata = result.metadata;
    const records = parsed.items.map((item) => {
      const comment = commentByCid.get(item.cid);
      if (!comment) {
        throw new DomainValidationError(
          "AI 评论分类结果无法映射到原评论"
        );
      }
      return douyinCommentClassificationSchema.parse({
        id: randomUUID(),
        projectId: input.projectId,
        commentId: comment.id,
        awemeId: comment.awemeId,
        cid: comment.cid,
        sourceContentHash: comment.contentHash,
        sentiment: item.sentiment,
        category: item.category,
        priority: item.priority,
        ...(item.rationale
          ? { rationale: item.rationale }
          : {}),
        runtimeId: this.runtime.id,
        runtimeVersion: this.runtime.version,
        ...(metadata?.providerId
          ? { providerId: metadata.providerId }
          : {}),
        ...(metadata?.modelId
          ? { modelId: metadata.modelId }
          : {}),
        ...(metadata?.executionId
          ? { executionId: metadata.executionId }
          : {}),
        ...(metadata?.configVersion
          ? { configVersion: metadata.configVersion }
          : {}),
        classifiedAt,
        createdAt: classifiedAt
      });
    });

    await this.repo.saveCommentClassifications({
      updates: records.map((record) => ({
        commentId: record.commentId,
        sentiment: record.sentiment,
        category: record.category,
        priority: record.priority
      })),
      records
    });

    return {
      projectId: input.projectId,
      requestedCount: comments.length,
      classifiedCount: records.length,
      skippedCount,
      commentIds: records.map(
        (item) => item.commentId
      ),
      execution: {
        runtimeId: this.runtime.id,
        runtimeVersion: this.runtime.version,
        ...(metadata?.providerId
          ? { providerId: metadata.providerId }
          : {}),
        ...(metadata?.modelId
          ? { modelId: metadata.modelId }
          : {}),
        ...(metadata?.executionId
          ? { executionId: metadata.executionId }
          : {}),
        ...(metadata?.configVersion
          ? { configVersion: metadata.configVersion }
          : {})
      }
    };
  }

  history(
    commentId: string
  ): Promise<DouyinCommentClassification[]> {
    return this.repo.listCommentClassifications(
      commentId
    );
  }
}
