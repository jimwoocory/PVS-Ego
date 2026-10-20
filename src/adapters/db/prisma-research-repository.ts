import type { PrismaClient } from "@prisma/client";
import type {
  ResearchBrief,
  ResearchCandidateClaim,
  ResearchEvidence,
  ResearchRepository,
  ResearchRun,
  ResearchUsageRule
} from "../../application/ports/research-repository.js";

function iso(value: Date): string {
  return value.toISOString();
}

function mapRun(row: {
  id: string;
  projectId: string;
  mode: string;
  status: string;
  goal: string;
  sourceUrlsJson: string;
  queriesJson: string;
  browserStateJson: string | null;
  blockerCode: string | null;
  blockerMessage: string | null;
  requiredUserAction: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ResearchRun {
  return {
    id: row.id,
    projectId: row.projectId,
    mode: row.mode as ResearchRun["mode"],
    status: row.status as ResearchRun["status"],
    goal: row.goal,
    sourceUrls: JSON.parse(row.sourceUrlsJson) as ResearchRun["sourceUrls"],
    queries: JSON.parse(row.queriesJson) as string[],
    ...(row.browserStateJson
      ? {
          browserState: JSON.parse(
            row.browserStateJson
          ) as NonNullable<ResearchRun["browserState"]>
        }
      : {}),
    ...(row.blockerCode ? { blockerCode: row.blockerCode } : {}),
    ...(row.blockerMessage ? { blockerMessage: row.blockerMessage } : {}),
    ...(row.requiredUserAction
      ? { requiredUserAction: row.requiredUserAction }
      : {}),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt)
  };
}

function mapEvidence(row: {
  id: string;
  projectId: string;
  runId: string;
  sourceUrl: string;
  title: string;
  fetchedAt: Date;
  sourceType: string;
  excerpt: string;
  summary: string;
  contentHash: string;
  confidence: string;
  mediaContextJson: string | null;
  relatedClaimsJson: string;
  status: string;
  createdAt: Date;
}): ResearchEvidence {
  // Preserve legacy media JSON while extending the same evidence context with rendered-page provenance.
  const context=row.mediaContextJson?JSON.parse(row.mediaContextJson):{};
  const {sourceCapture,...mediaContext}=context;
  return {
    id: row.id,
    projectId: row.projectId,
    runId: row.runId,
    sourceUrl: row.sourceUrl,
    title: row.title,
    fetchedAt: iso(row.fetchedAt),
    sourceType: row.sourceType as ResearchEvidence["sourceType"],
    excerpt: row.excerpt,
    summary: row.summary,
    contentHash: row.contentHash,
    confidence: row.confidence as ResearchEvidence["confidence"],
    ...(mediaContext.type?{mediaContext:mediaContext as NonNullable<ResearchEvidence["mediaContext"]>}:{}),
    ...(sourceCapture?{sourceCapture:sourceCapture as NonNullable<ResearchEvidence["sourceCapture"]>}:{}),
    relatedClaims: JSON.parse(row.relatedClaimsJson) as string[],
    status: row.status === "STALE" ? "STALE" : "ACTIVE",
    createdAt: iso(row.createdAt)
  };
}

function mapBrief(row: {
  id: string;
  projectId: string;
  runId: string;
  status: string;
  summary: string;
  findingsJson: string;
  claimsJson: string;
  usageRulesJson: string;
  opportunitiesJson: string;
  uncertaintiesJson: string;
  aiExecutionJson: string | null;
  contentHash: string;
  createdAt: Date;
}): ResearchBrief {
  return {
    id: row.id,
    projectId: row.projectId,
    runId: row.runId,
    status: row.status === "STALE" ? "STALE" : "READY",
    summary: row.summary,
    findings: JSON.parse(row.findingsJson) as ResearchBrief["findings"],
    candidateClaims: JSON.parse(
      row.claimsJson
    ) as ResearchBrief["candidateClaims"],
    usageRules: JSON.parse(
      row.usageRulesJson
    ) as ResearchBrief["usageRules"],
    contentOpportunities: JSON.parse(
      row.opportunitiesJson
    ) as string[],
    uncertainties: JSON.parse(row.uncertaintiesJson) as string[],
    ...(row.aiExecutionJson
      ? {
          aiExecution: JSON.parse(
            row.aiExecutionJson
          ) as NonNullable<ResearchBrief["aiExecution"]>
        }
      : {}),
    contentHash: row.contentHash,
    createdAt: iso(row.createdAt)
  };
}

export class PrismaResearchRepository implements ResearchRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createRun(run: ResearchRun): Promise<ResearchRun> {
    const row = await this.prisma.researchRunRecord.create({
      data: {
        id: run.id,
        projectId: run.projectId,
        mode: run.mode,
        status: run.status,
        goal: run.goal,
        sourceUrlsJson: JSON.stringify(run.sourceUrls),
        queriesJson: JSON.stringify(run.queries),
        browserStateJson: run.browserState
          ? JSON.stringify(run.browserState)
          : null,
        blockerCode: run.blockerCode ?? null,
        blockerMessage: run.blockerMessage ?? null,
        requiredUserAction: run.requiredUserAction ?? null,
        createdAt: new Date(run.createdAt),
        updatedAt: new Date(run.updatedAt)
      }
    });
    return mapRun(row);
  }

  async updateRun(
    id: string,
    update: Partial<
      Pick<
        ResearchRun,
        | "status"
        | "browserState"
        | "blockerCode"
        | "blockerMessage"
        | "requiredUserAction"
      >
    >
  ): Promise<ResearchRun> {
    const hasBrowserState = Object.prototype.hasOwnProperty.call(
      update,
      "browserState"
    );
    const hasBlockerCode = Object.prototype.hasOwnProperty.call(
      update,
      "blockerCode"
    );
    const hasBlockerMessage = Object.prototype.hasOwnProperty.call(
      update,
      "blockerMessage"
    );
    const hasRequiredUserAction =
      Object.prototype.hasOwnProperty.call(
        update,
        "requiredUserAction"
      );
    const row = await this.prisma.researchRunRecord.update({
      where: { id },
      data: {
        ...(update.status !== undefined
          ? { status: update.status }
          : {}),
        ...(hasBrowserState
          ? {
              browserStateJson: update.browserState
                ? JSON.stringify(update.browserState)
                : null
            }
          : {}),
        ...(hasBlockerCode
          ? { blockerCode: update.blockerCode ?? null }
          : {}),
        ...(hasBlockerMessage
          ? { blockerMessage: update.blockerMessage ?? null }
          : {}),
        ...(hasRequiredUserAction
          ? {
              requiredUserAction:
                update.requiredUserAction ?? null
            }
          : {})
      }
    });
    return mapRun(row);
  }

  async findRun(id: string): Promise<ResearchRun | null> {
    const row = await this.prisma.researchRunRecord.findUnique({
      where: { id }
    });
    return row ? mapRun(row) : null;
  }

  async listRuns(projectId: string): Promise<ResearchRun[]> {
    const rows = await this.prisma.researchRunRecord.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" }
    });
    return rows.map(mapRun);
  }

  async createEvidence(
    evidence: ResearchEvidence
  ): Promise<ResearchEvidence> {
    const row = await this.prisma.researchEvidenceRecord.create({
      data: {
        id: evidence.id,
        projectId: evidence.projectId,
        runId: evidence.runId,
        sourceUrl: evidence.sourceUrl,
        title: evidence.title,
        fetchedAt: new Date(evidence.fetchedAt),
        sourceType: evidence.sourceType,
        excerpt: evidence.excerpt,
        summary: evidence.summary,
        contentHash: evidence.contentHash,
        confidence: evidence.confidence,
        mediaContextJson: evidence.mediaContext||evidence.sourceCapture
          ? JSON.stringify({...evidence.mediaContext,...(evidence.sourceCapture?{sourceCapture:evidence.sourceCapture}:{})})
          : null,
        relatedClaimsJson: JSON.stringify(
          evidence.relatedClaims
        ),
        status: evidence.status,
        createdAt: new Date(evidence.createdAt)
      }
    });
    return mapEvidence(row);
  }

  async updateEvidenceRelatedClaims(
    id: string,
    relatedClaims: string[]
  ): Promise<ResearchEvidence> {
    const row =
      await this.prisma.researchEvidenceRecord.update({
        where: { id },
        data: {
          relatedClaimsJson: JSON.stringify(relatedClaims)
        }
      });
    return mapEvidence(row);
  }

  async listEvidence(runId: string): Promise<ResearchEvidence[]> {
    const rows = await this.prisma.researchEvidenceRecord.findMany({
      where: { runId },
      orderBy: { fetchedAt: "asc" }
    });
    return rows.map(mapEvidence);
  }

  async createBrief(
    brief: ResearchBrief
  ): Promise<ResearchBrief> {
    await this.prisma.researchBriefRecord.updateMany({
      where: {
        projectId: brief.projectId,
        status: "READY"
      },
      data: { status: "STALE" }
    });
    const row = await this.prisma.researchBriefRecord.create({
      data: {
        id: brief.id,
        projectId: brief.projectId,
        runId: brief.runId,
        status: brief.status,
        summary: brief.summary,
        findingsJson: JSON.stringify(brief.findings),
        claimsJson: JSON.stringify(brief.candidateClaims),
        usageRulesJson: JSON.stringify(brief.usageRules),
        opportunitiesJson: JSON.stringify(
          brief.contentOpportunities
        ),
        uncertaintiesJson: JSON.stringify(
          brief.uncertainties
        ),
        aiExecutionJson: brief.aiExecution
          ? JSON.stringify(brief.aiExecution)
          : null,
        contentHash: brief.contentHash,
        createdAt: new Date(brief.createdAt)
      }
    });
    return mapBrief(row);
  }

  async updateBriefClaims(
    id: string,
    claims: ResearchCandidateClaim[]
  ): Promise<ResearchBrief> {
    const row = await this.prisma.researchBriefRecord.update({
      where: { id },
      data: {
        claimsJson: JSON.stringify(claims)
      }
    });
    return mapBrief(row);
  }

  async updateBriefUsageRules(
    id: string,
    usageRules: ResearchUsageRule[]
  ): Promise<ResearchBrief> {
    const row = await this.prisma.researchBriefRecord.update({
      where: { id },
      data: {
        usageRulesJson: JSON.stringify(usageRules)
      }
    });
    return mapBrief(row);
  }

  async findBrief(id: string): Promise<ResearchBrief | null> {
    const row = await this.prisma.researchBriefRecord.findUnique({
      where: { id }
    });
    return row ? mapBrief(row) : null;
  }

  async latestBrief(
    projectId: string
  ): Promise<ResearchBrief | null> {
    const row = await this.prisma.researchBriefRecord.findFirst({
      where: { projectId, status: "READY" },
      orderBy: { createdAt: "desc" }
    });
    return row ? mapBrief(row) : null;
  }

  async findBriefByRun(
    runId: string
  ): Promise<ResearchBrief | null> {
    const row = await this.prisma.researchBriefRecord.findFirst({
      where: { runId },
      orderBy: { createdAt: "desc" }
    });
    return row ? mapBrief(row) : null;
  }

  async listBriefs(projectId: string): Promise<ResearchBrief[]> {
    const rows = await this.prisma.researchBriefRecord.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" }
    });
    return rows.map(mapBrief);
  }
}
