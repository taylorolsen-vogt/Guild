import { conceptCandidate, conceptSourceEvidence, runConceptReviewer } from "../agents/concept-reviewer.js";
import {
  imageReviewConcepts, projectCycle, type SearchCycle, type SearchCycleResult,
} from "../schemas/search-cycle.js";
import { projectSchema, type Project } from "../schemas/project.js";
import type { PipelineRun } from "../schemas/run.js";
import { compactSourceQuery, discoveryBriefAt } from "./discovery-briefs.js";
import { workerSources } from "./worker-schedule.js";
import { executePipeline } from "./orchestrate.js";
import { searchSources } from "../sources/index.js";

export interface SearchCycleDependencies {
  list: typeof import("../db/search-cycles.js").listSearchCycles;
  claim: typeof import("../db/search-cycles.js").claimSearchCycle;
  save: typeof import("../db/search-cycles.js").saveSearchCycle;
  createRun: typeof import("../db/search-cycles.js").createSearchCycleRun;
  getRun: typeof import("../db/runs.js").getPipelineRun;
  updateRun: typeof import("../db/runs.js").updatePipelineRun;
  saveArtifact: typeof import("../db/repository.js").saveArtifact;
  projects(): Promise<Project[]>;
  approvedIds(): Promise<Set<string>>;
  progress: typeof import("../db/worker-state.js").readWorkerProgress;
  checkpoint(time: number): Promise<void>;
  search: typeof searchSources;
  review: typeof runConceptReviewer;
  execute: typeof executePipeline;
  now(): string;
}

async function cycleDependencies(): Promise<SearchCycleDependencies> {
  const cycles = await import("../db/search-cycles.js");
  const runs = await import("../db/runs.js");
  const repository = await import("../db/repository.js");
  const worker = await import("../db/worker-state.js");
  return {
    list: cycles.listSearchCycles, claim: cycles.claimSearchCycle, save: cycles.saveSearchCycle,
    createRun: cycles.createSearchCycleRun, getRun: runs.getPipelineRun, updateRun: runs.updatePipelineRun,
    saveArtifact: repository.saveArtifact,
    projects: () => repository.listArtifacts("project", projectSchema),
    approvedIds: worker.getActiveApprovedProjectIds, progress: worker.readWorkerProgress,
    checkpoint: (time) => worker.checkpointWorkerJob("discovery", time),
    search: searchSources, review: runConceptReviewer, execute: executePipeline,
    now: () => new Date().toISOString(),
  };
}

export interface SearchCycleOptions {
  target: number;
  limit: number;
  /** Required: the caller owns the existing worker lock throughout this entire operation. */
  verifyLock(): Promise<unknown>;
  stopping(): boolean;
}

const terminalResults = new Set<SearchCycleResult["status"]>(["completed", "failed", "interrupted", "skipped"]);
class CycleStopping extends Error {}

function withRun(result: SearchCycleResult, run: PipelineRun): SearchCycleResult {
  if (result.runId !== run.id) throw new Error("Cycle pipeline ownership mismatch.");
  return { ...result, runStatus: run.status, projectIds: [...run.artifactIds.projects],
    artifactIds: run.artifactIds,
    evidenceIds: [...new Set([...result.evidenceIds, ...run.artifactIds.evidence])],
    // Raw provider errors stay out of the cycle API. Linked run retains diagnostic details.
    message: run.status === "failed" ? "Pipeline failed; partial artifacts retained for review" : run.message,
    warnings: [...new Set([...result.warnings, ...(run.warnings.length ? ["Pipeline reported warnings; inspect the linked run."] : [])])],
  };
}

/** Sticky terminal recovery: only runs atomically owned by this started cycle, never pending requests
 * or unrelated CLI/automatic runs. Called with the work lock, not at API startup or in a status read.
 */
export async function interruptSearchCycle(
  cycle: SearchCycle, options: Pick<SearchCycleOptions, "verifyLock">, d: SearchCycleDependencies,
): Promise<SearchCycle> {
  const results: SearchCycleResult[] = [];
  for (const original of cycle.results) {
    await options.verifyLock();
    let result = original;
    if (result.runId) {
      let run = await d.getRun(result.runId);
      if (run.id !== result.runId) throw new Error("Cycle pipeline ownership mismatch.");
      if (run.status === "queued" || run.status === "running") {
        await options.verifyLock();
        run = await d.updateRun(run.id, { status: "failed", stage: "failed",
          message: "Manual cycle was interrupted", error: "Worker stopped before this owned run completed. Partial artifacts are retained; request a new cycle to retry." });
      }
      result = withRun(result, run);
    }
    if (!terminalResults.has(result.status)) result = { ...result, status: "interrupted",
      message: "Interrupted; assessment and partial artifacts retained. Request a new cycle to retry.",
      error: "Worker stopped before this concept finished." };
    results.push(result);
  }
  await options.verifyLock();
  // Cooldown commits before the terminal transition, so a recovery failure can be safely retried.
  await d.checkpoint(Date.parse(d.now()));
  return d.save(projectCycle({ ...cycle, results, status: "failed", finishedAt: d.now(),
    message: "Manual cycle interrupted; completed assessments and partial artifacts retained",
    error: "This cycle will not be retried automatically. Request a new cycle to retry." }, d.now()));
}

/** Consume at most ONE queued request, independent of automatic cooldown/pause. Never clears a pause.
 * Imports are inert; only the worker calls this after initialization and settleAttempt(true), under lock.
 */
export async function processPendingSearchCycle(
  options: SearchCycleOptions, dependencies?: SearchCycleDependencies,
): Promise<SearchCycle | null> {
  if (!Number.isSafeInteger(options.target) || options.target < 1) throw new Error("A positive target is required.");
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 25) throw new Error("Source limit must be 1–25.");
  const d = dependencies ?? await cycleDependencies();
  const maxTarget = Math.min(50, options.target);
  await options.verifyLock();
  // A queued request with no startedAt is not interrupted work: it may have arrived while busy.
  for (const interrupted of (await d.list()).filter((cycle) => cycle.status === "running"
    || cycle.status === "queued" && cycle.startedAt !== null)) {
    await interruptSearchCycle(interrupted, options, d);
  }
  await options.verifyLock();
  if (options.stopping()) return null;
  let cycle = await d.claim();
  if (!cycle) return null;
  const guard = async () => {
    await options.verifyLock();
    if (options.stopping()) throw new CycleStopping();
  };
  const persist = async (conceptId: string, change: Partial<SearchCycleResult>) => {
    await options.verifyLock();
    cycle = await d.save(projectCycle({ ...cycle!, results: cycle!.results.map((result) => result.conceptId === conceptId
      ? { ...result, ...change } : result) }, d.now()));
  };
  const resultFor = (id: string) => cycle!.results.find((result) => result.conceptId === id)!;
  const atCapacity = async () => (await d.approvedIds()).size >= maxTarget;
  const reloadOwnedCycle = async () => {
    await options.verifyLock();
    const stored = (await d.list()).find((item) => item.id === cycle!.id);
    if (!stored) throw new Error("The owned cycle is missing.");
    cycle = stored;
  };

  async function runPipeline(conceptId: string, query: string, seed?: Parameters<typeof executePipeline>[1], cursor?: number) {
    await guard();
    if (await atCapacity()) {
      await persist(conceptId, { status: "skipped", message: `Proposal target ${maxTarget} reached; assessment retained, no new proposal work started.` });
      return;
    }
    await guard();
    const linked = await d.createRun(cycle!.id, conceptId, { query, sources: [...workerSources], limit: options.limit }, cursor);
    cycle = linked.cycle;
    // The create+link transaction already persisted runId before even this callback is installed.
    await d.execute(linked.run.id, {
      ...seed, maxTarget, humanReviewOnly: true,
      verifyLock: options.verifyLock,
      shouldContinue: async () => { await options.verifyLock(); return !options.stopping(); },
      sourceQuery: seed?.seed ? () => query : compactSourceQuery,
      onRunUpdate: async (run) => { await persist(conceptId, withRun(resultFor(conceptId), run)); },
    });
    await options.verifyLock();
    const run = await d.getRun(linked.run.id);
    await persist(conceptId, withRun(resultFor(conceptId), run));
    if (options.stopping()) throw new CycleStopping();
    if (run.status === "queued" || run.status === "running") throw new Error("Manual pipeline did not reach a terminal state.");
    const failed = run.status === "failed" || run.warnings.some((warning) => /^(Candidate .* failed:|Approval failed for )/.test(warning));
    await persist(conceptId, { status: failed ? "failed" : "completed",
      error: failed ? "Pipeline failed or reported a candidate/approval failure; partial results retained in the linked run." : null });
  }

  try {
    for (const initial of cycle.results) {
      await guard();
      try {
        if (cycle.profile === "frontier_scan") {
          const progress = await d.progress();
          const query = discoveryBriefAt(progress.briefIndex);
          await persist(initial.conceptId, { searchTerms: [query], message: "One bounded scan at the current worker cursor" });
          await runPipeline(initial.conceptId, query, undefined, progress.briefIndex);
          continue;
        }
        const concept = imageReviewConcepts.find((item) => item.id === initial.conceptId);
        if (!concept) throw new Error("Unknown image-review concept.");
        await persist(concept.id, { status: "searching", message: "Retrieving real source evidence; images are not evidence" });
        // Two fixed 2–4-keyword queries per concept. No LLM-generated search scatter.
        const byHash = new Map<string, ReturnType<typeof conceptSourceEvidence>[number]>();
        const warnings: string[] = [];
        for (const query of concept.searchTerms) {
          await guard();
          const search = await d.search([...workerSources], query, options.limit);
          await options.verifyLock();
          for (const item of conceptSourceEvidence(search.evidence)) {
            if (byHash.has(item.contentHash)) continue;
            byHash.set(item.contentHash, item);
            await options.verifyLock();
            await d.saveArtifact("evidence", item);
          }
          if (search.warnings.length) warnings.push(`Source retrieval reported ${search.warnings.length} warning(s) for “${query}”; evidence may be incomplete.`);
          await persist(concept.id, { evidence: [...byHash.values()], evidenceIds: [...byHash.values()].map((item) => item.id), warnings });
        }
        await guard();
        const evidence = [...byHash.values()];
        const projects = (await d.projects()).filter((project) => project.status !== "archived");
        await guard();
        const assessment = await d.review(concept, evidence, projects);
        // This durable checkpoint is intentionally BEFORE any long Investigator/Planner work.
        await persist(concept.id, { status: "evaluated", assessment, evaluatedAt: d.now(), message: assessment.rationale.text });
        await guard();
        if (assessment.recommendation !== "propose") {
          await persist(concept.id, { status: "completed" });
          continue;
        }
        const candidate = conceptCandidate(concept, assessment, evidence);
        await runPipeline(concept.id, concept.searchTerms[0], { seed: { evidence, candidate } });
      } catch (error) {
        // A lost lock must escape WITHOUT persistence through other connections. A new owner recovers.
        await options.verifyLock();
        if (error instanceof CycleStopping) throw error;
        // A short transaction can commit even if its response is lost. Reload before writing:
        // never erase an atomically linked runId with stale pre-create/pre-checkpoint memory.
        await reloadOwnedCycle();
        const result = resultFor(initial.conceptId);
        if (result.runId) {
          let run = await d.getRun(result.runId);
          if (run.status === "queued" || run.status === "running") {
            await options.verifyLock();
            run = await d.updateRun(run.id, { status: "failed", stage: "failed", message: "Manual concept execution failed",
              error: "Manual concept execution failed. Partial results are retained; request a new cycle to retry." });
          }
          await persist(initial.conceptId, withRun(result, run));
        }
        await persist(initial.conceptId, { status: "failed", message: "Concept failed; other concept results are retained",
          error: "Source retrieval, assessment validation or proposal execution failed. No automatic retry." });
      }
    }
    await options.verifyLock();
    await d.checkpoint(Date.parse(d.now()));
    const failed = cycle.results.some((result) => result.status === "failed");
    cycle = await d.save(projectCycle({ ...cycle, status: failed ? "failed" : "completed", finishedAt: d.now(),
      message: failed ? "Cycle finished with failed concepts; other results are retained" : "Manual cycle completed; any proposals await human curation",
      error: failed ? "Some concepts failed; request a new cycle to retry." : null }, d.now()));
    return cycle;
  } catch (error) {
    await options.verifyLock();
    await reloadOwnedCycle();
    if (cycle.status === "completed" || cycle.status === "failed") return cycle;
    // Also settle a shutdown during an in-flight stage. Never begin the next concept on a signal.
    return interruptSearchCycle(cycle, options, d);
  }
}