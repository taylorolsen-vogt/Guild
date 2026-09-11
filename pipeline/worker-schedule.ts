import type { Project } from "../schemas/project.js";
import type { PipelineRun } from "../schemas/run.js";

const HOUR = 3_600_000;
export const workerSources = ["arxiv", "github", "government", "news"];
export type WorkerJob = "discovery" | "revalidation";
export interface WorkerConfig {
  target: number;
  maxNoProgressRuns: number;
  discoveryMs: number;
  revalidationMs: number;
  pollMs: number;
  limit: number;
  query: string | undefined;
}

/** No environment, database, or model access: importing this module is safe in tests. */
export function parseWorkerConfig(env: Record<string, string | undefined>): WorkerConfig {
  function hours(name: string, fallback: number): number {
    const raw = env[name];
    const value = raw === undefined ? fallback : Number(raw);
    const ms = value * HOUR;
    if (!Number.isFinite(ms) || value <= 0 || ms < 1 || ms > Number.MAX_SAFE_INTEGER) {
      throw new Error(`${name} must be finite positive hours (at least 1 ms).`);
    }
    return ms;
  }
  const pollSeconds = Number(env.WORKER_POLL_SECONDS ?? "60");
  if (!Number.isFinite(pollSeconds) || pollSeconds < 5 || pollSeconds > 3600) {
    throw new Error("WORKER_POLL_SECONDS must be from 5 to 3600 seconds.");
  }
  const limit = Number(env.WORKER_DISCOVERY_LIMIT ?? "5");
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new Error("WORKER_DISCOVERY_LIMIT must be an integer from 1 to 25.");
  }
  function positiveInteger(name: string, fallback: number): number {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer.`);
    return value;
  }
  const query = env.DISCOVERY_QUERY?.trim() || undefined;
  if (query && (query.length > 120 || query.split(/\s+/).length > 8)) {
    throw new Error("DISCOVERY_QUERY must be a short search query (at most 120 characters and 8 words), not a prompt.");
  }
  return {
    target: positiveInteger("WORKER_TARGET_PROJECTS", 50),
    maxNoProgressRuns: positiveInteger("WORKER_MAX_NO_PROGRESS_RUNS", 8),
    discoveryMs: hours("WORKER_DISCOVERY_HOURS", 1 / 12),
    revalidationMs: hours("WORKER_REVALIDATION_HOURS", 24),
    pollMs: pollSeconds * 1000,
    limit,
    query,
  };
}

export type CountableProject = Pick<Project, "id" | "agentReview" | "decision" | "status" | "lifecycleStatus">;

/** Approved proposals retain status=draft until human curation; unreviewed drafts never count. */
export function isActiveApprovedProject(project: Omit<CountableProject, "id">): boolean {
  return project.agentReview.decision === "approved"
    && (project.decision === "selected" || project.decision === "pending")
    && project.status !== "archived" && project.lifecycleStatus !== "completed";
}

export function activeApprovedProjectIds(projects: readonly CountableProject[]): Set<string> {
  return new Set(projects.filter(isActiveApprovedProject).map((project) => project.id));
}

export type PausedReason = "goal_reached" | "no_progress";
export interface WorkerProgress {
  target: number;
  pausedReason: PausedReason | null;
  pausedAt: string | null;
  briefIndex: number; // Durable cursor for the NEXT batch, not a date or a predicted run.
  noProgressRuns: number;
  attemptPending: boolean;
  lastRunId: string | null;
  lastError: string | null; // Only fixed, public-safe error summaries, never raw API/DB errors.
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastProgressAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function initialWorkerProgress(target: number, at: string): WorkerProgress {
  return {
    target, pausedReason: null, pausedAt: null, briefIndex: 0, noProgressRuns: 0,
    attemptPending: false, lastRunId: null, lastError: null,
    lastStartedAt: null, lastFinishedAt: null, lastProgressAt: null, createdAt: at, updatedAt: at,
  };
}

/** Sticky even if projects are later rejected/completed or the configured target increases. */
export function reconcileWorkerGoal(state: WorkerProgress, count: number, maxNoProgressRuns: number, at: string): WorkerProgress {
  if (state.pausedReason) return state;
  const reason = count >= state.target ? "goal_reached"
    : !state.attemptPending && state.noProgressRuns >= maxNoProgressRuns ? "no_progress" : null;
  return reason ? { ...state, pausedReason: reason, pausedAt: at, updatedAt: at } : state;
}

/** Persist this BEFORE creating/running paid work. A crash consumes an attempt and a brief. */
export function beginDiscoveryAttempt(state: WorkerProgress, at: string): WorkerProgress {
  if (state.pausedReason || state.attemptPending) throw new Error("Discovery is paused or already in flight.");
  return {
    ...state, briefIndex: state.briefIndex + 1, noProgressRuns: state.noProgressRuns + 1,
    attemptPending: true, lastRunId: null, lastError: null, lastStartedAt: at, updatedAt: at,
  };
}

export function finishDiscoveryAttempt(state: WorkerProgress, additions: number, error: string | null, at: string): WorkerProgress {
  return {
    ...state, attemptPending: false, noProgressRuns: additions > 0 ? 0 : state.noProgressRuns,
    lastProgressAt: additions > 0 ? at : state.lastProgressAt,
    lastFinishedAt: at, lastError: error, updatedAt: at,
  };
}

/** Explicit manual reassessment only; never called by a poll, restart, or a falling count. */
export function clearDiscoveryPause(state: WorkerProgress, at: string): WorkerProgress {
  if (state.attemptPending) throw new Error("Cannot reassess an unfinished discovery attempt.");
  return { ...state, pausedReason: null, pausedAt: null, noProgressRuns: 0, lastError: null, updatedAt: at };
}

export interface AttemptSettlementDependencies {
  getRun(id: string): Promise<PipelineRun>;
  updateRun(id: string, changes: Partial<Omit<PipelineRun, "id" | "createdAt">>): Promise<PipelineRun>;
  approvedIds(): Promise<Set<string>>;
  now(): string;
  checkpoint(time: number): Promise<void>;
  save(state: WorkerProgress): Promise<void>;
}

/** Caller MUST hold the worker lock. Only the atomically linked worker run can be
 * recovered. Never enumerate/recover other running CLI or admin pipelines.
 * Pure dependency injection keeps crash and restart regressions offline.
 */
export async function settleTrackedAttempt(
  state: WorkerProgress, maxNoProgressRuns: number, interrupted: boolean, dependencies: AttemptSettlementDependencies,
): Promise<{ state: WorkerProgress; run: PipelineRun; additions: number; count: number } | null> {
  if (!state.attemptPending) return null;
  if (!state.lastRunId) throw new Error("Unfinished worker attempt has no tracked run.");
  let run = await dependencies.getRun(state.lastRunId);
  if (run.id !== state.lastRunId) throw new Error("Worker run ownership mismatch.");
  if (run.status === "queued" || run.status === "running") {
    run = await dependencies.updateRun(run.id, {
      status: "failed", stage: "failed",
      message: interrupted ? "Worker discovery was interrupted" : "Worker discovery did not finish",
      error: "The tracked worker attempt ended without completing. Partial drafts are retained for review.",
    });
  }
  const ids = await dependencies.approvedIds();
  // Per-run new IDs, not a net count: unrelated human rejections cannot hide additions.
  const additions = new Set(run.artifactIds.projects.filter((id) => ids.has(id))).size;
  const error = run.status === "failed" ? "Discovery failed; inspect the tracked pipeline run."
    : run.warnings.length ? "Discovery completed with warnings; inspect the tracked pipeline run." : null;
  const at = dependencies.now();
  state = reconcileWorkerGoal(finishDiscoveryAttempt(state, additions, error, at), ids.size, maxNoProgressRuns, at);
  // Cooldown first. If saving state crashes, recovery can repeat without charging
  // another attempt; a durable finished state never lacks its cooldown checkpoint.
  await dependencies.checkpoint(Date.parse(at));
  await dependencies.save(state);
  return { state, run, additions, count: ids.size };
}

export function latestTimestamp(values: readonly (string | null | undefined)[]): number | null {
  const valid = values.map((value) => value == null ? NaN : Date.parse(value)).filter(Number.isFinite);
  return valid.length ? Math.max(...valid) : null;
}

/** Future checkpoints defer work (clock rollback); malformed timestamps do not poison the schedule. */
export function isDue(now: number, intervalMs: number, lastActivity: number | null): boolean {
  if (!Number.isFinite(now) || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("A finite clock and positive interval are required.");
  }
  return lastActivity === null || !Number.isFinite(lastActivity) || now - lastActivity >= intervalMs;
}

export function projectNeedsRevalidation(project: Pick<Project,
  "decision" | "status" | "lifecycleStatus" | "verificationHistory"
>, now: number, intervalMs: number): boolean {
  return project.decision === "selected"
    && project.status !== "archived"
    && project.lifecycleStatus !== "completed"
    && isDue(now, intervalMs, latestTimestamp(project.verificationHistory.map((item) => item.checkedAt)));
}

/** Update this project only, never publish or change the human decision. */
export function applyVerification(project: Project, verification: Project["verificationHistory"][number]): Project {
  return {
    ...project,
    lifecycleStatus: verification.status === "inconclusive" ? project.lifecycleStatus : verification.status,
    verificationHistory: [...project.verificationHistory, verification],
    status: verification.status === "completed" ? "archived" : project.status,
  };
}

export interface DueJobDependencies {
  now(): Promise<number>;
  canRun?(job: WorkerJob): Promise<boolean>;
  lastActivity(job: WorkerJob): Promise<number | null>;
  checkpoint(job: WorkerJob, now: number): Promise<void>;
  execute(job: WorkerJob): Promise<void>;
  stopping(): boolean;
  reportError(job: WorkerJob, error: unknown): void | Promise<void>;
}

/** Caller MUST hold the database lock. Checkpoints commit independently of that transaction. */
export async function runDueJobs(config: WorkerConfig, dependencies: DueJobDependencies): Promise<void> {
  for (const job of ["discovery", "revalidation"] as const) {
    if (dependencies.stopping()) return;
    if (dependencies.canRun && !await dependencies.canRun(job)) continue;
    const now = await dependencies.now();
    const interval = job === "discovery" ? config.discoveryMs : config.revalidationMs;
    if (!isDue(now, interval, await dependencies.lastActivity(job))) continue;
    // Persist BEFORE any paid work, including attempts that crash or find no projects/evidence.
    await dependencies.checkpoint(job, now);
    try {
      await dependencies.execute(job);
    } catch (error) {
      await dependencies.reportError(job, error);
    }
    // Long jobs and failures receive a full cooldown, not immediate catch-up work.
    await dependencies.checkpoint(job, await dependencies.now());
  }
}