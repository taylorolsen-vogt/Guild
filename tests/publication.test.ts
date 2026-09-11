import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { applyPublicationDecision, isPublishedProject } from "../lib/publication.js";
import { projectSchema, type Project } from "../schemas/project.js";

const createdAt = "2026-09-10T12:00:00.000Z";
const reviewedAt = "2026-09-11T09:00:00.000Z";
const decidedAt = "2026-09-11T12:00:00.000Z";
const laterAt = "2026-09-11T13:00:00.000Z";

// In-memory, schema-valid fixture only: no repository, server, or model imports.
function project(overrides: Partial<Project> = {}): Project {
  const evidenceId = randomUUID();
  const milestoneId = randomUUID();
  return projectSchema.parse({
    id: randomUUID(), canonicalProblemId: randomUUID(), title: "Prototype", executiveSummary: "Build and validate.",
    objective: "Test the documented gap.", rationale: "Grounded in field evidence.",
    beneficiaries: ["Operators"], scope: { included: ["Prototype"], excluded: ["Deployment"] },
    difficulty: { level: "medium", rationale: "Integration and field testing." },
    blueprint: { overview: "Build a prototype.", prerequisites: ["Bench equipment"],
      components: [{ name: "Sensor", purpose: "Measure", interfaces: ["Data"] }],
      buildSequence: ["Assemble"], validationPlan: ["Measure accuracy"] },
    approach: ["Test"], deliverables: [{ title: "Prototype", description: "Working prototype", acceptanceCriteria: ["Pass tests"] }],
    unknowns: [], constraints: [], risks: [{ description: "Noise", mitigation: "Calibrate" }],
    successMetrics: ["Pass tests"], resourceNeeds: ["Engineer"], evidenceIds: [evidenceId],
    milestones: [{ id: milestoneId, title: "Prototype", objective: "Build", successCriteria: ["Pass"] }],
    tasks: [{ id: randomUUID(), title: "Assemble", description: "Assemble prototype", discipline: "Engineering",
      instructions: ["Assemble"], inputs: ["Sensor"], outputs: ["Prototype"], completionCriteria: ["Pass"],
      dependencyTaskIds: [], milestoneId, evidenceIds: [evidenceId], status: "proposed" }],
    agentReview: { decision: "approved", rationale: "Ready for human curation.", findings: ["Validation is specified."], reviewedAt },
    reviewMode: "human_review", decision: "pending", decidedBy: null, decidedAt: null, createdAt,
    ...overrides,
  });
}

test("agent-approved proposals awaiting human selection are not public", () => {
  assert.equal(isPublishedProject(project()), false);
});

test("agent-approved, selected projects are public even while status is draft", () => {
  const value = project({ decision: "selected", decidedBy: "Alex Rivera", decidedAt });
  assert.equal(value.status, "draft");
  assert.equal(isPublishedProject(value), true);
});

const exclusions: Array<{ name: string; overrides: Partial<Project>; error: RegExp }> = [
  { name: "pending agent review", overrides: { agentReview: {
    decision: "pending", rationale: null, findings: [], reviewedAt: null,
  } }, error: /Only agent-approved plans/ },
  { name: "rejected agent review", overrides: { agentReview: {
    decision: "rejected", rationale: "Validation incomplete.", findings: ["Missing validation."], reviewedAt,
  } }, error: /Only agent-approved plans/ },
  { name: "archived status", overrides: { status: "archived" }, error: /Archived or completed plans/ },
  { name: "completed lifecycle", overrides: { lifecycleStatus: "completed" }, error: /Archived or completed plans/ },
];

for (const { name, overrides, error } of exclusions) {
  test(`selected projects with ${name} are excluded from publication`, () => {
    const value = project({ decision: "selected", decidedBy: "Alex Rivera", decidedAt, ...overrides });
    assert.equal(isPublishedProject(value), false);
  });

  test(`selection rejects ${name}, including an already-selected decision`, () => {
    for (const decision of ["pending", "selected"] as const) {
      const value = project({ ...overrides, decision });
      const original = structuredClone(value);
      assert.throws(() => applyPublicationDecision(value, "selected", "Alex Rivera", decidedAt), error);
      assert.deepEqual(value, original);
    }
  });
}

for (const reviewer of ["", " \t\n "]) {
  test(`selection rejects ${reviewer ? "whitespace-only" : "empty"} curator names`, () => {
    const value = project();
    const original = structuredClone(value);
    assert.throws(() => applyPublicationDecision(value, "selected", reviewer, decidedAt), /A curator name is required/);
    assert.deepEqual(value, original);
  });
}

test("selection preserves the complete plan and agent review while recording the supplied curator and timestamp", () => {
  const value = project();
  const original = structuredClone(value);
  const selected = applyPublicationDecision(value, "selected", "  Alex Rivera  ", decidedAt);

  assert.notStrictEqual(selected, value);
  assert.equal(isPublishedProject(selected), true);
  assert.equal(selected.decidedBy, "Alex Rivera");
  assert.equal(selected.decidedAt, decidedAt);
  assert.deepEqual(selected.tasks, original.tasks);
  assert.deepEqual(selected.blueprint, original.blueprint);
  assert.deepEqual(selected.agentReview, original.agentReview);
  assert.deepEqual(selected, { ...original, decision: "selected", decidedBy: "Alex Rivera", decidedAt });
  assert.deepEqual(value, original);
});

test("rejecting a published project unpublishes it without changing the plan or agent approval", () => {
  const value = project({ decision: "selected", decidedBy: "Alex Rivera", decidedAt });
  const original = structuredClone(value);
  assert.equal(isPublishedProject(value), true);

  const rejected = applyPublicationDecision(value, "rejected", "  Morgan Chen  ", laterAt);
  assert.equal(isPublishedProject(rejected), false);
  assert.deepEqual(rejected, { ...original, decision: "rejected", decidedBy: "Morgan Chen", decidedAt: laterAt });
  assert.deepEqual(value, original);
});

for (const decision of ["selected", "rejected"] as const) {
  test(`repeating ${decision} is idempotent and preserves the original curator and timestamp`, () => {
    const first = applyPublicationDecision(project(), decision, "Alex Rivera", decidedAt);
    const original = structuredClone(first);
    const repeated = applyPublicationDecision(first, decision, "Morgan Chen", laterAt);

    assert.strictEqual(repeated, first);
    assert.equal(repeated.decidedBy, "Alex Rivera");
    assert.equal(repeated.decidedAt, decidedAt);
    assert.equal(isPublishedProject(repeated), decision === "selected");
    assert.deepEqual(repeated, original);
  });
}