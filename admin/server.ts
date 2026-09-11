import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { z } from "zod";
import { listPipelineRuns } from "../db/runs.js";
import { getArtifact, initializeDatabase, listArtifacts } from "../db/repository.js";
import { getWorkerStatus, initializeWorkerState } from "../db/worker-state.js";
import { enqueueSearchCycle, initializeSearchCycles, listSearchCycles } from "../db/search-cycles.js";
import { searchCycleProfileSchema } from "../schemas/search-cycle.js";
import { createSerialQueue } from "../lib/serial-queue.js";
import { isPublishedProject } from "../lib/publication.js";
import { reviewProject } from "../pipeline/orchestrate.js";
import {
  candidateProblemSchema,
  canonicalProblemSchema,
  evidenceSchema,
  problemDossierSchema,
  projectSchema,
} from "../schemas/index.js";

const port = Number(process.env.ADMIN_PORT ?? "4190");
const root = resolve(import.meta.dirname, "..");
const staticFiles: Record<string, string> = {
  "/": "index.html",
  "/admin": "admin.html",
  "/admin.html": "admin.html",
  "/admin.css": "admin.css",
  "/admin.js": "admin.js",
  "/admin-view.js": "admin-view.js",
  "/index.html": "index.html",
  "/projects.html": "projects.html",
  "/project.html": "project.html",
  "/projects.js": "projects.js",
  "/project.js": "project.js",
  "/project-ui.js": "project-ui.js",
  "/home.js": "home.js",
  "/public-theme.css": "public-theme.css",
  "/hardware-viewer.css": "hardware-viewer.css",
  "/assets/hardware-viewer.js": "assets/hardware-viewer.js",
  "/assets/hardware-viewer.js.LEGAL.txt": "assets/hardware-viewer.js.LEGAL.txt",
  "/mission.html": "mission.html",
  "/styles.css": "styles.css",
};

const reviewRequestSchema = z.object({
  decision: z.enum(["selected", "rejected"]),
  reviewer: z.string().trim().min(1).max(100),
});

const runRequestSchema = z.object({
  profile: searchCycleProfileSchema.default("frontier_scan"),
});

// Concurrent reads reproduce stalled pooler connections here; the same reads
// finish promptly in sequence. Keep API work sequential, separate from the worker.
const databaseRequest = createSerialQueue();

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "POST" && request.headers.origin
      && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(request.headers.origin)) {
      sendJson(response, 403, { error: "Operations actions must originate from this local site." });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      sendJson(response, 200, await databaseRequest(getAdminState));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/public/projects") {
      const { projects, problems, evidence } = await databaseRequest(async () => ({
        projects: await listArtifacts("project", projectSchema),
        problems: await listArtifacts("problem", canonicalProblemSchema),
        evidence: await listArtifacts("evidence", evidenceSchema),
      }));
      const problemById = new Map(problems.map((problem) => [problem.id, problem]));
      const evidenceById = new Map(evidence.map((item) => [item.id, item]));
      const published = projects.filter(isPublishedProject);
      sendJson(response, 200, {
        projects: published.map((project) => ({
          ...project,
          categories: problemById.get(project.canonicalProblemId)?.categories ?? [],
          evidence: project.evidenceIds.flatMap((id) => {
            const item = evidenceById.get(id);
            return item ? [{ id: item.id, title: item.title, url: item.url, publisher: item.publisher }] : [];
          }),
        })),
      });
      return;
    }
    const previewMatch = request.method === "GET" ? url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/preview$/i) : null;
    if (previewMatch?.[1]) {
      const id = z.string().uuid().parse(previewMatch[1]);
      const project = await databaseRequest(async () => {
        const plan = await getArtifact(id, "project", projectSchema);
        const problem = await getArtifact(plan.canonicalProblemId, "problem", canonicalProblemSchema);
        const evidence = await listArtifacts("evidence", evidenceSchema);
        const cited = new Set([...plan.evidenceIds, ...plan.tasks.flatMap((task) => task.evidenceIds)]);
        return { ...plan, categories: problem.categories, evidence: evidence.filter((item) => cited.has(item.id))
          .map(({ id, title, url, publisher }) => ({ id, title, url, publisher })) };
      });
      sendJson(response, 200, { project });
      return;
    }
    const reviewMatch = request.method === "POST"
      ? url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/review$/i)
      : null;
    if (reviewMatch?.[1]) {
      const input = reviewRequestSchema.parse(await readJson(request));
      const projectId = reviewMatch[1];
      sendJson(response, 200, await databaseRequest(() => reviewProject(projectId, input.decision, input.reviewer)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/runs") {
      const input = runRequestSchema.parse(await readJson(request));
      const queued = await databaseRequest(() => enqueueSearchCycle(input.profile));
      sendJson(response, 202, queued);
      return;
    }
    const staticFile = staticFiles[url.pathname];
    if (request.method === "GET" && staticFile) {
      await sendFile(response, staticFile);
      return;
    }
    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(response, error instanceof z.ZodError ? 400 : 500, { error: message });
  }
});

await initializeDatabase();
await initializeWorkerState();
await initializeSearchCycles();
server.listen(port, "127.0.0.1", () => {
  console.log(`Engineers admin: http://127.0.0.1:${port}/admin`);
});

async function getAdminState() {
  const evidence = await listArtifacts("evidence", evidenceSchema);
  const candidates = await listArtifacts("candidate", candidateProblemSchema);
  const dossiers = await listArtifacts("dossier", problemDossierSchema);
  const problems = await listArtifacts("problem", canonicalProblemSchema);
  const projects = await listArtifacts("project", projectSchema);
  const runs = await listPipelineRuns();
  const worker = await getWorkerStatus();
  const cycles = await listSearchCycles();
  return {
    generatedAt: new Date().toISOString(),
    worker,
    cycles,
    counts: {
      evidence: evidence.length,
      candidates: candidates.length,
      dossiers: dossiers.length,
      problems: problems.length,
      projects: projects.length,
    },
    runs,
    evidence,
    candidates,
    dossiers,
    problems,
    projects,
  };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function sendFile(response: ServerResponse, relativePath: string): Promise<void> {
  const content = await readFile(resolve(root, relativePath));
  const contentTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
  };
  response.writeHead(200, {
    "content-type": contentTypes[extname(relativePath)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  response.end(content);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}