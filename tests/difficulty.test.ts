import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { assessDifficulties, persistDifficulty } from "../pipeline/assess-difficulty.js";
import { difficultySchema, projectSchema, type Project } from "../schemas/project.js";

const difficulty = { level: "easy" as const, rationale: "Basic tools and readily available materials; low-risk instructed assembly." };

function project(overrides: Partial<Project> = {}): Project {
  const milestoneId = randomUUID();
  const evidenceId = randomUUID();
  return projectSchema.parse({
    id: randomUUID(), canonicalProblemId: randomUUID(), title: "Test prototype",
    executiveSummary: "Build a prototype.", objective: "Validate a design.", rationale: "Documented need.",
    beneficiaries: ["Builders"], scope: { included: ["Prototype"], excluded: ["Deployment"] },
    blueprint: {
      overview: "Assemble a kit.", prerequisites: ["Read instructions"],
      components: [{ name: "Kit", purpose: "Demonstrate design", interfaces: ["Connectors"] }],
      buildSequence: ["Assemble"], validationPlan: ["Check operation"],
    },
    approach: ["Follow instructions"], deliverables: [{ title: "Prototype", description: "Kit", acceptanceCriteria: ["Operates"] }],
    unknowns: [], constraints: [], risks: [{ description: "Assembly error", mitigation: "Check instructions" }],
    successMetrics: ["Operates"], resourceNeeds: ["Basic tools"], evidenceIds: [evidenceId],
    milestones: [{ id: milestoneId, title: "Build", objective: "Assemble", successCriteria: ["Operates"] }],
    tasks: [{
      id: randomUUID(), title: "Assemble", description: "Build kit", discipline: "Assembly",
      instructions: ["Follow manual"], inputs: ["Kit"], outputs: ["Prototype"], completionCriteria: ["Operates"],
      dependencyTaskIds: [], milestoneId, evidenceIds: [evidenceId], status: "proposed",
    }],
    reviewMode: "human_review", decision: "pending", decidedBy: null, decidedAt: null,
    createdAt: "2026-09-09T00:00:00.000Z", ...overrides,
  });
}

function mockModel(t: TestContext, output: unknown, inspect?: (input: Project) => void): () => number {
  const originalKey = process.env.ANTHROPIC_API_KEY;
  const originalModel = process.env.CLAUDE_MODEL;
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.CLAUDE_MODEL = "test-model";
  t.after(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.CLAUDE_MODEL;
    else process.env.CLAUDE_MODEL = originalModel;
  });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    calls++;
    const body = JSON.parse(String(init.body));
    inspect?.(JSON.parse(body.messages[0].content).project);
    return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(output) }] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  return () => calls;
}

test("difficulty accepts only the three levels with a nonblank rationale; legacy defaults to null", () => {
  for (const level of ["easy", "medium", "hard"]) {
    assert.equal(difficultySchema.parse({ level, rationale: "Reason" }).level, level);
  }
  for (const invalid of [
    null, {}, { level: "expert", rationale: "Reason" }, { level: "Easy", rationale: "Reason" },
    { level: "easy", rationale: "" }, { level: "easy", rationale: "  " }, { level: "easy" },
  ]) assert.equal(difficultySchema.safeParse(invalid).success, false);
  assert.equal(project().difficulty, null);
  assert.equal(project({ difficulty: null }).difficulty, null);
  assert.deepEqual(project({ difficulty }).difficulty, difficulty);
  assert.equal(projectSchema.safeParse({ ...project(), difficulty: { level: "expert", rationale: "Reason" } }).success, false);
});

test("backfill classifies only non-archived null difficulty and reruns without model calls", async (t) => {
  const projects = [
    project(),
    project({ decision: "selected", decidedBy: "Curator", decidedAt: "2026-09-09T01:00:00.000Z",
      agentReview: { decision: "approved", rationale: "Ready", findings: [], reviewedAt: "2026-09-09T00:00:00.000Z" } }),
    project({ decision: "rejected" }),
    project({ status: "archived" }),
    project({ difficulty }),
  ];
  const original = structuredClone(projects);
  const calls = mockModel(t, difficulty, (context) => {
    assert.deepEqual(context, original.find((item) => item.id === context.id));
  });
  const persist = async (id: string, value: NonNullable<Project["difficulty"]>) => {
    const target = projects.find((item) => item.id === id)!;
    target.difficulty = value;
    return true;
  };
  assert.deepEqual(await assessDifficulties(projects, persist), { assessed: 3, skipped: 2 });
  assert.equal(calls(), 3);
  assert.deepEqual(projects, original.map((item, index) => index < 3 ? { ...item, difficulty } : item));
  assert.deepEqual(await assessDifficulties(projects, persist), { assessed: 0, skipped: 5 });
  assert.equal(calls(), 3);
});

test("invalid model difficulty is never persisted", async (t) => {
  mockModel(t, { level: "expert", rationale: "Wrong level" });
  let writes = 0;
  await assert.rejects(assessDifficulties([project()], async () => { writes++; return true; }));
  assert.equal(writes, 0);
});

test("concurrent changes that make a proposal ineligible are counted as skipped", async (t) => {
  mockModel(t, difficulty);
  assert.deepEqual(await assessDifficulties([project()], async () => false), { assessed: 0, skipped: 1 });
});

test("persistence patches only difficulty and atomically guards against archived or classified projects", async () => {
  const id = randomUUID();
  let statement = "";
  let parameters: string[] = [];
  const query = async (strings: TemplateStringsArray, ...values: string[]) => {
    statement = strings.join("?").replace(/\s+/g, " ").trim();
    parameters = values;
    return [{ id }];
  };
  assert.equal(await persistDifficulty(query, id, difficulty), true);
  assert.equal(statement, "UPDATE artifacts SET payload = jsonb_set( payload, '{difficulty}', jsonb_build_object('level', ?, 'rationale', ?), true ) WHERE id = ? AND kind = 'project' AND (payload->>'status') IS DISTINCT FROM 'archived' AND (payload->'difficulty' IS NULL OR payload->'difficulty' = 'null'::jsonb) RETURNING id");
  assert.deepEqual(parameters, [difficulty.level, difficulty.rationale, id]);
  assert.equal(await persistDifficulty(async () => [], id, difficulty), false);
});