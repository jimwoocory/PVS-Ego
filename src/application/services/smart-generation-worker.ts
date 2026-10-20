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
  let stopped = false, working = false;
  const tick = async () => {
    if (stopped || working) return;
    working = true;
    try {
      // A scoped launch must not list, recover or mutate historical runs.
      const originalRuns = policy.mode === "SCOPED"
        ? [await service.get(policy.scope.projectId, policy.scope.runId)].filter(
          (run): run is NonNullable<typeof run> => Boolean(run)
        )
        : await service.list();
      for (const original of originalRuns) {
        // Reading the task index never grants execution permission to old runs.
        if (!canWorkerAdvanceRun(policy, original.projectId, original.id, original.autoAdvanceGrant)) continue;
        if (policy.mode === "MANAGED") {
          // Only a specifically granted run's provably dead lease can be recovered.
          await service.recoverAbandonedScoped(original.projectId, original.id);
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
    } catch (error) { options.onError?.(error); }
    finally { working = false; }
  };
  const timer = setInterval(() => { void tick(); }, Math.max(1000, options.intervalMs ?? 5000));
  timer.unref();
  if (policy.mode === "SCOPED") {
    // At startup recover ONLY the exact scoped run.
    void service.recoverAbandonedScoped(policy.scope.projectId, policy.scope.runId)
      .then(tick)
      .catch((error) => options.onError?.(error));
  } else if (policy.mode === "MANAGED") {
    // NO global lease recovery or historical Run advancement on startup.
    void tick();
  } else if (policy.mode === "ALL") {
    void service.recoverAbandoned().then(tick).catch((error) => options.onError?.(error));
  }
  return () => { stopped = true; clearInterval(timer); };
}
