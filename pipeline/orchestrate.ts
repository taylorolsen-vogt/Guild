import { runApprover } from "../agents/approver.js";
import { runCurator } from "../agents/curator.js";
import { runInvestigator } from "../agents/investigator.js";
import { runPlanner } from "../agents/planner.js";
import { runScout } from "../agents/scout.js";
import { assertKnownEvidenceIds } from "../lib/provenance.js";
import {
  candidateProblemSchema,
  canonicalProblemSchema,
  evidenceSchema,
  projectSchema,
  type CandidateProblem,
  type Evidence,
  type PipelineRun,
  type Project,
  type ReviewMode,
} from "../schemas/index.js";
import { adapters, searchSources } from "../sources/index.js";
import { activeApprovedProjectIds } from "./worker-schedule.js";
import { applyPublicationDecision } from "../lib/publication.js";

export interface ExecutePipelineOptions {
  /** Global active agent-approved proposal target; omitted for legacy callers. */
  maxTarget?: number;
  shouldContinue?: () => boolean | Promise<boolean>;
  /** Worker-only bounded source queries; legacy CLI queries are unchanged. */
  sourceQuery?: (query: string) => string;
  /** Independently assessed concept: skip initial search/Scout, not downstream quality gates. */
  seed?: { evidence: Evidence[]; candidate: CandidateProblem };
  /** Fail closed on lost worker ownership, including error-path persistence. */
  verifyLock?: () => Promise<unknown>;
  /** Persist owning cycle refs immediately at every run checkpoint. */
  onRunUpdate?: (run: PipelineRun) => Promise<void>;
  /** Manual/worker paths can never set the public curation decision. */
  humanReviewOnly?: boolean;
}

/** Injection seam for pure regression tests: no database or paid API is imported. */
export interface PipelineDependencies {
  getPipelineRun: typeof import("../db/runs.js").getPipelineRun;
  updatePipelineRun: typeof import("../db/runs.js").updatePipelineRun;
  listArtifacts: typeof import("../db/repository.js").listArtifacts;
  saveArtifact: typeof import("../db/repository.js").saveArtifact;
  searchSources: typeof searchSources;
  runScout: typeof runScout;
  runInvestigator: typeof runInvestigator;
  runCurator: typeof runCurator;
  runPlanner: typeof runPlanner;
  runApprover: typeof runApprover;
}

async function pipelineDependencies(): Promise<PipelineDependencies> {
  const { getPipelineRun, updatePipelineRun } = await import("../db/runs.js");
  const { listArtifacts, saveArtifact } = await import("../db/repository.js");
  return { getPipelineRun, updatePipelineRun, listArtifacts, saveArtifact,
    searchSources, runScout, runInvestigator, runCurator, runPlanner, runApprover };
}

export async function queuePipeline(input: {
  query: string;
  sources: string[];
  limit: number;
  reviewMode: ReviewMode;
}) {
  for (const source of input.sources) {
    if (!adapters[source]) throw new Error(`Unknown source adapter: ${source}`);
  }
  const { createPipelineRun } = await import("../db/runs.js");
  const run = await createPipelineRun(input);
  void executePipeline(run.id);
  return run;
}

export async function executePipeline(
  runId: string,
  options: ExecutePipelineOptions = {},
  dependencies?: PipelineDependencies,
): Promise<void> {
  const {
    getPipelineRun, updatePipelineRun: updateRun, listArtifacts, saveArtifact: save, searchSources,
    runScout, runInvestigator, runCurator, runPlanner, runApprover,
  } = dependencies ?? await pipelineDependencies();
  const updatePipelineRun: PipelineDependencies["updatePipelineRun"] = async (id, changes) => {
    await options.verifyLock?.();
    const run = await updateRun(id, changes);
    await options.onRunUpdate?.(run);
    return run;
  };
  const saveArtifact: PipelineDependencies["saveArtifact"] = async (kind, value) => {
    await options.verifyLock?.();
    await save(kind, value);
  };
  let stopped = false;
  const remaining = async () => options.maxTarget === undefined ? Infinity
    : Math.max(0, options.maxTarget - activeApprovedProjectIds(await listArtifacts("project", projectSchema)).size);
  const canContinue = async () => {
    await options.verifyLock?.();
    // Callback is evaluated first so a worker can durably latch its goal pause.
    const allowed = (!options.shouldContinue || await options.shouldContinue()) && await remaining() > 0;
    await options.verifyLock?.();
    if (!allowed) stopped = true;
    return allowed;
  };
  const query = (text: string) => options.sourceQuery?.(text) ?? text;
  try {
    if (options.maxTarget !== undefined && (!Number.isSafeInteger(options.maxTarget) || options.maxTarget < 1)) {
      throw new Error("maxTarget must be a positive safe integer.");
    }
    let run = await getPipelineRun(runId);
    if (options.humanReviewOnly && run.reviewMode !== "human_review") throw new Error("Manual cycles require human_review.");
    const seed = options.seed ? {
      evidence: options.seed.evidence.map((item) => evidenceSchema.parse(item)),
      candidate: candidateProblemSchema.parse(options.seed.candidate),
    } : undefined;
    if (seed) assertKnownEvidenceIds(seed.candidate.evidenceIds, new Set(seed.evidence.map((item) => item.id)), "Pipeline seed");
    run = await updatePipelineRun(runId, {
      status: "running",
      stage: "scout",
      message: seed ? "Using the evidence-backed concept assessment" : "Searching sources and identifying candidate problems",
    });
    if (!await canContinue()) {
      await updatePipelineRun(runId, { status: "completed", stage: "complete", message: "Discovery stopped before source work by its target or continuation guard" });
      return;
    }
    const search = seed ? { evidence: seed.evidence, warnings: [] } : await searchSources(run.sources, query(run.query), run.limit);
    await Promise.all(search.evidence.map((item) => saveArtifact("evidence", item)));
    run = await updatePipelineRun(runId, {
      warnings: search.warnings,
      artifactIds: {
        ...run.artifactIds,
        evidence: search.evidence.map((item) => item.id),
      },
    });
    // Empty/broken sources do not justify a model call. The worker still counts this attempt.
    const candidates = search.evidence.length && await canContinue() ? seed ? [seed.candidate] : await runScout(search.evidence) : [];
    for (const candidate of candidates) {
      if (!await canContinue()) break;
      await saveArtifact("candidate", candidate);
      run = await updatePipelineRun(runId, {
        artifactIds: { ...run.artifactIds, candidates: [...run.artifactIds.candidates, candidate.id] },
      });
    }

    for (const [index, candidate] of candidates.entries()) {
      if (stopped || !await canContinue()) break;
      try {
        run = await updatePipelineRun(runId, {
          stage: "investigator",
          message: `Investigating candidate ${index + 1} of ${candidates.length}`,
        });
        if (!await canContinue()) break;
        const investigationSearch = await searchSources(run.sources, query(candidate.problemHypothesis), run.limit);
        await Promise.all(investigationSearch.evidence.map((item) => saveArtifact("evidence", item)));
        run = await updatePipelineRun(runId, {
          warnings: [...run.warnings, ...investigationSearch.warnings],
          artifactIds: { ...run.artifactIds, evidence: unique([...run.artifactIds.evidence, ...investigationSearch.evidence.map((item) => item.id)]) },
        });
        if (!await canContinue()) break;
        const allEvidence = await listArtifacts("evidence", evidenceSchema);
        const relevantIds = new Set([
          ...candidate.evidenceIds,
          ...investigationSearch.evidence.map((item) => item.id),
        ]);
        if (!await canContinue()) break;
        const dossier = await runInvestigator(
          candidate,
          allEvidence.filter((item) => relevantIds.has(item.id)),
        );
        if (!await canContinue()) break;
        await saveArtifact("dossier", dossier);
        run = await updatePipelineRun(runId, {
          artifactIds: { ...run.artifactIds, dossiers: [...run.artifactIds.dossiers, dossier.id] },
        });

        if (dossier.verdict !== "supported") continue;
        if (!await canContinue()) break;
        run = await updatePipelineRun(runId, {
          stage: "curator",
          message: `Curating supported candidate ${index + 1} of ${candidates.length}`,
        });
        const evidence = await listArtifacts("evidence", evidenceSchema);
        const existingProblems = await listArtifacts("problem", canonicalProblemSchema);
        if (!await canContinue()) break;
        const problem = await runCurator(
          candidate, dossier, evidence, existingProblems,
        );
        if (!await canContinue()) break;
        await saveArtifact("problem", problem);
        run = await updatePipelineRun(runId, {
          artifactIds: { ...run.artifactIds, problems: unique([...run.artifactIds.problems, problem.id]) },
        });

        if (problem.missionAlignment.status !== "aligned") {
          run = await updatePipelineRun(runId, {
            message: `Stored research but skipped proposal: mission alignment is ${problem.missionAlignment.status}`,
          });
          continue;
        }

        run = await updatePipelineRun(runId, {
          stage: "planner",
          message: `Drafting complete proposals for candidate ${index + 1} of ${candidates.length}`,
        });
        const evidenceById = new Map(evidence.map((item) => [item.id, item]));
        const problemEvidence = problem.evidenceIds.flatMap((id) => {
          const item = evidenceById.get(id);
          return item ? [item] : [];
        });
        const existingProject = (await listArtifacts("project", projectSchema))
          .find((project) => project.canonicalProblemId === problem.id && project.status !== "archived");
        if (existingProject) {
          run = await updatePipelineRun(runId, {
            message: `Updated evidence for an existing proposal: ${existingProject.title}`,
          });
          continue;
        }
        if (!await canContinue()) break;
        const drafts = (await runPlanner(problem, problemEvidence, run.reviewMode)).slice(0, await remaining());
        const savedDrafts: Project[] = [];
        for (const planned of drafts) {
          if (!await canContinue()) break;
          const draft = options.humanReviewOnly ? projectSchema.parse({ ...planned,
            reviewMode: "human_review", decision: "pending", decidedBy: null, decidedAt: null,
          }) : planned;
          await saveArtifact("project", draft);
          // Track each pending draft immediately: approval/model failure must not hide it.
          run = await updatePipelineRun(runId, {
            artifactIds: { ...run.artifactIds, projects: unique([...run.artifactIds.projects, draft.id]) },
          });
          savedDrafts.push(draft);
        }
        run = await updatePipelineRun(runId, {
          stage: "approver",
          message: `Reviewing drafted proposals for candidate ${index + 1} of ${candidates.length}`,
        });
        // Sequential approvals + a fresh count before every write prevent this worker
        // from overshooting even if a future planner returns multiple drafts.
        for (const draft of savedDrafts) {
          if (!await canContinue()) break;
          try {
            const reviewed = await runApprover(draft, problem, problemEvidence);
            if (!await canContinue()) break;
            const project = options.humanReviewOnly ? projectSchema.parse({ ...reviewed,
              reviewMode: "human_review", decision: "pending", decidedBy: null, decidedAt: null,
            }) : reviewed;
            await saveArtifact("project", project);
          } catch (error) {
            run = await updatePipelineRun(runId, { warnings: [...run.warnings, `Approval failed for ${draft.id}: ${error instanceof Error ? error.message : String(error)}`] });
          }
        }
      } catch (error) {
        // One malformed/model-failed candidate must not discard the rest of a batch.
        run = await updatePipelineRun(runId, { warnings: [...run.warnings, `Candidate ${candidate.id} failed: ${error instanceof Error ? error.message : String(error)}`] });
      }
    }

    await updatePipelineRun(runId, {
      status: "completed",
      stage: "complete",
      message: stopped ? `Discovery stopped by its target or continuation guard; stored ${run.artifactIds.projects.length} draft(s)`
        : run.artifactIds.projects.length > 0
        ? `Drafted ${run.artifactIds.projects.length} project proposal(s)`
        : "Research completed with no supported project proposals",
    });
  } catch (error) {
    await updatePipelineRun(runId, {
      status: "failed",
      stage: "failed",
      message: "Pipeline stopped",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function reviewProject(
  projectId: string,
  decision: "selected" | "rejected",
  reviewer: string,
): Promise<Project> {
  const { sql, initializeDatabase } = await import("../db/repository.js");
  await initializeDatabase();
  return sql.begin(async (tx) => {
    const rows = await tx<{ payload: unknown }[]>`SELECT payload FROM artifacts WHERE id = ${projectId} AND kind = 'project' FOR UPDATE`;
    if (!rows[0]) throw new Error("Project not found.");
    const project = projectSchema.parse(rows[0].payload);
    const updated = applyPublicationDecision(project, decision, reviewer, new Date().toISOString());
    await tx`UPDATE artifacts SET payload = ${sql.json(updated)}, updated_at = clock_timestamp() WHERE id = ${projectId} AND kind = 'project'`;
    return updated;
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}