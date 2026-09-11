import { randomUUID } from "node:crypto";
import {
  newSearchCycle, projectCycle, searchCycleProfileSchema, searchCycleSchema,
  type SearchCycle, type SearchCycleProfile,
} from "../schemas/search-cycle.js";
import { pipelineRunSchema, type PipelineRun } from "../schemas/run.js";

// Separate from the long worker work lock (namespace, 1). Enqueue never waits for paid work.
const NAMESPACE = 1196771660;
const ENQUEUE_LOCK = 3;
const SCHEMA_LOCK = 4;
let initialization: Promise<void> | undefined;

/** Both API and worker must await this BEFORE acquiring the worker work lock. */
export async function initializeSearchCycles(): Promise<void> {
  initialization ??= (async () => {
    const { sql, initializeDatabase } = await import("./repository.js");
    await initializeDatabase();
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${NAMESPACE}, ${SCHEMA_LOCK})`;
      await tx`
        CREATE TABLE IF NOT EXISTS search_cycles (
          id UUID PRIMARY KEY,
          payload JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL,
          CHECK (payload->>'status' IN ('queued', 'running', 'completed', 'failed'))
        )
      `;
      await tx`ALTER TABLE search_cycles ENABLE ROW LEVEL SECURITY`;
      // Defense in depth: even a future caller without the enqueue lock cannot double-queue.
      await tx`CREATE UNIQUE INDEX IF NOT EXISTS search_cycles_one_outstanding
        ON search_cycles ((1)) WHERE payload->>'status' IN ('queued', 'running')`;
    });
  })();
  await initialization;
}

export interface EnqueueTransaction {
  outstanding(): Promise<SearchCycle | null>;
  insert(cycle: SearchCycle): Promise<void>;
}
export interface EnqueueDependencies {
  /** Must serialize a SHORT transaction under the enqueue lock, never the work lock. */
  transaction<T>(operation: (tx: EnqueueTransaction) => Promise<T>): Promise<T>;
}

/** Queue data only. No worker imports, fire-and-forget promises, source searches or model calls. */
export async function enqueueSearchCycle(
  profile: SearchCycleProfile, dependencies?: EnqueueDependencies,
): Promise<{ cycle: SearchCycle; alreadyQueued: boolean }> {
  searchCycleProfileSchema.parse(profile);
  const enqueue = async (tx: EnqueueTransaction) => {
    const outstanding = await tx.outstanding();
    if (outstanding) return { cycle: outstanding, alreadyQueued: true };
    const cycle = newSearchCycle(profile);
    await tx.insert(cycle);
    return { cycle, alreadyQueued: false };
  };
  if (dependencies) return dependencies.transaction(enqueue);
  const { sql } = await import("./repository.js");
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${NAMESPACE}, ${ENQUEUE_LOCK})`;
    return enqueue({
      outstanding: async () => {
        const rows = await tx<{ payload: unknown }[]>`
          SELECT payload FROM search_cycles WHERE payload->>'status' IN ('queued', 'running')
          ORDER BY created_at LIMIT 1
        `;
        return rows[0] ? searchCycleSchema.parse(rows[0].payload) : null;
      },
      insert: async (cycle) => {
        await tx`INSERT INTO search_cycles (id, payload, created_at, updated_at)
          VALUES (${cycle.id}, ${sql.json(cycle)}, ${cycle.createdAt}, ${cycle.updatedAt})`;
      },
    });
  });
}

/** Read-only: startup and status requests must never recover someone else's work. */
export async function listSearchCycles(): Promise<SearchCycle[]> {
  const { sql } = await import("./repository.js");
  const rows = await sql<{ payload: unknown }[]>`SELECT payload FROM search_cycles ORDER BY created_at DESC`;
  return rows.map((row) => searchCycleSchema.parse(row.payload));
}

/** All following functions are worker-only, called under the EXISTING worker advisory lock. */
export async function claimSearchCycle(): Promise<SearchCycle | null> {
  const { sql } = await import("./repository.js");
  return sql.begin(async (tx) => {
    const rows = await tx<{ payload: unknown }[]>`
      SELECT payload FROM search_cycles WHERE payload->>'status' = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE
    `;
    if (!rows[0]) return null;
    const at = new Date().toISOString();
    const cycle = searchCycleSchema.parse({ ...searchCycleSchema.parse(rows[0].payload),
      status: "running", startedAt: at, updatedAt: at, message: "Worker claimed the manual cycle" });
    await tx`UPDATE search_cycles SET payload = ${sql.json(cycle)}, updated_at = ${at} WHERE id = ${cycle.id}`;
    return cycle;
  });
}

export async function saveSearchCycle(value: SearchCycle): Promise<SearchCycle> {
  const { sql } = await import("./repository.js");
  const cycle = projectCycle(value);
  const rows = await sql<{ id: string }[]>`
    UPDATE search_cycles SET payload = ${sql.json(cycle)}, updated_at = ${cycle.updatedAt}
    WHERE id = ${cycle.id} AND payload->>'status' IN ('running', 'queued') RETURNING id
  `;
  if (!rows.length) throw new Error("Cycle is no longer outstanding.");
  return cycle;
}

/** Atomic create + ownership link BEFORE executePipeline: crash recovery never guesses ownership.
 * Frontier consumes exactly the current cursor without clearing/charging automatic sticky pauses.
 */
export async function createSearchCycleRun(
  cycleId: string, conceptId: string,
  input: { query: string; sources: string[]; limit: number },
  frontierCursor?: number,
): Promise<{ cycle: SearchCycle; run: PipelineRun }> {
  const { sql } = await import("./repository.js");
  const at = new Date().toISOString();
  const run = pipelineRunSchema.parse({ id: randomUUID(), ...input, reviewMode: "human_review",
    status: "queued", stage: "queued", message: "Waiting for manual cycle execution", warnings: [], error: null,
    artifactIds: { evidence: [], candidates: [], dossiers: [], problems: [], projects: [] }, createdAt: at, updatedAt: at });
  return sql.begin(async (tx) => {
    const rows = await tx<{ payload: unknown }[]>`SELECT payload FROM search_cycles WHERE id = ${cycleId} FOR UPDATE`;
    const current = searchCycleSchema.parse(rows[0]?.payload);
    const result = current.results.find((item) => item.conceptId === conceptId);
    if (current.status !== "running" || !result || result.runId) throw new Error("Cycle run ownership mismatch.");
    const cycle = projectCycle({ ...current, results: current.results.map((item) => item === result
      ? { ...item, runId: run.id, runStatus: run.status, status: "running", message: run.message } : item) }, at);
    await tx`INSERT INTO pipeline_runs (id, payload, created_at, updated_at)
      VALUES (${run.id}, ${sql.json(run)}, ${at}, ${at})`;
    if (frontierCursor !== undefined) {
      const updated = await tx<{ job: string }[]>`
        UPDATE worker_state SET state = jsonb_set(jsonb_set(state, '{briefIndex}', ${sql.json(frontierCursor + 1)}), '{updatedAt}', ${sql.json(at)}), last_activity_at = ${at}
        WHERE job = 'discovery' AND (state->>'briefIndex')::bigint = ${frontierCursor} RETURNING job
      `;
      if (!updated.length) throw new Error("Frontier cursor changed before its manual run was linked.");
    }
    await tx`UPDATE search_cycles SET payload = ${sql.json(cycle)}, updated_at = ${at} WHERE id = ${cycle.id}`;
    return { cycle, run };
  });
}