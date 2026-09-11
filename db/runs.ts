import { randomUUID } from "node:crypto";
import { initializeDatabase, sql } from "./repository.js";
import { pipelineRunSchema, type PipelineRun, type ReviewMode } from "../schemas/run.js";

export async function createPipelineRun(input: {
  query: string;
  sources: string[];
  limit: number;
  reviewMode: ReviewMode;
}): Promise<PipelineRun> {
  const now = new Date().toISOString();
  const run = pipelineRunSchema.parse({
    id: randomUUID(),
    ...input,
    status: "queued",
    stage: "queued",
    message: "Waiting to start",
    warnings: [],
    artifactIds: { evidence: [], candidates: [], dossiers: [], problems: [], projects: [] },
    error: null,
    createdAt: now,
    updatedAt: now,
  });
  await savePipelineRun(run);
  return run;
}

export async function updatePipelineRun(
  id: string,
  changes: Partial<Omit<PipelineRun, "id" | "createdAt">>,
): Promise<PipelineRun> {
  const current = await getPipelineRun(id);
  const updated = pipelineRunSchema.parse({
    ...current,
    ...changes,
    updatedAt: new Date().toISOString(),
  });
  await savePipelineRun(updated);
  return updated;
}

export async function getPipelineRun(id: string): Promise<PipelineRun> {
  await initializeDatabase();
  const rows = await sql<{ payload: unknown }[]>`
    SELECT payload FROM pipeline_runs WHERE id = ${id}
  `;
  const row = rows[0];
  if (!row) throw new Error(`Pipeline run ${id} was not found.`);
  return pipelineRunSchema.parse(row.payload);
}

export async function listPipelineRuns(): Promise<PipelineRun[]> {
  await initializeDatabase();
  const rows = await sql<{ payload: unknown }[]>`
    SELECT payload FROM pipeline_runs ORDER BY created_at DESC
  `;
  return rows.map((row) => pipelineRunSchema.parse(row.payload));
}

export async function recoverInterruptedRuns(): Promise<number> {
  const runs = await listPipelineRuns();
  const interrupted = runs.filter((run) => run.status === "queued" || run.status === "running");
  await Promise.all(interrupted.map((run) => updatePipelineRun(run.id, {
    status: "failed",
    stage: "failed",
    message: "Pipeline was interrupted by a worker restart",
    error: "The worker stopped before this run completed. Start a new run to retry.",
  })));
  return interrupted.length;
}

async function savePipelineRun(run: PipelineRun): Promise<void> {
  await initializeDatabase();
  await sql`
    INSERT INTO pipeline_runs (id, payload, created_at, updated_at)
    VALUES (${run.id}, ${sql.json(run)}, ${run.createdAt}, ${run.updatedAt})
    ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `;
}