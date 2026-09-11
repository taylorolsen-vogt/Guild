import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { executePipeline, type PipelineDependencies } from "../pipeline/orchestrate.js";
import { activeApprovedProjectIds } from "../pipeline/worker-schedule.js";
import {
  canonicalProblemSchema, createEvidence, pipelineRunSchema, projectSchema,
  type CandidateProblem, type Project,
} from "../schemas/index.js";
import type { ArtifactKind } from "../db/repository.js";

const at = "2026-09-10T12:00:00.000Z";
const evidence = createEvidence({
  url: "https://example.com/observed-engineering-gap", title: "Observed engineering gap",
  publisher: "Test lab", sourceType: "field_report", observedAt: at,
  excerpt: "A real input fixture, not model-invented provenance.", adapter: "test", query: "microgrids",
});

function problem(candidateId: string) {
  return canonicalProblemSchema.parse({
    id: randomUUID(), title: "Supported engineering gap", statement: "Build and test a reusable capability.",
    sourceCandidateIds: [candidateId], dossierIds: [randomUUID()], evidenceIds: [evidence.id],
    categories: [], relatedProblemIds: [],
    measurements: { independentSourceCount: 1, sourceTypeCount: 1, mentionCount: 1,
      newestEvidenceAt: at, existingSolutionCount: 0, failedAttemptCount: 0,
      affectedPopulationEstimate: null, affectedPopulationEvidenceIds: [] },
    missionAlignment: { status: "aligned", frontierCapability: "yes", broadlyReusable: "yes",
      engineeringCore: "yes", feasibleGuildContribution: "yes", primarilyRoutineDelivery: "no",
      frontierDomains: ["energy"], exclusionReasons: [], rationale: "Testable reusable engineering." },
    approval: "pending", reviewedBy: null, reviewedAt: null, createdAt: at, updatedAt: at,
  });
}

function project(overrides: Partial<Project> = {}): Project {
  const milestoneId = randomUUID();
  return projectSchema.parse({
    id: randomUUID(), canonicalProblemId: randomUUID(), title: "Prototype", executiveSummary: "Build and validate.",
    objective: "Test the documented gap.", rationale: "Grounded in field evidence.",
    beneficiaries: ["Operators"], scope: { included: ["Prototype"], excluded: ["Deployment"] },
    difficulty: { level: "medium", rationale: "Integration and field testing." },
    blueprint: { overview: "Build a prototype.", prerequisites: [],
      components: [{ name: "Sensor", purpose: "Measure", interfaces: ["Data"] }],
      buildSequence: ["Assemble"], validationPlan: ["Measure accuracy"] },
    approach: ["Test"], deliverables: [{ title: "Prototype", description: "Working prototype", acceptanceCriteria: ["Pass tests"] }],
    unknowns: [], constraints: [], risks: [{ description: "Noise", mitigation: "Calibrate" }],
    successMetrics: ["Pass tests"], resourceNeeds: ["Engineer"], evidenceIds: [evidence.id],
    milestones: [{ id: milestoneId, title: "Prototype", objective: "Build", successCriteria: ["Pass"] }],
    tasks: [{ id: randomUUID(), title: "Assemble", description: "Assemble prototype", discipline: "Engineering",
      instructions: ["Assemble"], inputs: [], outputs: ["Prototype"], completionCriteria: ["Pass"],
      dependencyTaskIds: [], milestoneId, evidenceIds: [evidence.id], status: "proposed" }],
    reviewMode: "human_review", decision: "pending", decidedBy: null, decidedAt: null, createdAt: at,
    ...overrides,
  });
}

function harness(candidateCount = 3, draftCount = 1) {
  let run = pipelineRunSchema.parse({
    id: randomUUID(), query: "microgrids", sources: ["github"], limit: 5, reviewMode: "human_review",
    status: "queued", stage: "queued", message: "Waiting", warnings: [], error: null,
    artifactIds: { evidence: [], candidates: [], dossiers: [], problems: [], projects: [] }, createdAt: at, updatedAt: at,
  });
  const store = new Map<ArtifactKind, Map<string, { id: string }>>();
  const events: string[] = [];
  const candidates: CandidateProblem[] = Array.from({ length: candidateCount }, () => ({
    id: randomUUID(), claim: "Documented gap", problemHypothesis: "A long documented engineering hypothesis",
    evidenceIds: [evidence.id], observedAt: at, status: "candidate",
  }));
  const save: PipelineDependencies["saveArtifact"] = async (kind, item) => {
    const values = store.get(kind) ?? new Map();
    values.set(item.id, structuredClone(item));
    store.set(kind, values);
  };
  const dependencies: PipelineDependencies = {
    getPipelineRun: async () => structuredClone(run),
    updatePipelineRun: async (_id, changes) => {
      run = pipelineRunSchema.parse({ ...run, ...changes });
      return structuredClone(run);
    },
    listArtifacts: async (kind, schema) => [...(store.get(kind)?.values() ?? [])].map((value) => schema.parse(value)),
    saveArtifact: save,
    searchSources: async (_names, query) => { events.push(`search:${query}`); return { evidence: [evidence], warnings: [] }; },
    runScout: async () => { events.push("scout"); return candidates; },
    runInvestigator: async (candidate) => {
      events.push(`investigate:${candidate.id}`);
      return { id: randomUUID(), candidateId: candidate.id, verdict: "supported", verdictReason: "Supported",
        evidenceIds: [evidence.id], existingSolutions: [], priorAttempts: [], contradictions: [], openQuestions: [], createdAt: at };
    },
    runCurator: async (candidate) => { events.push(`curate:${candidate.id}`); return problem(candidate.id); },
    runPlanner: async (canonical, suppliedEvidence, reviewMode) => {
      events.push(`plan:${canonical.id}`);
      assert.equal(reviewMode, run.reviewMode);
      assert.deepEqual(suppliedEvidence.map((item) => item.id), [evidence.id]);
      return Array.from({ length: draftCount }, () => project({ canonicalProblemId: canonical.id, reviewMode }));
    },
    runApprover: async (draft) => {
      events.push(`approve:${draft.id}`);
      assert.ok(run.artifactIds.projects.includes(draft.id), "pending draft tracked before approval");
      assert.equal(projectSchema.parse(store.get("project")?.get(draft.id)).agentReview.decision, "pending");
      return { ...draft, agentReview: { decision: "approved", rationale: "Ready", reviewedAt: at, findings: [] } };
    },
  };
  return { dependencies, events, candidates, store, save,
    get run() { return run; },
    get projects() { return [...(store.get("project")?.values() ?? [])].map((value) => projectSchema.parse(value)); },
  };
}

const approved = () => project({ agentReview: { decision: "approved", rationale: "Ready", reviewedAt: at, findings: [] } });

test("seeded concept bypasses Scout, retains the normal gates and immediately reports refs without publication", async () => {
  const h = harness(3, 3);
  for (let i = 0; i < 49; i++) await h.save("project", approved());
  const candidate = { ...h.candidates[0]!, claim: "Autonomous reef monitoring module: observed calibration gap",
    problemHypothesis: "Autonomous reef monitoring module. Value: reliable field measurements. Gap: documented calibration drift." };
  h.dependencies.runScout = async () => { throw new Error("Seeded concept must not scatter through Scout"); };
  const investigator = h.dependencies.runInvestigator;
  h.dependencies.runInvestigator = async (supplied, evidence) => {
    assert.deepEqual(supplied, candidate);
    return investigator(supplied, evidence);
  };
  const planner = h.dependencies.runPlanner;
  h.dependencies.runPlanner = async (...args) => (await planner(...args)).map((draft) => ({ ...draft,
    decision: "selected", decidedBy: "model", decidedAt: at, reviewMode: "agent_direct" }));
  const approver = h.dependencies.runApprover;
  h.dependencies.runApprover = async (...args) => ({ ...await approver(...args),
    decision: "selected", decidedBy: "model", decidedAt: at, reviewMode: "agent_direct" });
  const checkpoints: string[][] = [];
  await executePipeline(h.run.id, {
    maxTarget: 50, humanReviewOnly: true, seed: { evidence: [evidence], candidate },
    sourceQuery: () => "reef monitoring sensors",
    onRunUpdate: async (run) => { checkpoints.push([...run.artifactIds.projects]); },
  }, h.dependencies);
  assert.equal(h.run.status, "completed");
  assert.equal(h.events.filter((event) => event.startsWith("search:")).length, 1, "only bounded Investigator follow-up search");
  assert.ok(h.events.includes("search:reef monitoring sensors"));
  for (const prefix of ["investigate:", "curate:", "plan:", "approve:"]) assert.equal(h.events.filter((event) => event.startsWith(prefix)).length, 1);
  assert.equal(h.run.artifactIds.projects.length, 1);
  assert.equal(activeApprovedProjectIds(h.projects).size, 50);
  assert.ok(checkpoints.some((ids) => ids.includes(h.run.artifactIds.projects[0]!)));
  assert.ok(h.projects.every((draft) => draft.decision === "pending" && draft.reviewMode === "human_review" && draft.decidedAt === null));
});

test("seed citations reject unknown evidence before any source/model work", async () => {
  const h = harness(1);
  await executePipeline(h.run.id, { seed: { evidence: [evidence], candidate: {
    ...h.candidates[0]!, evidenceIds: [randomUUID()],
  } } }, h.dependencies);
  assert.equal(h.run.status, "failed");
  assert.match(h.run.error ?? "", /unknown evidence IDs/);
  assert.deepEqual(h.events, []);
});

test("seeded assessments still require Investigator support and Curator mission alignment", async () => {
  for (const gate of ["support", "mission"] as const) {
    const h = harness(1);
    if (gate === "support") {
      const investigate = h.dependencies.runInvestigator;
      h.dependencies.runInvestigator = async (...args) => ({ ...await investigate(...args), verdict: "uncertain" });
    } else {
      const curate = h.dependencies.runCurator;
      h.dependencies.runCurator = async (...args) => {
        const value = await curate(...args);
        return { ...value, missionAlignment: { ...value.missionAlignment, status: "uncertain" } };
      };
    }
    await executePipeline(h.run.id, { seed: { evidence: [evidence], candidate: h.candidates[0]! }, humanReviewOnly: true }, h.dependencies);
    assert.equal(h.projects.length, 0);
    assert.equal(h.events.some((event) => event.startsWith("plan:")), false);
  }
});

test("lost worker lock never writes a failure or calls the model through a different connection", async () => {
  const h = harness(1);
  let locked = true;
  const updates: string[] = [];
  const update = h.dependencies.updatePipelineRun;
  h.dependencies.updatePipelineRun = async (...args) => { assert.ok(locked); updates.push("update"); return update(...args); };
  h.dependencies.searchSources = async () => { locked = false; return { evidence: [evidence], warnings: [] }; };
  await assert.rejects(executePipeline(h.run.id, { verifyLock: async () => { if (!locked) throw new Error("lost lock"); } }, h.dependencies), /lost lock/);
  assert.deepEqual(updates, ["update"]);
  assert.equal(h.run.status, "running");
  assert.deepEqual(h.events, []);
});

test("already at target performs no source/model work and persists a real completed run", async () => {
  const h = harness();
  await h.save("project", approved());
  await executePipeline(h.run.id, { maxTarget: 1 }, h.dependencies);
  assert.deepEqual(h.events, []);
  assert.equal(h.run.status, "completed");
  assert.equal(h.run.stage, "complete");
});

test("49/50 caps multi-draft planner output and stops before investigating the next candidate", async () => {
  const h = harness(3, 4);
  for (let i = 0; i < 49; i++) await h.save("project", approved());
  await executePipeline(h.run.id, { maxTarget: 50 }, h.dependencies);
  assert.equal(activeApprovedProjectIds(h.projects).size, 50);
  assert.equal(h.run.artifactIds.projects.length, 1);
  assert.equal(h.events.filter((event) => event.startsWith("investigate:")).length, 1);
  assert.equal(h.events.filter((event) => event.startsWith("approve:")).length, 1);
  assert.ok(h.projects.every((item) => item.reviewMode === "human_review" && item.decision === "pending" && item.decidedAt === null));
});

test("capacity is rechecked when counts change while the planner is running", async () => {
  const h = harness(3, 5);
  const planner = h.dependencies.runPlanner;
  h.dependencies.runPlanner = async (...args) => {
    const drafts = await planner(...args);
    await h.save("project", approved());
    return drafts;
  };
  await executePipeline(h.run.id, { maxTarget: 2 }, h.dependencies);
  assert.equal(activeApprovedProjectIds(h.projects).size, 2);
  assert.equal(h.run.artifactIds.projects.length, 1);
});

test("optional guard is checked before candidate writes", async () => {
  const h = harness();
  let allowed = true;
  h.dependencies.runScout = async () => { allowed = false; return h.candidates; };
  await executePipeline(h.run.id, { shouldContinue: () => allowed }, h.dependencies);
  assert.equal(h.run.artifactIds.candidates.length, 0);
  assert.equal(h.store.get("candidate"), undefined);
});

test("optional guard is checked after planner and before draft writes", async () => {
  const h = harness();
  let allowed = true;
  const planner = h.dependencies.runPlanner;
  h.dependencies.runPlanner = async (...args) => { const drafts = await planner(...args); allowed = false; return drafts; };
  await executePipeline(h.run.id, { shouldContinue: async () => allowed }, h.dependencies);
  assert.equal(h.projects.length, 0);
  assert.equal(h.run.artifactIds.projects.length, 0);
  assert.equal(h.events.some((event) => event.startsWith("approve:")), false);
});

test("optional guard is checked after approver and before approval writes; pending draft remains tracked", async () => {
  const h = harness();
  let allowed = true;
  const approver = h.dependencies.runApprover;
  h.dependencies.runApprover = async (...args) => { const result = await approver(...args); allowed = false; return result; };
  await executePipeline(h.run.id, { shouldContinue: () => allowed }, h.dependencies);
  assert.equal(activeApprovedProjectIds(h.projects).size, 0);
  assert.equal(h.run.artifactIds.projects.length, 1);
  assert.equal(h.projects[0]?.agentReview.decision, "pending");
  assert.equal(h.events.filter((event) => event.startsWith("investigate:")).length, 1);
});

for (const stage of ["investigator", "curator", "planner", "approver"] as const) {
  test(`${stage} failure retains warnings/artifacts and continues the rest of the candidates`, async () => {
    const h = harness(3);
    let calls = 0;
    const failOnce = () => { if (calls++ === 0) throw new Error("Simulated model failure"); };
    if (stage === "investigator") {
      const original = h.dependencies.runInvestigator;
      h.dependencies.runInvestigator = async (...args) => { failOnce(); return original(...args); };
    } else if (stage === "curator") {
      const original = h.dependencies.runCurator;
      h.dependencies.runCurator = async (...args) => { failOnce(); return original(...args); };
    } else if (stage === "planner") {
      const original = h.dependencies.runPlanner;
      h.dependencies.runPlanner = async (...args) => { failOnce(); return original(...args); };
    } else {
      const original = h.dependencies.runApprover;
      h.dependencies.runApprover = async (...args) => { failOnce(); return original(...args); };
    }
    await executePipeline(h.run.id, { maxTarget: 50 }, h.dependencies);
    assert.equal(h.run.status, "completed");
    assert.equal(activeApprovedProjectIds(h.projects).size, 2);
    assert.equal(h.run.warnings.length, 1);
    assert.match(h.run.warnings[0]!, /Simulated model failure/);
    if (stage === "approver") {
      assert.equal(h.run.artifactIds.projects.length, 3);
      assert.equal(h.projects.filter((item) => item.agentReview.decision === "pending").length, 1);
    }
  });
}

test("one failed approval does not discard other drafts in that candidate", async () => {
  const h = harness(1, 3);
  const original = h.dependencies.runApprover;
  let calls = 0;
  h.dependencies.runApprover = async (...args) => {
    if (calls++ === 0) throw new Error("First approval failed");
    return original(...args);
  };
  await executePipeline(h.run.id, { maxTarget: 50 }, h.dependencies);
  assert.equal(h.run.artifactIds.projects.length, 3);
  assert.equal(activeApprovedProjectIds(h.projects).size, 2);
});

test("mission gate and canonical-problem dedup remain independent of worker capacity", async () => {
  const h = harness();
  const canonical = problem(h.candidates[0]!.id);
  await h.save("project", project({ canonicalProblemId: canonical.id }));
  h.dependencies.runCurator = async (candidate) => candidate.id === h.candidates[0]!.id
    ? canonical : { ...problem(candidate.id), missionAlignment: { ...canonical.missionAlignment, status: "not_aligned" } };
  await executePipeline(h.run.id, { maxTarget: 50 }, h.dependencies);
  assert.equal(h.events.some((event) => event.startsWith("plan:")), false);
  assert.equal(h.run.artifactIds.projects.length, 0);
});

test("unbounded legacy execution still processes every draft and preserves original source queries", async () => {
  const h = harness(3, 4);
  await executePipeline(h.run.id, undefined, h.dependencies);
  assert.equal(activeApprovedProjectIds(h.projects).size, 12);
  assert.ok(h.events.includes(`search:${h.candidates[0]!.problemHypothesis}`));
});

test("empty/failed sources preserve warnings without paid scout calls", async () => {
  const h = harness();
  h.dependencies.searchSources = async () => ({ evidence: [], warnings: ["Source unavailable"] });
  await executePipeline(h.run.id, {}, h.dependencies);
  assert.equal(h.events.includes("scout"), false);
  assert.deepEqual(h.run.warnings, ["Source unavailable"]);
  assert.equal(h.run.status, "completed");
});

test("invalid target fails before sources and records actual failure", async () => {
  for (const maxTarget of [0, -1, NaN, Infinity, 1.5]) {
    const h = harness();
    await executePipeline(h.run.id, { maxTarget }, h.dependencies);
    assert.deepEqual(h.events, []);
    assert.equal(h.run.status, "failed");
    assert.match(h.run.error!, /maxTarget/);
  }
});