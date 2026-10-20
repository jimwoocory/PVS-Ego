import type {
  IncomingMessage,
  ServerResponse
} from "node:http";
import { z } from "zod";
import {commentObservationDisplay} from "../domain/douyin-comment-observation.js";
import { randomUUID } from "node:crypto";
import type { DouyinCollectionService } from "../application/services/douyin-collection-service.js";
import type {
  DouyinOpsDashboardService
} from "../application/services/douyin-ops-dashboard-service.js";
import { DouyinOpsRuntimeError } from "../application/ports/douyin-ops-runtime.js";
import { DomainValidationError } from "../domain/validation.js";
import {
  renderDouyinOpsGlobalPage,
  renderDouyinOpsProjectPage
} from "./douyin-ops-ui.js";

function json(
  res: ServerResponse,
  status: number,
  value: unknown
) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, max-age=0"
  });
  res.end(JSON.stringify(value));
}

function html(
  res: ServerResponse,
  status: number,
  value: string
) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store, max-age=0"
  });
  res.end(value);
}

async function body(
  req: IncomingMessage,
  maxBytes = 32_000
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const value = Buffer.from(chunk);
    size += value.byteLength;
    if (size > maxBytes) {
      throw new DomainValidationError("请求内容过大");
    }
    chunks.push(value);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(
      Buffer.concat(chunks).toString("utf8")
    );
  } catch {
    throw new DomainValidationError(
      "请求必须是有效 JSON"
    );
  }
}

function publicError(error: unknown): {
  status: number;
  code: string;
  message: string;
} {
  if (error instanceof z.ZodError) {
    return {
      status: 400,
      code: "INVALID_INPUT",
      message: "请求参数无效"
    };
  }
  if (error instanceof DomainValidationError) {
    return {
      status: 400,
      code: "INVALID_STATE",
      message: error.message
    };
  }
  if (error instanceof DouyinOpsRuntimeError) {
    if (error.code === "AUTH_REQUIRED") {
      return {
        status: 409,
        code: error.code,
        message: "抖音运营账号需要重新登录。"
      };
    }
    if (
      error.code === "BRIDGE_OFFLINE" ||
      error.code === "SITE_OFFLINE" ||
      error.code === "ENGINE_UNAVAILABLE"
    ) {
      return {
        status: 503,
        code: error.code,
        message: "抖音运营连接当前不可用。"
      };
    }
    return {
      status: 502,
      code: error.code,
      message: "读取抖音数据失败，请稍后重试。"
    };
  }
  return {
    status: 500,
    code: "DOUYIN_OPS_FAILED",
    message: "抖音运营操作失败，请重试。"
  };
}

export async function handleDouyinOpsHttp(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: {
    douyinOpsDashboard?: DouyinOpsDashboardService;
    douyinCollection?: DouyinCollectionService;
  }
): Promise<boolean> {
  const globalPage = url.pathname === "/douyin-ops";
  const globalApi =
    url.pathname === "/api/douyin/ops/status";
  const researchReadiness =
    url.pathname === "/api/douyin/ops/research-readiness";
  const launch =
    url.pathname === "/api/douyin/ops/launch";
  const projectPage = url.pathname.match(
    /^\/projects\/([^/]+)\/douyin$/
  );
  const projectApi = url.pathname.match(
    /^\/api\/projects\/([^/]+)\/douyin$/
  );
  const collectionApi = url.pathname.match(
    /^\/api\/projects\/([^/]+)\/douyin\/collections(?:\/([^/]+)(?:\/(advance))?)?$/
  );
  const metricRefresh = url.pathname.match(
    /^\/api\/projects\/([^/]+)\/douyin\/metrics\/refresh$/
  );
  const retrospectiveGenerate = url.pathname.match(
    /^\/api\/projects\/([^/]+)\/douyin\/retrospective\/generate$/
  );
  const creativeFeedbackPromote = url.pathname.match(
    /^\/api\/projects\/([^/]+)\/douyin\/creative-feedback\/promote$/
  );
  const creativeFeedbackDeactivate = url.pathname.match(
    /^\/api\/projects\/([^/]+)\/douyin\/creative-feedback\/([^/]+)\/deactivate$/
  );
  const commentSync = url.pathname.match(
    /^\/api\/projects\/([^/]+)\/douyin\/comments\/sync$/
  );
  const commentClassify = url.pathname.match(
    /^\/api\/projects\/([^/]+)\/douyin\/comments\/classify$/
  );
  const replySync = url.pathname.match(
    /^\/api\/projects\/([^/]+)\/douyin\/comments\/([^/]+)\/replies\/sync$/
  );
  const savedReplies = url.pathname.match(
    /^\/api\/projects\/([^/]+)\/douyin\/comments\/([^/]+)\/replies$/
  );
  const savedCommentEvidence=url.pathname.match(/^\/api\/projects\/([^/]+)\/douyin\/comments\/(\d{1,40})\/evidence$/);
  const replyDraftGenerate = url.pathname.match(
    /^\/api\/projects\/([^/]+)\/douyin\/comments\/([^/]+)\/reply-draft$/
  );
  const replyDraftSave = url.pathname.match(
    /^\/api\/projects\/([^/]+)\/douyin\/reply-drafts\/([^/]+)\/save$/
  );
  const replyDraftReject = url.pathname.match(
    /^\/api\/projects\/([^/]+)\/douyin\/reply-drafts\/([^/]+)\/reject$/
  );
  const replyDraftPublish = url.pathname.match(
    /^\/api\/projects\/([^/]+)\/douyin\/reply-drafts\/([^/]+)\/publish$/
  );
  const bindingConfirm = url.pathname.match(
    /^\/api\/projects\/([^/]+)\/douyin\/binding\/confirm$/
  );

  if (
    !globalPage &&
    !globalApi &&
    !researchReadiness &&
    !launch &&
    !projectPage &&
    !projectApi &&
    !collectionApi &&
    !metricRefresh &&
    !retrospectiveGenerate &&
    !creativeFeedbackPromote &&
    !creativeFeedbackDeactivate &&
    !commentSync &&
    !commentClassify &&
    !replySync &&
    !savedReplies &&
    !savedCommentEvidence &&
    !replyDraftGenerate &&
    !replyDraftSave &&
    !replyDraftReject &&
    !replyDraftPublish &&
    !bindingConfirm
  ) {
    return false;
  }

  const service = deps.douyinOpsDashboard;
  if (!service) {
    json(res, 503, {
      code: "DOUYIN_OPS_UNAVAILABLE",
      message: "抖音运营服务尚未配置"
    });
    return true;
  }

  try {
    if (globalPage) {
      if (req.method !== "GET") {
        json(res, 405, { message: "不支持此请求方法" });
        return true;
      }
      html(
        res,
        200,
        renderDouyinOpsGlobalPage(
          await service.global()
        )
      );
      return true;
    }

    if (globalApi) {
      if (req.method !== "GET") {
        json(res, 405, { message: "不支持此请求方法" });
        return true;
      }
      json(res, 200, await service.global());
      return true;
    }

    if (researchReadiness) {
      if (req.method !== "GET") {
        json(res, 405, { message: "研究连接状态只允许读取" });
        return true;
      }
      // Deliberately bypass the full operations dashboard. The optional
      // research gate must never wait for published works / project bindings.
      json(res, 200, await service.researchReadiness());
      return true;
    }

    if (launch) {
      if (req.method !== "POST") {
        json(res, 405, { message: "不支持此请求方法" });
        return true;
      }
      const result = await service.launch();
      json(res, result.ok ? 200 : 503, result);
      return true;
    }

    const projectMatch =
      projectPage ??
      projectApi ??
      collectionApi ??
      metricRefresh ??
      retrospectiveGenerate ??
      creativeFeedbackPromote ??
      creativeFeedbackDeactivate ??
      commentSync ??
      commentClassify ??
      replySync ??
      savedReplies ??
      savedCommentEvidence ??
      replyDraftGenerate ??
      replyDraftSave ??
      replyDraftReject ??
      replyDraftPublish ??
      bindingConfirm;
    const projectId = decodeURIComponent(
      projectMatch![1]!
    );

    if (projectPage) {
      if (req.method !== "GET") {
        json(res, 405, { message: "不支持此请求方法" });
        return true;
      }
      html(
        res,
        200,
        renderDouyinOpsProjectPage(
          await service.project(projectId),
          deps.douyinCollection ? await deps.douyinCollection.list(projectId) : []
        )
      );
      return true;
    }

    if (projectApi) {
      if (req.method !== "GET") {
        json(res, 405, { message: "不支持此请求方法" });
        return true;
      }
      json(res, 200, await service.project(projectId));
      return true;
    }

    if (collectionApi) {
      const collections = deps.douyinCollection;
      if (!collections) { json(res, 503, { message: "持久采集服务尚未配置" }); return true; }
      const runId = collectionApi[2] ? decodeURIComponent(collectionApi[2]) : undefined;
      if (req.method === "GET" && !collectionApi[3]) {
        if (!runId) json(res, 200, { runs: await collections.list(projectId) });
        else {
          const run = await collections.get(projectId, runId);
          json(res, run ? 200 : 404, run ? { run } : { message: "当前项目中找不到采集任务" });
        }
      } else if (req.method === "POST" && runId && collectionApi[3] === "advance") {
        json(res, 200, { run: await collections.advance({ projectId, runId }) });
      } else if (req.method === "POST" && !runId) {
        const input = z.object({ requestKey: z.string().min(1).max(200), bindingId: z.string().min(1).optional(),
          awemeId: z.string().regex(/^\d{8,30}$/).optional(), kind: z.enum(["COMMENTS", "REPLIES"]),
          parentCid: z.string().regex(/^\d{1,40}$/).optional(), pageSize: z.number().int().min(1).max(20).optional(),
          batchPages: z.number().int().min(1).max(5).optional() }).strict().parse(await body(req));
        json(res, 200, { run: await collections.start({ projectId, ...input }) });
      } else json(res, 405, { message: "不支持此采集请求方法" });
      return true;
    }

    if(savedCommentEvidence){
      if(req.method!=="GET"){json(res,405,{message:"不支持此请求方法"});return true;}
      json(res,200,await service.savedCommentEvidence(projectId,savedCommentEvidence[2]!));return true;
    }
    if (savedReplies) {
      if (req.method !== "GET") { json(res, 405, { message: "不支持此请求方法" }); return true; }
      const query = z.object({
        offset: z.coerce.number().int().min(0).max(100000).default(0),
        limit: z.coerce.number().int().min(1).max(100).default(50)
      }).parse(Object.fromEntries(url.searchParams));
      const page=await service.savedReplies(projectId, decodeURIComponent(savedReplies[2]!), query.offset, query.limit);
      json(res, 200, {...page,items:page.items.map(item=>({...item,display:commentObservationDisplay(item)}))});
      return true;
    }

    if (req.method !== "POST") {
      json(res, 405, { message: "不支持此请求方法" });
      return true;
    }

    if (metricRefresh) {
      json(res, 200, {
        snapshot:
          await service.refreshMetrics(projectId)
      });
      return true;
    }

    if (retrospectiveGenerate) {
      json(res, 200, {
        insight:
          await service.generateRetrospective(
            projectId
          )
      });
      return true;
    }

    if (creativeFeedbackPromote) {
      const input = z
        .object({
          insightId: z.string().min(1),
          actionIndex: z.number().int().nonnegative(),
          confirmed: z.literal(true)
        })
        .strict()
        .parse(await body(req));
      json(res, 200, {
        feedback:
          await service.promoteCreativeFeedback({
            projectId,
            insightId: input.insightId,
            actionIndex: input.actionIndex,
            confirmed: true
          })
      });
      return true;
    }

    if (creativeFeedbackDeactivate) {
      const feedbackId = decodeURIComponent(
        creativeFeedbackDeactivate[2]!
      );
      const input = z
        .object({
          confirmed: z.literal(true)
        })
        .strict()
        .parse(await body(req));
      json(res, 200, {
        feedback:
          await service.deactivateCreativeFeedback({
            projectId,
            feedbackId,
            confirmed: true
          })
      });
      return true;
    }

    if (commentSync) {
      if (deps.douyinCollection) {
        const input = z.object({ requestKey: z.string().min(1).max(200).optional(),
          bindingId: z.string().min(1).optional(), awemeId: z.string().regex(/^\d{8,30}$/).optional() }).strict().parse(await body(req));
        const run = await deps.douyinCollection.start({ projectId, ...input,
          requestKey: input.requestKey ?? randomUUID(), kind: "COMMENTS", batchPages: 1 });
        json(res, 200, { result: run, collection: run });
        return true;
      }
      json(res, 200, {
        result: await service.syncComments(projectId)
      });
      return true;
    }

    if (commentClassify) {
      const input = z
        .object({
          cids: z
            .array(
              z.string().regex(/^\d{1,40}$/)
            )
            .min(1)
            .max(20)
            .optional(),
          force: z.boolean().optional()
        })
        .strict()
        .parse(await body(req));
      json(res, 200, {
        result: await service.classifyComments({
          projectId,
          ...(input.cids ? { cids: input.cids } : {}),
          ...(input.force !== undefined
            ? { force: input.force }
            : {})
        })
      });
      return true;
    }

    if (replySync) {
      const cid = decodeURIComponent(replySync[2]!);
      if (!/^\d{1,40}$/.test(cid)) {
        throw new DomainValidationError(
          "评论 ID 格式无效"
        );
      }
      if (deps.douyinCollection) {
        const input = z.object({ requestKey: z.string().min(1).max(200).optional(),
          bindingId: z.string().min(1).optional(), awemeId: z.string().regex(/^\d{8,30}$/).optional() }).strict().parse(await body(req));
        const run = await deps.douyinCollection.start({ projectId, ...input,
          requestKey: input.requestKey ?? randomUUID(), kind: "REPLIES", parentCid: cid, batchPages: 1 });
        json(res, 200, { result: run, collection: run });
        return true;
      }
      json(res, 200, {
        result:
          await service.syncReplies(projectId, cid)
      });
      return true;
    }

    if (replyDraftGenerate) {
      const cid = decodeURIComponent(
        replyDraftGenerate[2]!
      );
      if (!/^\d{1,40}$/.test(cid)) {
        throw new DomainValidationError(
          "评论 ID 格式无效"
        );
      }
      z.object({}).strict().parse(await body(req));
      json(res, 200, {
        draft:
          await service.generateReplyDraft({
            projectId,
            cid
          })
      });
      return true;
    }

    if (replyDraftSave) {
      const draftId = decodeURIComponent(
        replyDraftSave[2]!
      );
      const input = z
        .object({
          expectedRevision: z.number().int().positive(),
          currentText: z.string().trim().min(1).max(280)
        })
        .strict()
        .parse(await body(req));
      json(res, 200, {
        draft:
          await service.editReplyDraft({
            projectId,
            draftId,
            expectedRevision: input.expectedRevision,
            currentText: input.currentText
          })
      });
      return true;
    }

    if (replyDraftReject) {
      const draftId = decodeURIComponent(
        replyDraftReject[2]!
      );
      const input = z
        .object({
          expectedRevision: z.number().int().positive()
        })
        .strict()
        .parse(await body(req));
      json(res, 200, {
        draft:
          await service.rejectReplyDraft({
            projectId,
            draftId,
            expectedRevision: input.expectedRevision
          })
      });
      return true;
    }

    if (replyDraftPublish) {
      const draftId = decodeURIComponent(
        replyDraftPublish[2]!
      );
      const input = z
        .object({
          expectedRevision: z.number().int().positive(),
          writeIntentId: z.string().uuid(),
          confirmed: z.literal(true)
        })
        .strict()
        .parse(await body(req));
      json(res, 200, {
        result:
          await service.publishReplyDraft({
            projectId,
            draftId,
            expectedRevision: input.expectedRevision,
            writeIntentId: input.writeIntentId,
            confirmed: true
          })
      });
      return true;
    }

    if (bindingConfirm) {
      const input = z
        .object({
          awemeId: z
            .string()
            .regex(/^\d{8,30}$/),
          externalUrl: z.string().url().optional(),
          confirmed: z.literal(true)
        })
        .strict()
        .parse(await body(req));

      json(res, 200, {
        binding: await service.confirmBinding({
          projectId,
          awemeId: input.awemeId,
          ...(input.externalUrl
            ? { externalUrl: input.externalUrl }
            : {}),
          confirmed: true
        })
      });
      return true;
    }

    json(res, 404, { message: "不存在的抖音运营操作" });
    return true;
  } catch (error) {
    const mapped = publicError(error);
    json(res, mapped.status, {
      code: mapped.code,
      message: mapped.message
    });
    return true;
  }
}
