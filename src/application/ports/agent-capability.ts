import type { z } from "zod";
import type { BusinessStage, CapabilityEffect, CapabilityResult } from "../../domain/agent-cycle.js";

export type AgentCapabilityContext = {projectId: string; cycleId: string; actionId: string; confirmed: boolean};
export type AgentCapability = {
  id: string; title: string; description: string; stage?: BusinessStage;
  effect: CapabilityEffect; inputSchema: z.ZodType;
  run(context: AgentCapabilityContext, input: Record<string, unknown>): Promise<CapabilityResult>;
  preview?(projectId: string, input: Record<string, unknown>): Promise<string>;
};
export interface AgentCapabilityCatalog {
  list(): AgentCapability[];
  get(id: string): AgentCapability;
  snapshot(projectId: string): Promise<Record<string, unknown>>;
  fingerprint(projectId: string, capabilityId?:string, input?:Record<string,unknown>): Promise<string>;
  validateCompletion(projectId: string, stages: BusinessStage[], evidence: import("../../domain/agent-cycle.js").CycleEvidence[]): Promise<string[]>;
}
