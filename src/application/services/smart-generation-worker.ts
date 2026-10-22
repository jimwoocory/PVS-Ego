import { runnableSmartStatuses } from "../../domain/smart-generation.js";
import type { SmartGenerationService } from "./smart-generation-service.js";

export type SmartWorkerScope = { projectId: string; runId: string };
export type SmartWorkerPolicy =
  | { mode: "ALL" }
  | { mode: "DISABLED" }
  | { mode: "SCOPED"; scope: SmartWorkerScope }
  | { mode: "MANAGED"; legacyScope?: SmartWorkerScope };

/** A safe-launch process may explicitly permit ONE run while all legacy runs stay disabled. */
export function resolveSmartWorkerPolicy(env: NodeJS.ProcessEnv = process.env): SmartWorkerPolicy {
  if (env.PVS_SMART_WORKER_DISABLED !== "1") return { mode: "ALL" };
  // Only runs explicitly granted by durable user creation/resume may advance.
  // The old scoped run is preserved; unrelated preexisting jobs stay inert.
  if (env.PVS_SMART_WORKER_MANAGED_NEW_RUNS === "1") {
    const projectId = env.PVS_SMART_WORKER_SCOPE_PROJECT_ID?.trim();
    const runId = env.PVS_SMART_WORKER_SCOPE_RUN_ID?.trim();
    return projectId && runId && env.PVS_SMART_WORKER_SCOPED_ENABLED === "1"
      ? { mode: "MANAGED", legacyScope: { projectId, runId } }
      : { mode: "MANAGED" };
  }
  const projectId = env.PVS_SMART_WORKER_SCOPE_PROJECT_ID?.trim();
  const runId = env.PVS_SMART_WORKER_SCOPE_RUN_ID?.trim();
  if (env.PVS_SMART_WORKER_SCOPED_ENABLED === "1" && projectId && runId) {
    return { mode: "SCOPED", scope: { projectId, runId } };
  }
  return { mode: "DISABLED" };
}

export function canWorkerAdvanceRun(
  policy: SmartWorkerPolicy, projectId: string, runId: string,
  grant?: { projectId: string; runId: string }
): boolean {
  if (policy.mode === "ALL") return true;
  if (policy.mode === "SCOPED")
    return policy.scope.projectId === projectId && policy.scope.runId === runId;
  if (policy.mode !== "MANAGED") return false;
  const legacy = policy.legacyScope?.projectId === projectId && policy.legacyScope.runId === runId;
  const granted = grant?.projectId === projectId && grant.runId === runId;
  return legacy || granted;
}

/** Backend production worker. An optional exact scope NEVER scans or advances other runs. */
export function startSmartGenerationWorker(service: SmartGenerationService, options: {
  intervalMs?: number;
  onError?: (error: unknown) => void;
  scope?: SmartWorkerScope;
  policy?: SmartWorkerPolicy;
} = {}): () => void {
  const policy: SmartWorkerPolicy = options.policy ??
    (options.scope ? { mode: "SCOPED", scope: options.scope } : { mode: "ALL" });
  if (policy.mode === "DISABLED") return () => {};
  let stopped = false, working = false;
  let startupRecovered = false;
  let afterId:string|undefined;
  const tick = async () => {
    if (stopped || working) return;
    working = true;
    try {
      // Recovery and advancement share the same single-flight guard. Retry a
      // failed startup on a later tick; never advance while it is unresolved.
      if (policy.mode === "ALL" && !startupRecovered) {
        await service.recoverAbandoned();
        startupRecovered = true;
      }
      if (stopped) return;
      if (policy.mode === "SCOPED") {
        // A lease can become abandoned long after startup, too.
        await service.recoverAbandonedScoped(policy.scope.projectId, policy.scope.runId);
      }
      if (stopped) return;
      // A scoped launch must not list, recover or mutate historical runs.
      const page = policy.mode === "SCOPED"
        ? {runs:[await service.get(policy.scope.projectId, policy.scope.runId)].filter(
          (run): run is NonNullable<typeof run> => Boolean(run)
        ),nextAfterId:undefined}
        : service.listWorkerPage ? await service.listWorkerPage({afterId,mode:policy.mode,...(policy.mode==="MANAGED"?{legacyScope:policy.legacyScope}:{})}) : {runs:await service.list(),nextAfterId:undefined};
      for (const original of page.runs) {
        if (stopped) break;
        // Reading the task index never grants execution permission to old runs.
        if (!canWorkerAdvanceRun(policy, original.projectId, original.id, original.autoAdvanceGrant)) continue;
        if (policy.mode === "MANAGED" || policy.mode === "ALL") {
          // Owners can die after startup. Recheck only a run this policy may
          // advance; the service leaves every live or unknown OS owner intact.
          try{await service.recoverAbandonedScoped(original.projectId, original.id);}
          catch(error){options.onError?.(error);continue;}
        }
        if (stopped) break;
        let run = original;
        // Advance bounded stages; external provider jobs are only polled once per tick.
        for (let steps = 0; steps < 20 && runnableSmartStatuses.includes(run.status) && !stopped; steps++) {
          const externalPoll = run.status === "GENERATING" || run.status === "ASSET_PREPARING";
          try { run = await service.advance(run.projectId, run.id); }
          catch (error) { options.onError?.(error); break; }
          if (externalPoll) break;
        }
      }
      if(!stopped)afterId=page.nextAfterId;
    } catch (error) { options.onError?.(error); }
    finally { working = false; }
  };
  const timer = setInterval(() => { void tick(); }, Math.max(1000, options.intervalMs ?? 5000));
  timer.unref();
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}
