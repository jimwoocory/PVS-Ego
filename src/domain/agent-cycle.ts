import { z } from "zod";

export const businessStages = ["RESEARCH", "STRATEGY", "PRODUCTION", "PUBLICATION", "OPERATIONS", "FEEDBACK"] as const;
export const businessStageSchema = z.enum(businessStages);
export type BusinessStage = z.infer<typeof businessStageSchema>;
export const agentCycleInputSchema = z.object({
  goal: z.string().trim().min(3).max(6000),
  requestKey: z.string().trim().min(1).max(120),
  stages: z.array(businessStageSchema).min(1).max(6).default([...businessStages]),
  maxSteps: z.number().int().min(1).max(80).default(60),
  maxToolCalls: z.number().int().min(1).max(60).default(48)
}).strict();
export type AgentCycleInput = z.infer<typeof agentCycleInputSchema>;
export type AgentCycleStatus = "READY" | "RUNNING" | "WAITING_USER" | "WAITING_CONFIRMATION" | "BLOCKED" | "OUTCOME_UNKNOWN" | "COMPLETED" | "CANCELLED";
export type CapabilityEffect = "READ" | "LOCAL" | "MODEL" | "EXTERNAL_WRITE" | "PAID_GENERATION" | "HUMAN_DECISION";
/** Optional, process-local execution feedback. It never confers business permission. */
export type LocalActionExecution = {
  phase: "CONNECTING" | "CONNECTED" | "OBSERVING" | "CANCELLING" | "SUCCEEDED" | "CANCELLED" | "TIMED_OUT" | "FAILED";
  version: number; samples: number; workerExited: boolean;
};
export type CycleEvidence = { stage: BusinessStage; kind: string; id: string; detail?: string };
export type CapabilityResult = {
  status: "COMPLETE" | "PARTIAL" | "RUNNING" | "WAITING_USER" | "BLOCKED" | "OUTCOME_UNKNOWN";
  summary: string;
  data?: unknown;
  evidence?: CycleEvidence[];
  resumeHref?: string;
};
export type CycleAction = {
  id: string; requestKey: string; capabilityId: string; input: Record<string, unknown>;
  inputHash: string; contextHash: string; status: "PROPOSED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "OUTCOME_UNKNOWN";
  effect: CapabilityEffect; preview: string; proposedAt: string; confirmedAt?: string;
  startedAt?: string; completedAt?: string; result?: CapabilityResult; error?: string;
  resultObservationHash?: string;
  localExecution?: LocalActionExecution;
};
export type AgentCycle = {
  id: string; projectId: string; input: AgentCycleInput; inputHash: string; revision: number;
  status: AgentCycleStatus; steps: number; actions: CycleAction[]; evidence: CycleEvidence[];
  loadedSkills: Array<{id: string; version: string; digest: string}>;
  messages: Array<{role: "user" | "agent" | "system"; text: string; at: string}>;
  nextWakeAt?: string; createdAt: string; updatedAt: string;
};
export const agentDecisionSchema = z.discriminatedUnion("action", [
  z.object({action: z.literal("LOAD_SKILL"), skillId: z.string().min(1), reason: z.string().min(1)}).strict(),
  z.object({action: z.literal("CALL_CAPABILITY"), capabilityId: z.string().min(1), input: z.record(z.string(), z.unknown()), reason: z.string().min(1)}).strict(),
  z.object({action: z.literal("ASK_USER"), question: z.string().min(1).max(2000)}).strict(),
  z.object({action: z.literal("FINISH"), summary: z.string().min(1).max(3000)}).strict()
]);
