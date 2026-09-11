import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { z } from "zod";
import { runApprover } from "../agents/approver.js";
import { runPlanner } from "../agents/planner.js";
import { generateStructured } from "../lib/model.js";
import { createEvidence } from "../schemas/evidence.js";
import { canonicalProblemSchema } from "../schemas/problem.js";
import { projectSchema } from "../schemas/project.js";

test("Claude gateway sends a Messages API request and validates JSON", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.ANTHROPIC_API_KEY;
  const originalModel = process.env.CLAUDE_MODEL;
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.CLAUDE_MODEL = "test-claude-model";

  globalThis.fetch = async (input, init) => {
    assert.equal(input, "https://api.anthropic.com/v1/messages");
    assert.equal(new Headers(init?.headers).get("x-api-key"), "test-key");
    assert.equal(new Headers(init?.headers).get("anthropic-version"), "2023-06-01");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.model, "test-claude-model");
    assert.equal(body.system, "Return JSON.");
    assert.deepEqual(body.messages, [{ role: "user", content: "{\"input\":true}" }]);
    return new Response(JSON.stringify({
      content: [{ type: "text", text: "Here is the result:\n```json\n{\"accepted\":true}\n```" }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const result = await generateStructured(
      "Return JSON.",
      { input: true },
      z.object({ accepted: z.boolean() }),
    );
    assert.deepEqual(result, { accepted: true });
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment("ANTHROPIC_API_KEY", originalKey);
    restoreEnvironment("CLAUDE_MODEL", originalModel);
  }
});

test("Planner preserves the complete proposal for human review", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.ANTHROPIC_API_KEY;
  const originalModel = process.env.CLAUDE_MODEL;
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.CLAUDE_MODEL = "test-claude-model";
  const evidence = createEvidence({
    url: "https://example.com/report",
    title: "Field report",
    publisher: "Example Lab",
    sourceType: "field_report",
    observedAt: "2026-09-09T00:00:00.000Z",
    excerpt: "A documented need.",
    adapter: "test",
    query: "documented need",
  });
  const problem = canonicalProblemSchema.parse({
    id: randomUUID(),
    title: "Documented problem",
    statement: "A supported problem statement.",
    sourceCandidateIds: [randomUUID()],
    dossierIds: [randomUUID()],
    evidenceIds: [evidence.id],
    categories: ["infrastructure"],
    relatedProblemIds: [],
    measurements: {
      independentSourceCount: 1,
      sourceTypeCount: 1,
      mentionCount: 1,
      newestEvidenceAt: evidence.observedAt,
      existingSolutionCount: 0,
      failedAttemptCount: 0,
      affectedPopulationEstimate: null,
      affectedPopulationEvidenceIds: [],
    },
    missionAlignment: {
      status: "aligned",
      frontierCapability: "yes",
      broadlyReusable: "yes",
      engineeringCore: "yes",
      feasibleGuildContribution: "yes",
      primarilyRoutineDelivery: "no",
      frontierDomains: ["frontier infrastructure"],
      exclusionReasons: [],
      rationale: "Creates reusable engineering capability.",
    },
    approval: "pending",
    reviewedBy: null,
    reviewedAt: null,
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
  });
  const proposal = {
    title: "Complete proposal",
    executiveSummary: "A decision-ready summary.",
    objective: "Resolve the documented problem.",
    rationale: "The evidence supports intervention.",
    difficulty: { level: "medium", rationale: "Requires practical prototype integration and field testing." },
    beneficiaries: ["Operators"],
    scope: { included: ["Prototype"], excluded: ["Production rollout"] },
    blueprint: {
      overview: "Build and validate a focused prototype.",
      prerequisites: ["Validated requirements"],
      components: [{ name: "Prototype", purpose: "Test the approach", interfaces: ["Field inputs"] }],
      buildSequence: ["Confirm inputs", "Implement", "Validate"],
      validationPlan: ["Run acceptance tests"],
    },
    approach: ["Validate requirements", "Build prototype"],
    deliverables: [{
      title: "Prototype",
      description: "A testable implementation.",
      acceptanceCriteria: ["Passes field validation"],
    }],
    unknowns: ["Deployment conditions"],
    constraints: ["Existing infrastructure"],
    risks: [{ description: "Poor source data", mitigation: "Validate inputs" }],
    successMetrics: ["Validation target met"],
    resourceNeeds: ["Domain engineer"],
    evidenceIds: [evidence.id],
    milestones: [{
      title: "Prototype complete",
      objective: "Produce a testable prototype.",
      successCriteria: ["Prototype runs"],
    }],
    tasks: [{
      title: "Build prototype",
      description: "Implement the initial system.",
      discipline: "Software engineering",
      instructions: ["Review requirements", "Implement the prototype"],
      inputs: ["Validated requirements"],
      outputs: ["Working prototype"],
      completionCriteria: ["Acceptance tests pass"],
      dependencyTaskIndexes: [],
      milestoneIndex: 0,
      evidenceIds: [evidence.id],
    }],
  };
  const { milestones, tasks, ...projectCore } = proposal;
  const responses = [
    { project: projectCore },
    { milestones },
    { tasks },
  ];
  let responseIndex = 0;
  globalThis.fetch = async () => new Response(JSON.stringify({
    content: [{ type: "text", text: JSON.stringify(responses[responseIndex++]) }],
  }), { status: 200, headers: { "content-type": "application/json" } });

  try {
    const [project] = await runPlanner(problem, [evidence]);
    assert.ok(project);
    assert.equal(project.executiveSummary, proposal.executiveSummary);
    assert.equal(project.rationale, proposal.rationale);
    assert.deepEqual(project.difficulty, proposal.difficulty);
    const { difficulty: _difficulty, ...legacyProject } = project;
    assert.equal(projectSchema.parse(legacyProject).difficulty, null);
    assert.equal(projectSchema.parse({ ...project, difficulty: null }).difficulty, null);
    assert.deepEqual(project.scope, proposal.scope);
    assert.deepEqual(project.blueprint, proposal.blueprint);
    assert.deepEqual(project.deliverables, proposal.deliverables);
    assert.deepEqual(project.risks, proposal.risks);
    assert.deepEqual(project.successMetrics, proposal.successMetrics);
    assert.deepEqual(project.resourceNeeds, proposal.resourceNeeds);
    assert.deepEqual(project.tasks[0]?.instructions, proposal.tasks[0]?.instructions);
    assert.deepEqual(project.tasks[0]?.dependencyTaskIds, []);
    assert.equal(project.agentReview.decision, "pending");
    assert.equal(project.decision, "pending");
    // Legacy storage may be null, but newly generated Planner output must not be.
    for (const invalid of [undefined, null, { level: "expert", rationale: "Invalid" }]) {
      globalThis.fetch = async () => new Response(JSON.stringify({
        content: [{ type: "text", text: JSON.stringify({ project: { ...projectCore, difficulty: invalid } }) }],
      }), { status: 200, headers: { "content-type": "application/json" } });
      await assert.rejects(runPlanner(problem, [evidence]));
    }
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment("ANTHROPIC_API_KEY", originalKey);
    restoreEnvironment("CLAUDE_MODEL", originalModel);
  }
});

test("Approver independently records whether a draft is ready for curation", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.ANTHROPIC_API_KEY;
  const originalModel = process.env.CLAUDE_MODEL;
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.CLAUDE_MODEL = "test-claude-model";
  globalThis.fetch = async () => new Response(JSON.stringify({
    content: [{ type: "text", text: JSON.stringify({
      decision: "approved",
      rationale: "The proposal is evidence-grounded and buildable.",
      findings: ["Tasks include testable completion criteria."],
    }) }],
  }), { status: 200, headers: { "content-type": "application/json" } });

  const evidence = createEvidence({
    url: "https://example.com/evidence",
    title: "Evidence",
    publisher: "Lab",
    sourceType: "academic_paper",
    observedAt: "2026-09-09T00:00:00.000Z",
    excerpt: "Documented need.",
    adapter: "test",
    query: "need",
  });
  const problem = canonicalProblemSchema.parse({
    id: randomUUID(), title: "Problem", statement: "Statement", sourceCandidateIds: [randomUUID()],
    dossierIds: [randomUUID()], evidenceIds: [evidence.id], categories: ["robotics"], relatedProblemIds: [],
    measurements: { independentSourceCount: 1, sourceTypeCount: 1, mentionCount: 1, newestEvidenceAt: evidence.observedAt, existingSolutionCount: 0, failedAttemptCount: 0, affectedPopulationEstimate: null, affectedPopulationEvidenceIds: [] },
    missionAlignment: { status: "aligned", frontierCapability: "yes", broadlyReusable: "yes", engineeringCore: "yes", feasibleGuildContribution: "yes", primarilyRoutineDelivery: "no", frontierDomains: ["robotics"], exclusionReasons: [], rationale: "Aligned." },
    approval: "pending", reviewedBy: null, reviewedAt: null, createdAt: evidence.observedAt, updatedAt: evidence.observedAt,
  });
  const milestoneId = randomUUID();
  const project = projectSchema.parse({
    id: randomUUID(), canonicalProblemId: problem.id, title: "Robot", executiveSummary: "Build it.", objective: "Build a robot.", rationale: "Needed.", beneficiaries: ["Researchers"],
    difficulty: { level: "hard", rationale: "Requires advanced robotics engineering and specialized equipment." },
    scope: { included: ["Prototype"], excluded: ["Production"] }, blueprint: { overview: "Prototype.", prerequisites: [], components: [{ name: "Robot", purpose: "Inspect", interfaces: [] }], buildSequence: ["Build"], validationPlan: ["Test"] },
    approach: ["Build"], deliverables: [{ title: "Prototype", description: "Robot", acceptanceCriteria: ["Works"] }], unknowns: [], constraints: [], risks: [{ description: "Failure", mitigation: "Test" }], successMetrics: ["Passes"], resourceNeeds: ["Engineer"], evidenceIds: [evidence.id],
    milestones: [{ id: milestoneId, title: "Prototype", objective: "Build", successCriteria: ["Works"] }],
    tasks: [{ id: randomUUID(), title: "Build", description: "Build", discipline: "Robotics", instructions: ["Build"], inputs: [], outputs: ["Robot"], completionCriteria: ["Works"], dependencyTaskIds: [], milestoneId, evidenceIds: [evidence.id], status: "proposed" }],
    reviewMode: "human_review", decision: "pending", decidedBy: null, decidedAt: null, status: "draft", createdAt: evidence.observedAt,
  });

  try {
    const approved = await runApprover(project, problem, [evidence]);
    assert.equal(approved.agentReview.decision, "approved");
    assert.equal(approved.decision, "pending");
    assert.equal(approved.status, "draft");
    assert.deepEqual(approved.difficulty, project.difficulty);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment("ANTHROPIC_API_KEY", originalKey);
    restoreEnvironment("CLAUDE_MODEL", originalModel);
  }
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}