import "dotenv/config";
import { parseArgs } from "node:util";
import { z } from "zod";
import { runCurator } from "../agents/curator.js";
import { runInvestigator } from "../agents/investigator.js";
import { runPlanner } from "../agents/planner.js";
import { runScout } from "../agents/scout.js";
import { closeDatabase, getArtifact, listArtifacts, saveArtifact, type ArtifactKind } from "../db/repository.js";
import {
  candidateProblemSchema,
  canonicalProblemSchema,
  evidenceSchema,
  problemDossierSchema,
  projectSchema,
} from "../schemas/index.js";
import { adapters, searchSources } from "../sources/index.js";

const schemas: Record<ArtifactKind, z.ZodType<unknown>> = {
  evidence: evidenceSchema,
  candidate: candidateProblemSchema,
  dossier: problemDossierSchema,
  problem: canonicalProblemSchema,
  project: projectSchema,
};

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    query: { type: "string", short: "q" },
    sources: { type: "string" },
    limit: { type: "string", default: "5" },
    candidate: { type: "string" },
    dossier: { type: "string" },
    problem: { type: "string" },
    kind: { type: "string" },
    decision: { type: "string" },
    reviewer: { type: "string" },
    mode: { type: "string", default: "human_review" },
  },
});

const command = positionals[0];

switch (command) {
  case "scout":
    await scout();
    break;
  case "investigate":
    await investigate();
    break;
  case "curate":
    await curate();
    break;
  case "approve":
    await approve();
    break;
  case "plan":
    await plan();
    break;
  case "list":
    await list();
    break;
  default:
    usage();
    process.exitCode = 1;
}

  await closeDatabase();

async function scout(): Promise<void> {
  const query = required(values.query, "--query");
  const sourceNames = parseSources(values.sources);
  const limit = parseLimit(values.limit);
  const result = await searchSources(sourceNames, query, limit);
  await Promise.all(result.evidence.map((item) => saveArtifact("evidence", item)));
  printWarnings(result.warnings);
  const candidates = await runScout(result.evidence);
  await Promise.all(candidates.map((item) => saveArtifact("candidate", item)));
  print(candidates);
}

async function investigate(): Promise<void> {
  const candidate = await getArtifact(required(values.candidate, "--candidate"), "candidate", candidateProblemSchema);
  const sourceNames = parseSources(values.sources);
  const result = await searchSources(sourceNames, candidate.problemHypothesis, parseLimit(values.limit));
  await Promise.all(result.evidence.map((item) => saveArtifact("evidence", item)));
  printWarnings(result.warnings);
  const allEvidence = await listArtifacts("evidence", evidenceSchema);
  const relevantIds = new Set([...candidate.evidenceIds, ...result.evidence.map((item) => item.id)]);
  const dossier = await runInvestigator(
    candidate,
    allEvidence.filter((item) => relevantIds.has(item.id)),
  );
  await saveArtifact("dossier", dossier);
  print(dossier);
}

async function curate(): Promise<void> {
  const dossier = await getArtifact(required(values.dossier, "--dossier"), "dossier", problemDossierSchema);
  const candidate = await getArtifact(dossier.candidateId, "candidate", candidateProblemSchema);
  const evidence = await listArtifacts("evidence", evidenceSchema);
  const existingProblems = await listArtifacts("problem", canonicalProblemSchema);
  const problem = await runCurator(candidate, dossier, evidence, existingProblems);
  await saveArtifact("problem", problem);
  print(problem);
}

async function approve(): Promise<void> {
  const id = required(values.problem, "--problem");
  const reviewer = required(values.reviewer, "--reviewer");
  const decision = values.decision ?? "approved";
  if (decision !== "approved" && decision !== "rejected") {
    throw new Error("--decision must be approved or rejected.");
  }
  const problem = await getArtifact(id, "problem", canonicalProblemSchema);
  const updated = canonicalProblemSchema.parse({
    ...problem,
    approval: decision,
    reviewedBy: reviewer,
    reviewedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await saveArtifact("problem", updated);
  print(updated);
}

async function plan(): Promise<void> {
  const problem = await getArtifact(required(values.problem, "--problem"), "problem", canonicalProblemSchema);
  const evidenceById = new Map((await listArtifacts("evidence", evidenceSchema)).map((item) => [item.id, item]));
  const evidence = problem.evidenceIds.flatMap((id) => {
    const item = evidenceById.get(id);
    return item ? [item] : [];
  });
  const mode = values.mode;
  if (mode !== "human_review" && mode !== "agent_direct") {
    throw new Error("--mode must be human_review or agent_direct.");
  }
  const projects = await runPlanner(problem, evidence, mode);
  await Promise.all(projects.map((item) => saveArtifact("project", item)));
  print(projects);
}

async function list(): Promise<void> {
  const kind = required(values.kind, "--kind") as ArtifactKind;
  const schema = schemas[kind];
  if (!schema) throw new Error(`--kind must be one of: ${Object.keys(schemas).join(", ")}`);
  print(await listArtifacts(kind, schema));
}

function parseSources(value: string | undefined): string[] {
  const names = (value ?? Object.keys(adapters).join(",")).split(",").map((item) => item.trim()).filter(Boolean);
  for (const name of names) {
    if (!adapters[name]) throw new Error(`Unknown source adapter: ${name}`);
  }
  return names;
}

function parseLimit(value: string | undefined): number {
  const limit = Number(value ?? "5");
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new Error("--limit must be an integer from 1 to 25.");
  }
  return limit;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function printWarnings(warnings: string[]): void {
  warnings.forEach((warning) => console.error(`Source warning: ${warning}`));
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function usage(): void {
  console.error(`Usage:
  npm run scout -- --query "..." [--sources arxiv,github,reddit,government] [--limit 5]
  npm run investigate -- --candidate <uuid> [--sources ...] [--limit 5]
  npm run curate -- --dossier <uuid>
  npm run approve -- --problem <uuid> --reviewer <name> [--decision approved|rejected]
  npm run plan -- --problem <uuid> [--mode human_review|agent_direct]
  npm run list -- --kind evidence|candidate|dossier|problem|project`);
}