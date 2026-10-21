import type { AgentCycle } from "../../domain/agent-cycle.js";

export interface AgentCycleRepository {
  create(cycle: AgentCycle): Promise<AgentCycle>;
  get(projectId: string, id: string): Promise<AgentCycle | null>;
  list(projectId?: string): Promise<AgentCycle[]>;
  listWorkerPage?(now:string,afterId?:string):Promise<{cycles:AgentCycle[];nextAfterId?:string}>;
  claim(projectId: string, id: string, owner: string): Promise<boolean>;
  save(cycle: AgentCycle, expectedRevision: number, owner: string): Promise<AgentCycle>;
  release(id: string, owner: string): Promise<void>;
  recoverAbandoned(projectId: string, id: string): Promise<boolean>;
}
