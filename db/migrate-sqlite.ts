import "dotenv/config";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { closeDatabase, initializeDatabase, sql } from "./repository.js";

const sqlitePath = resolve(process.env.SQLITE_MIGRATION_PATH ?? "db/engineers.sqlite");
if (!existsSync(sqlitePath)) throw new Error(`SQLite database not found: ${sqlitePath}`);

const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });

try {
  await initializeDatabase();
  const artifacts = sqlite.prepare(`
    SELECT id, kind, payload, created_at, updated_at FROM artifacts
  `).all() as Array<{
    id: string;
    kind: string;
    payload: string;
    created_at: string;
    updated_at: string;
  }>;
  const runs = sqlite.prepare(`
    SELECT id, payload, created_at, updated_at FROM pipeline_runs
  `).all() as Array<{
    id: string;
    payload: string;
    created_at: string;
    updated_at: string;
  }>;

  for (const row of artifacts) {
    await sql`
      INSERT INTO artifacts (id, kind, payload, created_at, updated_at)
      VALUES (${row.id}, ${row.kind}, ${sql.json(JSON.parse(row.payload))}, ${row.created_at}, ${row.updated_at})
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `;
  }
  for (const row of runs) {
    await sql`
      INSERT INTO pipeline_runs (id, payload, created_at, updated_at)
      VALUES (${row.id}, ${sql.json(JSON.parse(row.payload))}, ${row.created_at}, ${row.updated_at})
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
    `;
  }
  console.log(`Migrated ${artifacts.length} artifacts and ${runs.length} pipeline runs to PostgreSQL.`);
} finally {
  sqlite.close();
  await closeDatabase();
}