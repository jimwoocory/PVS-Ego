import type { CreativeReferenceSet, ResearchMediaCandidate, ReferenceReviewInput } from "../../domain/creative-reference.js";

export type ReferenceDecision = { candidateId: string; decision: ReferenceReviewInput["changes"][number]["decision"]; version: number };
export type ReferencePoolState = { revision: number; set: CreativeReferenceSet | null };
export interface CreativeReferenceRepository {
  addCandidate(candidate: ResearchMediaCandidate): Promise<ResearchMediaCandidate>;
  findCapture(projectId: string, key: string): Promise<ResearchMediaCandidate | null>;
  candidate(projectId: string, id: string): Promise<ResearchMediaCandidate | null>;
  candidates(projectId: string): Promise<ResearchMediaCandidate[]>;
  state(projectId: string): Promise<ReferencePoolState>;
  decisions(projectId: string): Promise<ReferenceDecision[]>;
  /** Atomic CAS of review set plus downstream invalidation. No old Artifact or fact is changed. */
  confirm(projectId: string, set: CreativeReferenceSet | null, input: ReferenceReviewInput): Promise<ReferencePoolState>;
}

export type CapturedResearchMedia = {
  projectId: string; runId: string; parentSourceUrl: string; mediaUrl: string; title: string; sourceType: string;
  sourceBytes: Uint8Array; sourceMimeType: string;
  images: Array<{ bytes: Uint8Array; mimeType: "image/jpeg" | "image/png" | "image/webp"; timestampMs?: number; frameIndex?: number }>;
};
export interface ResearchReferenceSink { capture(input: CapturedResearchMedia): Promise<void>; }
