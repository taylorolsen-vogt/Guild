import postgres from "postgres";
import { z } from "zod";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("Set DATABASE_URL before using the database.");

export const sql = postgres(databaseUrl, {
  max: 5,
  prepare: false,
  ssl: "require",
  onnotice: () => {},
});

let initialization: Promise<void> | undefined;

export type ArtifactKind = "evidence" | "candidate" | "dossier" | "problem" | "project";

export async function initializeDatabase(): Promise<void> {
  initialization ??= (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS artifacts (
        id UUID PRIMARY KEY,
        kind TEXT NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS artifacts_kind_idx ON artifacts(kind)`;
    await sql`
      CREATE TABLE IF NOT EXISTS pipeline_runs (
        id UUID PRIMARY KEY,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `;
    await sql`ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY`;
    await sql`ALTER TABLE pipeline_runs ENABLE ROW LEVEL SECURITY`;
  })();
  await initialization;
}

export async function closeDatabase(): Promise<void> {
  await sql.end();
}

export async function saveArtifact(kind: ArtifactKind, artifact: { id: string }): Promise<void> {
  await initializeDatabase();
  const now = new Date().toISOString();
  await sql`
    INSERT INTO artifacts (id, kind, payload, created_at, updated_at)
    VALUES (${artifact.id}, ${kind}, ${sql.json(artifact)}, ${now}, ${now})
    ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `;
}

export async function getArtifact<T>(id: string, kind: ArtifactKind, schema: z.ZodType<T>): Promise<T> {
  await initializeDatabase();
  const rows = await sql<{ payload: unknown }[]>`
    SELECT payload FROM artifacts WHERE id = ${id} AND kind = ${kind}
  `;
  const row = rows[0];
  if (!row) throw new Error(`${kind} ${id} was not found.`);
  return schema.parse(row.payload);
}

export async function listArtifacts<T>(kind: ArtifactKind, schema: z.ZodType<T>): Promise<T[]> {
  await initializeDatabase();
  const rows = await sql<{ payload: unknown }[]>`
    SELECT payload FROM artifacts WHERE kind = ${kind} ORDER BY created_at DESC
  `;
  return rows.map((row) => schema.parse(row.payload));
}