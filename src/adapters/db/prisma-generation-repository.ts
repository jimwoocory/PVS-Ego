import type { PrismaClient } from "@prisma/client";
import type { GenerationRepository, PreparedPreflightChain } from "../../application/ports/generation-repository.js";
import { DomainValidationError } from "../../domain/validation.js";
import {
  compiledPromptSchema,
  generationRequestSchema,
  preflightReportSchema,
  userApprovalSchema,
  type CompiledPrompt,
  type GenerationRequest,
  type PreflightReport,
  type UserApproval
} from "../../domain/schemas.js";

export class PrismaGenerationRepository implements GenerationRepository {
  constructor(private readonly db: PrismaClient) {}

  async replacePreflightChain(chain: PreparedPreflightChain): Promise<void> {
    const clips = [...new Set(chain.clipIds)];
    if (
      clips.length === 0 ||
      chain.compiledPrompts.length !== chain.requests.length ||
      chain.reports.length !== chain.requests.length ||
      chain.requests.length !== clips.length
    ) {
      throw new DomainValidationError("生成前检查的镜头和结果数量不一致，原授权未改变");
    }
    const requests = chain.requests.map(value => generationRequestSchema.parse(value));
    const reports = chain.reports.map(value => preflightReportSchema.parse(value));
    const prompts = chain.compiledPrompts.map(value => compiledPromptSchema.parse(value));
    if (
      requests.some(request => request.projectId !== chain.projectId || !clips.includes(request.clipId)) ||
      new Set(requests.map(request => request.clipId)).size !== clips.length ||
      reports.some(report => report.projectId !== chain.projectId || report.status !== "PASS" ||
        !requests.some(request => request.id === report.generationRequestId && request.requestHash === report.requestHash)) ||
      prompts.some(prompt => prompt.projectId !== chain.projectId ||
        !requests.some(request => request.compiledPromptId === prompt.id && request.clipId === prompt.clipId))
    ) {
      throw new DomainValidationError("生成前检查版本绑定不完整，不能替换旧授权");
    }
    const when = new Date(chain.staleAt);
    if (!Number.isFinite(when.getTime())) {
      throw new DomainValidationError("生成前检查更新时间无效");
    }
    await this.db.$transaction(async tx => {
      const old = await tx.generationRequestRecord.findMany({
        where: { projectId: chain.projectId, clipId: { in: clips }, status: "CURRENT" },
        select: { id: true }
      });
      const oldIds = old.map(item => item.id);
      if (oldIds.length) {
        await tx.userApprovalRecord.updateMany({
          where: { projectId: chain.projectId, generationRequestId: { in: oldIds }, status: "ACTIVE" },
          data: { status: "STALE" }
        });
        await tx.preflightReportRecord.updateMany({
          where: { projectId: chain.projectId, generationRequestId: { in: oldIds }, status: { not: "STALE" } },
          data: { status: "STALE", staleAt: when }
        });
        await tx.generationRequestRecord.updateMany({
          where: { projectId: chain.projectId, id: { in: oldIds }, status: "CURRENT" },
          data: { status: "STALE" }
        });
      }
      for (const prompt of prompts) {
        const entityKey = `compiled-prompt:${prompt.clipId}`;
        await tx.versionedEntity.updateMany({
          where: { projectId: chain.projectId, entityType: "CompiledPrompt", entityKey, status: { not: "STALE" } },
          data: { status: "STALE" }
        });
        await tx.versionedEntity.create({
          data: { id: prompt.id, projectId: chain.projectId, entityType: "CompiledPrompt",
            entityKey, version: prompt.version, status: prompt.status,
            contentHash: prompt.compiledPromptHash, dataJson: JSON.stringify(prompt) }
        });
      }
      for (const request of requests) {
        await tx.generationRequestRecord.create({
          data: { id: request.id, projectId: request.projectId, clipId: request.clipId,
            compiledPromptId: request.compiledPromptId, requestHash: request.requestHash,
            providerIdentityHash: request.providerIdentityHash, capabilityFingerprint: request.capabilityFingerprint,
            status: "CURRENT", dataJson: JSON.stringify(request), createdAt: new Date(request.createdAt) }
        });
      }
      for (const report of reports) {
        await tx.preflightReportRecord.create({
          data: { id: report.id, projectId: report.projectId,
            generationRequestId: report.generationRequestId, requestHash: report.requestHash,
            status: report.status, providerIdentityHash: report.providerIdentityHash,
            capabilityFingerprint: report.capabilityFingerprint, reportHash: report.reportHash,
            dataJson: JSON.stringify(report), createdAt: new Date(report.createdAt), staleAt: null }
        });
      }
    });
  }

  async markSubmissionChainStale(projectId: string, staleAt: string): Promise<void> {
    const when = new Date(staleAt);
    await this.db.$transaction([
      this.db.generationRequestRecord.updateMany({
        where: { projectId, status: "CURRENT" },
        data: { status: "STALE" }
      }),
      this.db.preflightReportRecord.updateMany({
        where: { projectId, status: { not: "STALE" } },
        data: { status: "STALE", staleAt: when }
      }),
      this.db.userApprovalRecord.updateMany({
        where: { projectId, status: "ACTIVE" },
        data: { status: "STALE" }
      })
    ]);
  }

  async markRequestChainStale(
    generationRequestId: string,
    staleAt: string
  ): Promise<void> {
    const when = new Date(staleAt);
    await this.db.$transaction([
      this.db.generationRequestRecord.updateMany({
        where: { id: generationRequestId, status: "CURRENT" },
        data: { status: "STALE" }
      }),
      this.db.preflightReportRecord.updateMany({
        where: {
          generationRequestId,
          status: { not: "STALE" }
        },
        data: { status: "STALE", staleAt: when }
      }),
      this.db.userApprovalRecord.updateMany({
        where: { generationRequestId, status: "ACTIVE" },
        data: { status: "STALE" }
      })
    ]);
  }

  async saveCompiledPrompt(input: CompiledPrompt): Promise<CompiledPrompt> {
    const prompt = compiledPromptSchema.parse(input);
    await this.db.$transaction(async (tx) => {
      await tx.versionedEntity.updateMany({
        where: {
          projectId: prompt.projectId,
          entityType: "CompiledPrompt",
          entityKey: `compiled-prompt:${prompt.clipId}`,
          status: { not: "STALE" }
        },
        data: { status: "STALE" }
      });
      await tx.versionedEntity.create({
        data: {
          id: prompt.id,
          projectId: prompt.projectId,
          entityType: "CompiledPrompt",
          entityKey: `compiled-prompt:${prompt.clipId}`,
          version: prompt.version,
          status: prompt.status,
          contentHash: prompt.compiledPromptHash,
          dataJson: JSON.stringify(prompt)
        }
      });
    });
    return prompt;
  }

  async listCompiledPrompts(projectId: string): Promise<CompiledPrompt[]> {
    const rows = await this.db.versionedEntity.findMany({
      where: { projectId, entityType: "CompiledPrompt" },
      orderBy: [{ entityKey: "asc" }, { version: "asc" }]
    });
    return rows.map((row) =>
      compiledPromptSchema.parse({
        ...JSON.parse(row.dataJson),
        status: row.status
      })
    );
  }

  async createGenerationRequest(input: GenerationRequest): Promise<GenerationRequest> {
    const request = generationRequestSchema.parse(input);
    await this.db.generationRequestRecord.create({
      data: {
        id: request.id,
        projectId: request.projectId,
        clipId: request.clipId,
        compiledPromptId: request.compiledPromptId,
        requestHash: request.requestHash,
        providerIdentityHash: request.providerIdentityHash,
        capabilityFingerprint: request.capabilityFingerprint,
        status: "CURRENT",
        dataJson: JSON.stringify(request),
        createdAt: new Date(request.createdAt)
      }
    });
    return request;
  }

  async getGenerationRequest(id: string): Promise<GenerationRequest | null> {
    const row = await this.db.generationRequestRecord.findUnique({ where: { id } });
    return row ? generationRequestSchema.parse(JSON.parse(row.dataJson)) : null;
  }

  async listGenerationRequests(projectId: string): Promise<GenerationRequest[]> {
    const rows = await this.db.generationRequestRecord.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" }
    });
    return rows.map((row) => generationRequestSchema.parse(JSON.parse(row.dataJson)));
  }

  async listCurrentGenerationRequests(projectId: string): Promise<GenerationRequest[]> {
    const rows = await this.db.generationRequestRecord.findMany({
      where: { projectId, status: "CURRENT" },
      orderBy: { createdAt: "asc" }
    });
    return rows.map((row) => generationRequestSchema.parse(JSON.parse(row.dataJson)));
  }

  async createPreflightReport(input: PreflightReport): Promise<PreflightReport> {
    const report = preflightReportSchema.parse(input);
    await this.db.preflightReportRecord.create({
      data: {
        id: report.id,
        projectId: report.projectId,
        generationRequestId: report.generationRequestId,
        requestHash: report.requestHash,
        status: report.status,
        providerIdentityHash: report.providerIdentityHash,
        capabilityFingerprint: report.capabilityFingerprint,
        reportHash: report.reportHash,
        dataJson: JSON.stringify(report),
        createdAt: new Date(report.createdAt),
        staleAt: report.staleAt ? new Date(report.staleAt) : null
      }
    });
    return report;
  }

  async getPreflightReport(id: string): Promise<PreflightReport | null> {
    const row = await this.db.preflightReportRecord.findUnique({ where: { id } });
    if (!row) return null;
    return preflightReportSchema.parse({
      ...JSON.parse(row.dataJson),
      status: row.status,
      ...(row.staleAt ? { staleAt: row.staleAt.toISOString() } : {})
    });
  }

  async listPreflightReports(projectId: string): Promise<PreflightReport[]> {
    const rows = await this.db.preflightReportRecord.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" }
    });
    return rows.map((row) =>
      preflightReportSchema.parse({
        ...JSON.parse(row.dataJson),
        status: row.status,
        ...(row.staleAt ? { staleAt: row.staleAt.toISOString() } : {})
      })
    );
  }

  async createUserApproval(input: UserApproval): Promise<UserApproval> {
    const approval = userApprovalSchema.parse(input);
    await this.db.userApprovalRecord.create({
      data: {
        id: approval.id,
        projectId: approval.projectId,
        generationRequestId: approval.generationRequestId,
        preflightReportId: approval.preflightReportId,
        requestHash: approval.requestHash,
        preflightHash: approval.preflightHash,
        providerIdentityHash: approval.providerIdentityHash,
        capabilityFingerprint: approval.capabilityFingerprint,
        status: approval.status,
        approvalHash: approval.approvalHash,
        approvedAt: new Date(approval.approvedAt),
        expiresAt: approval.expiresAt ? new Date(approval.expiresAt) : null,
        dataJson: JSON.stringify(approval)
      }
    });
    return approval;
  }

  async getUserApproval(id: string): Promise<UserApproval | null> {
    const row = await this.db.userApprovalRecord.findUnique({ where: { id } });
    if (!row) return null;
    return userApprovalSchema.parse({
      ...JSON.parse(row.dataJson),
      status: row.status
    });
  }

  async listUserApprovals(projectId: string): Promise<UserApproval[]> {
    const rows = await this.db.userApprovalRecord.findMany({
      where: { projectId },
      orderBy: { approvedAt: "asc" }
    });
    return rows.map((row) =>
      userApprovalSchema.parse({
        ...JSON.parse(row.dataJson),
        status: row.status
      })
    );
  }
}
