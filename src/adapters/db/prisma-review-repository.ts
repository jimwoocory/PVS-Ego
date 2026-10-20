import type { PrismaClient } from "@prisma/client";
import type { ReviewRepository } from "../../application/ports/review-repository.js";
import {
  reviewDecisionSchema,
  type ReviewDecision
} from "../../domain/schemas.js";

function toDomain(row: {
  id: string;
  projectId: string;
  clipId: string;
  clipHash: string;
  generationAttemptId: string | null;
  outputArtifactId: string | null;
  outputArtifactHash: string | null;
  decision: string;
  source: string;
  visualReviewJson: string | null;
  note: string | null;
  decidedAt: Date;
}): ReviewDecision {
  return reviewDecisionSchema.parse({
    id: row.id,
    projectId: row.projectId,
    clipId: row.clipId,
    clipHash: row.clipHash,
    ...(row.generationAttemptId ? { generationAttemptId: row.generationAttemptId } : {}),
    ...(row.outputArtifactId ? { outputArtifactId: row.outputArtifactId } : {}),
    ...(row.outputArtifactHash ? { outputArtifactHash: row.outputArtifactHash } : {}),
    decision: row.decision,
    source: row.source,
    ...(row.visualReviewJson
      ? { visualAssessment: JSON.parse(row.visualReviewJson) }
      : {}),
    ...(row.note ? { note: row.note } : {}),
    decidedAt: row.decidedAt.toISOString()
  });
}

export class PrismaReviewRepository implements ReviewRepository {
  constructor(private readonly db: PrismaClient) {}

  async createDecision(input: ReviewDecision): Promise<ReviewDecision> {
    const decision = reviewDecisionSchema.parse(input);
    const row = await this.db.reviewDecisionRecord.create({
      data: {
        id: decision.id,
        projectId: decision.projectId,
        clipId: decision.clipId,
        clipHash: decision.clipHash,
        generationAttemptId: decision.generationAttemptId ?? null,
        outputArtifactId: decision.outputArtifactId ?? null,
        outputArtifactHash: decision.outputArtifactHash ?? null,
        decision: decision.decision,
        source: decision.source ?? "USER",
        visualReviewJson: decision.visualAssessment
          ? JSON.stringify(decision.visualAssessment)
          : null,
        note: decision.note,
        decidedAt: new Date(decision.decidedAt)
      }
    });
    return toDomain(row);
  }

  async listDecisions(projectId: string): Promise<ReviewDecision[]> {
    const rows = await this.db.reviewDecisionRecord.findMany({
      where: { projectId },
      orderBy: { decidedAt: "asc" }
    });
    return rows.map(toDomain);
  }

  async listDecisionsForClip(
    projectId: string,
    clipId: string
  ): Promise<ReviewDecision[]> {
    const rows = await this.db.reviewDecisionRecord.findMany({
      where: { projectId, clipId },
      orderBy: { decidedAt: "asc" }
    });
    return rows.map(toDomain);
  }
}
