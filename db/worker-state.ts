import {
  clearDiscoveryPause, initialWorkerProgress, parseWorkerConfig,
  type WorkerJob, type WorkerProgress,
} from "../pipeline/worker-schedule.js";
import { randomUUID } from "node:crypto";
import { pipelineRunSchema, type PipelineRun } from "../schemas/run.js";

// Shared with the original worker; all worker execution and manual reassessment
// use this transaction-scoped lock, including with transaction poolers.
export const WORKER_LOCK_NAMESPACE = 1196771660;
export const WORKER_LOCK_ID = 1;
let initialization: Promise<void> | undefined;

/** Call once at BOTH worker and admin startup, BEFORE acquiring any work locks.
 * Imports are inert and status reads never do DDL (including on another connection).
 * Existing job checkpoints survive the migration from the interval-only worker.
 */
export async function initializeWorkerState(): Promise<void> {
  initialization ??= (async () => {
    const { sql, initializeDatabase } = await import("./repository.js");
    await initializeDatabase();
    const state = initialWorkerProgress(parseWorkerConfig(process.env).target, new Date().toISOString());
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${WORKER_LOCK_NAMESPACE}, 2)`;
      await tx`
        CREATE TABLE IF NOT EXISTS worker_state (
          job TEXT PRIMARY KEY CHECK (job IN ('discovery', 'revalidation')),
          last_activity_at TIMESTAMPTZ NOT NULL
        )
      `;
      await tx`ALTER TABLE worker_state ADD COLUMN IF NOT EXISTS state JSONB`;
      await tx`ALTER TABLE worker_state ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ`;
      await tx`ALTER TABLE worker_state ENABLE ROW LEVEL SECURITY`;
      await tx`
        INSERT INTO worker_state (job, last_activity_at, state)
        VALUES ('discovery', '1970-01-01T00:00:00Z', ${sql.json({ ...state })})
        ON CONFLICT (job) DO UPDATE SET state = coalesce(worker_state.state, excluded.state)
      `;
    });
  })();
  await initialization;
}

export async function readWorkerProgress(): Promise<WorkerProgress> {
  const { sql } = await import("./repository.js");
  const rows = await sql<{ state: WorkerProgress }[]>`SELECT state FROM worker_state WHERE job = 'discovery'`;
  if (!rows[0]?.state) throw new Error("Call initializeWorkerState at startup before accessing worker state.");
  return rows[0].state;
}

/** Internal writes require the worker lock. Heartbeat is separate to avoid lost updates. */
export async function saveWorkerProgress(state: WorkerProgress): Promise<void> {
  const { sql } = await import("./repository.js");
  await sql`UPDATE worker_state SET state = ${sql.json({ ...state })} WHERE job = 'discovery'`;
}

/** Atomically track the queued run and pre-charge the attempt/cursor BEFORE any
 * source/model work. Unlike create-then-link, a crash cannot leave an unowned run.
 * Caller holds the work lock; this short transaction commits independently of it.
 */
export async function checkpointDiscoveryAttempt(
  state: WorkerProgress,
  input: { query: string; sources: string[]; limit: number },
): Promise<PipelineRun> {
  const { sql } = await import("./repository.js");
  const at = state.lastStartedAt!;
  const run = pipelineRunSchema.parse({
    id: randomUUID(), ...input, reviewMode: "human_review",
    status: "queued", stage: "queued", message: "Waiting to start",
    warnings: [], error: null,
    artifactIds: { evidence: [], candidates: [], dossiers: [], problems: [], projects: [] },
    createdAt: at, updatedAt: at,
  });
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO pipeline_runs (id, payload, created_at, updated_at)
      VALUES (${run.id}, ${sql.json(run)}, ${at}, ${at})
    `;
    await tx`
      UPDATE worker_state SET state = ${sql.json({ ...state, lastRunId: run.id })}, last_activity_at = ${at}
      WHERE job = 'discovery'
    `;
  });
  return run;
}

export async function heartbeatWorker(): Promise<void> {
  const { sql } = await import("./repository.js");
  await sql`UPDATE worker_state SET heartbeat_at = clock_timestamp() WHERE job = 'discovery'`;
}

export async function workerLastActivity(job: WorkerJob): Promise<number | null> {
  const { sql } = await import("./repository.js");
  const rows = await sql<{ at: string }[]>`
    SELECT last_activity_at::text AS at FROM worker_state WHERE job = ${job}
  `;
  return rows[0] ? Date.parse(rows[0].at) : null;
}

export async function checkpointWorkerJob(job: WorkerJob, time: number): Promise<void> {
  const { sql } = await import("./repository.js");
  await sql`
    INSERT INTO worker_state (job, last_activity_at) VALUES (${job}, ${new Date(time).toISOString()})
    ON CONFLICT (job) DO UPDATE SET last_activity_at = excluded.last_activity_at
  `;
}

// SQL equivalent of isActiveApprovedProject. No publication is performed here.
// All count/status reads use this single implementation; no schema/model calls.
export async function getActiveApprovedProjectIds(): Promise<Set<string>> {
  const { sql } = await import("./repository.js");
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM artifacts WHERE kind = 'project'
      AND payload->'agentReview'->>'decision' = 'approved'
      AND payload->>'decision' IN ('pending', 'selected')
      AND coalesce(payload->>'status', 'draft') <> 'archived'
      AND coalesce(payload->>'lifecycleStatus', 'unverified') <> 'completed'
  `;
  return new Set(rows.map((row) => row.id));
}

export interface WorkerStatus extends WorkerProgress {
  count: number;
  heartbeatAt: string | null;
  lastDiscoveryAt: string | null;
  lastRevalidationAt: string | null;
  lastRunStatus: PipelineRun["status"] | null;
  lastRunStage: PipelineRun["stage"] | null;
  lastRunUpdatedAt: string | null;
}

/** Read-only admin projection. No queries, prompts, credentials, raw exceptions,
 * automatic recovery, DDL, heartbeat writes, or predicted run statuses.
 */
export async function getWorkerStatus(): Promise<WorkerStatus> {
  const { sql } = await import("./repository.js");
  const rows = await sql<{
    state: WorkerProgress; heartbeat: string | null; discovery: string | null; revalidation: string | null;
    run_status: PipelineRun["status"] | null; run_stage: PipelineRun["stage"] | null; run_updated: string | null;
  }[]>`
    SELECT d.state, d.heartbeat_at::text AS heartbeat, d.last_activity_at::text AS discovery,
      r.last_activity_at::text AS revalidation, p.payload->>'status' AS run_status,
      p.payload->>'stage' AS run_stage, p.payload->>'updatedAt' AS run_updated
    FROM worker_state d LEFT JOIN worker_state r ON r.job = 'revalidation'
    LEFT JOIN pipeline_runs p ON p.id::text = d.state->>'lastRunId'
    WHERE d.job = 'discovery'
  `;
  const row = rows[0];
  if (!row?.state) throw new Error("Call initializeWorkerState at startup before accessing worker status.");
  const iso = (value: string | null) => value ? new Date(value).toISOString() : null;
  // Explicit allowlist: future internal state fields are not automatically exposed.
  const s = row.state;
  return {
    target: s.target, count: (await getActiveApprovedProjectIds()).size,
    pausedReason: s.pausedReason, pausedAt: s.pausedAt,
    heartbeatAt: iso(row.heartbeat), lastError: s.lastError,
    briefIndex: s.briefIndex, noProgressRuns: s.noProgressRuns, attemptPending: s.attemptPending,
    lastRunId: s.lastRunId, lastRunStatus: row.run_status, lastRunStage: row.run_stage,
    lastRunUpdatedAt: row.run_updated, lastStartedAt: s.lastStartedAt,
    lastFinishedAt: s.lastFinishedAt, lastProgressAt: s.lastProgressAt,
    lastDiscoveryAt: row.discovery && Date.parse(row.discovery) !== 0 ? iso(row.discovery) : null,
    lastRevalidationAt: iso(row.revalidation), createdAt: s.createdAt, updatedAt: s.updatedAt,
  };
}

/** Optional manual integration: caller must explicitly reassess. Not called on startup.
 * Does not change the target/cursor/cooldown. A still-satisfied goal pauses again.
 */
export async function clearWorkerPause(): Promise<void> {
  await initializeWorkerState(); // Always BEFORE holding a lock.
  const { sql } = await import("./repository.js");
  await sql.begin(async (tx) => {
    const locks = await tx<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(${WORKER_LOCK_NAMESPACE}, ${WORKER_LOCK_ID}) AS acquired
    `;
    if (!locks[0]?.acquired) throw new Error("Worker is busy; reassess when its current batch finishes.");
    const state = clearDiscoveryPause(await readWorkerProgress(), new Date().toISOString());
    await saveWorkerProgress(state);
  });
}