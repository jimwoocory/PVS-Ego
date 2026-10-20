import type { ReviewDecision } from "../../domain/schemas.js";

export interface ReviewRepository {
  createDecision(decision: ReviewDecision): Promise<ReviewDecision>;
  listDecisions(projectId: string): Promise<ReviewDecision[]>;
  listDecisionsForClip(projectId: string, clipId: string): Promise<ReviewDecision[]>;
}
