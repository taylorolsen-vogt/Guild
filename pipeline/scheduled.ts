import "dotenv/config";
import { parseArgs } from "node:util";
import { revalidateProject } from "../agents/verifier.js";
import { createPipelineRun, getPipelineRun } from "../db/runs.js";
import { closeDatabase, listArtifacts, saveArtifact } from "../db/repository.js";
import { projectSchema } from "../schemas/index.js";
import { adapters, searchSources } from "../sources/index.js";
import { dailyDiscoveryBrief } from "./discovery-briefs.js";
import { executePipeline } from "./orchestrate.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    query: { type: "string", short: "q" },
    sources: { type: "string" },
    limit: { type: "string" },
    mode: { type: "string" },
  },
});

switch (positionals[0]) {
  case "discover":
    await discover();
    break;
  case "revalidate":
    await revalidate();
    break;
  default:
    throw new Error("Use scheduled.ts discover --query <query> or scheduled.ts revalidate.");
}

  await closeDatabase();

async function discover(): Promise<void> {
  const query = values.query?.trim() || process.env.DISCOVERY_QUERY?.trim() || dailyDiscoveryBrief();
  const sources = parseSources(values.sources ?? process.env.DISCOVERY_SOURCES);
  const limit = parseLimit(values.limit ?? process.env.DISCOVERY_LIMIT);
  const reviewMode = values.mode ?? process.env.DISCOVERY_REVIEW_MODE ?? "human_review";
  if (reviewMode !== "human_review" && reviewMode !== "agent_direct") {
    throw new Error("--mode must be human_review or agent_direct.");
  }
  const run = await createPipelineRun({ query, sources, limit, reviewMode });
  await executePipeline(run.id);
  const completed = await getPipelineRun(run.id);
  console.log(JSON.stringify(completed, null, 2));
  if (completed.status === "failed") process.exitCode = 1;
}

async function revalidate(): Promise<void> {
  const sources = parseSources(values.sources ?? "news,github,government,reddit");
  const limit = parseLimit(values.limit);
  const projects = (await listArtifacts("project", projectSchema))
    .filter((project) => project.decision === "selected" && project.lifecycleStatus !== "completed");

  for (const project of projects) {
    const query = `"${project.title}" ${project.objective} completed deployed solved`;
    const search = await searchSources(sources, query, limit);
    await Promise.all(search.evidence.map((item) => saveArtifact("evidence", item)));
    if (search.evidence.length === 0) {
      console.error(`Skipped ${project.id}: no fresh evidence. ${search.warnings.join("; ")}`);
      continue;
    }
    const verification = await revalidateProject(project, search.evidence);
    const updated = projectSchema.parse({
      ...project,
      lifecycleStatus: verification.status === "inconclusive" ? project.lifecycleStatus : verification.status,
      verificationHistory: [...project.verificationHistory, verification],
      status: verification.status === "completed" ? "archived" : project.status,
    });
    await saveArtifact("project", updated);
    console.log(`${updated.title}: ${verification.status}`);
  }
}

function parseSources(value: string | undefined): string[] {
  const sources = (value ?? "arxiv,github,government,news").split(",").map((item) => item.trim()).filter(Boolean);
  for (const source of sources) if (!adapters[source]) throw new Error(`Unknown source adapter: ${source}`);
  return sources;
}

function parseLimit(value: string | undefined): number {
  const limit = Number(value ?? "5");
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error("--limit must be from 1 to 25.");
  return limit;
}