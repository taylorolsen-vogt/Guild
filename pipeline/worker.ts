import "dotenv/config";
import { pathToFileURL } from "node:url";
import {
  applyVerification, beginDiscoveryAttempt, parseWorkerConfig, projectNeedsRevalidation,
  reconcileWorkerGoal, runDueJobs, settleTrackedAttempt, workerSources,
} from "./worker-schedule.js";
import { compactSourceQuery, discoveryBriefAt } from "./discovery-briefs.js";

export async function main(): Promise<void> {
  const config = parseWorkerConfig(process.env);
  config.target = Math.min(50, config.target);
  // Keep imports inert for unit tests and do not start automation from the API process.
  const { sql, initializeDatabase, closeDatabase, listArtifacts, saveArtifact } =
    await import("../db/repository.js");
  let stopping = false;
  let wake: (() => void) | undefined;
  const stop = () => {
    stopping = true;
    wake?.();
    console.log("Worker stopping after in-flight work finishes.");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatInFlight: Promise<void> | undefined;
  try {
    const { getPipelineRun, updatePipelineRun } = await import("../db/runs.js");
    const { executePipeline } = await import("./orchestrate.js");
    const { initializeSearchCycles } = await import("../db/search-cycles.js");
    const { processPendingSearchCycle } = await import("./search-cycle.js");
    const {
      initializeWorkerState, heartbeatWorker, readWorkerProgress, saveWorkerProgress,
      getActiveApprovedProjectIds, checkpointDiscoveryAttempt, checkpointWorkerJob, workerLastActivity,
      WORKER_LOCK_NAMESPACE, WORKER_LOCK_ID,
    } = await import("../db/worker-state.js");
    const { revalidateProject } = await import("../agents/verifier.js");
    const { searchSources } = await import("../sources/index.js");
    const { projectSchema } = await import("../schemas/index.js");

    // Finish cached repository DDL BEFORE holding a transaction open on another connection.
    await initializeDatabase();
    await initializeWorkerState();
    await initializeSearchCycles();

    // Health remains fresh even while the sequential batch owns the work lock.
    // This timer ONLY writes health; it never launches jobs and never overlaps itself.
    const heartbeat = () => heartbeatInFlight ??= heartbeatWorker()
      .catch((error) => { console.error("Worker heartbeat failed:", error); })
      .finally(() => { heartbeatInFlight = undefined; });
    await heartbeat();
    heartbeatTimer = setInterval(() => { void heartbeat(); }, config.pollMs);

    async function recordError(message: string): Promise<void> {
      const state = await readWorkerProgress();
      await saveWorkerProgress({ ...state, lastError: message, updatedAt: new Date().toISOString() });
    }

    // Called only under the shared work lock. Status/count reads never invoke this.
    async function discoveryAllowed(): Promise<boolean> {
      const previous = await readWorkerProgress();
      const at = new Date().toISOString();
      const configured = previous.target === config.target ? previous : { ...previous, target: config.target, updatedAt: at };
      const state = reconcileWorkerGoal(configured, (await getActiveApprovedProjectIds()).size, config.maxNoProgressRuns, at);
      if (state !== previous) await saveWorkerProgress(state);
      return !stopping && !state.pausedReason;
    }

    async function settleAttempt(interrupted: boolean): Promise<void> {
      const result = await settleTrackedAttempt(await readWorkerProgress(), config.maxNoProgressRuns, interrupted, {
        getRun: getPipelineRun, updateRun: updatePipelineRun, approvedIds: getActiveApprovedProjectIds,
        now: () => new Date().toISOString(), save: saveWorkerProgress,
        checkpoint: (time) => checkpointWorkerJob("discovery", time),
      });
      if (!result) return;
      const { state, run, additions, count } = result;
      console.log(`Worker discovery ${run.status}: ${run.id}; ${additions} addition(s), ${count}/${state.target}${state.pausedReason ? `; paused: ${state.pausedReason}` : ""}`);
    }

    async function discover(verifyLock: () => Promise<unknown>): Promise<void> {
      const allowed = async () => {
        // A disconnected lock transaction must not keep spending/writing through
        // other pool connections while a new worker acquires the released lock.
        await verifyLock();
        return discoveryAllowed();
      };
      if (!await allowed()) return;
      const state = await readWorkerProgress();
      const run = await checkpointDiscoveryAttempt(beginDiscoveryAttempt(state, new Date().toISOString()), {
        query: config.query ?? discoveryBriefAt(state.briefIndex), sources: [...workerSources], limit: config.limit,
      });
      console.log(`Worker discovery started: ${run.id}`);
      try {
        await executePipeline(run.id, {
          maxTarget: Math.min(50, config.target), shouldContinue: allowed, sourceQuery: compactSourceQuery,
          verifyLock, humanReviewOnly: true,
        });
      } finally {
        // Even failed runs count toward the circuit breaker. Interrupted attempts
        // are settled on the next lock acquisition if persistence is unavailable.
        await verifyLock();
        await settleAttempt(false);
      }
    }

    async function revalidate(now: number, verifyLock: () => Promise<unknown>): Promise<void> {
      const projects = (await listArtifacts("project", projectSchema))
        .filter((project) => projectNeedsRevalidation(project, now, config.revalidationMs));
      for (const project of projects) {
        if (stopping) break;
        try {
          await verifyLock();
          const query = compactSourceQuery(project.title);
          const search = await searchSources(workerSources, query, config.limit);
          await Promise.all(search.evidence.map((item) => saveArtifact("evidence", item)));
          if (!search.evidence.length) {
            console.warn(`Worker revalidation skipped ${project.id}: no fresh evidence. ${search.warnings.join("; ")}`);
            continue;
          }
          await verifyLock();
          if (stopping) break;
          const verification = await revalidateProject(project, search.evidence);
          await verifyLock();
          // A short row-locked transaction preserves intervening human edits. Never use
          // saveArtifact here: its separate connection cannot share this row lock.
          const saved = await sql.begin(async (projectTx) => {
            const rows = await projectTx<{ payload: unknown }[]>`
              SELECT payload FROM artifacts WHERE id = ${project.id} AND kind = 'project' FOR UPDATE
            `;
            if (!rows[0]) return false;
            const current = projectSchema.parse(rows[0].payload);
            if (current.decision !== "selected" || current.status === "archived" || current.lifecycleStatus === "completed") return false;
            const updated = projectSchema.parse(applyVerification(current, verification));
            await projectTx`
              UPDATE artifacts SET payload = ${sql.json(updated)}, updated_at = clock_timestamp()
              WHERE id = ${project.id} AND kind = 'project'
            `;
            return true;
          });
          if (saved) console.log(`Worker revalidated ${project.id}: ${verification.status}`);
        } catch (error) {
          // One failed project must not starve the rest of the selected fleet.
          console.error(`Worker revalidation failed for ${project.id}:`, error);
          await verifyLock();
          await recordError("Revalidation failed for a project; inspect worker logs.");
        }
      }
    }

    console.log(`Worker started: target ${config.target}, discovery cooldown ${config.discoveryMs / 60_000}min, revalidation ${config.revalidationMs / 3_600_000}h, human_review only.`);
    while (!stopping) {
      try {
        await heartbeat();
        await sql.begin(async (tx) => {
          // The reserved connection owns the lock until COMMIT/ROLLBACK, including during API calls.
          const locks = await tx<{ acquired: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(${WORKER_LOCK_NAMESPACE}, ${WORKER_LOCK_ID}) AS acquired
          `;
          if (!locks[0]?.acquired || stopping) return;
          // Jobs use the other four pool connections; avoid an idle transaction timeout unlocking early.
          await tx`SET LOCAL idle_in_transaction_session_timeout = 0`;
          const now = async () => {
            const rows = await tx<{ now: string }[]>`SELECT clock_timestamp()::text AS now`;
            return Date.parse(rows[0]!.now);
          };
          try {
            await settleAttempt(true);
            await processPendingSearchCycle({ target: Math.min(50, config.target), limit: config.limit,
              verifyLock: now, stopping: () => stopping });
            await runDueJobs(config, {
              now,
              stopping: () => stopping,
              canRun: async (job) => { await now(); return job === "revalidation" || await discoveryAllowed(); },
              lastActivity: workerLastActivity,
              // Deliberately NOT tx: attempts survive rollback/crash of the lock transaction.
              checkpoint: checkpointWorkerJob,
              execute: async (job) => {
                if (job === "revalidation") return revalidate(await now(), now);
                await discover(now);
              },
              reportError: async (job, error) => {
                console.error(`Worker ${job} failed:`, error);
                await now();
                await recordError(job === "discovery" ? "Discovery failed; inspect worker logs." : "Revalidation failed; inspect worker logs.");
              },
            });
          } catch (error) {
            // Still under the lock: do not race another worker's state writes.
            await now().then(() => recordError("Worker tick failed; inspect worker logs.")).catch(() => {});
            throw error;
          }
        });
      } catch (error) {
        console.error("Worker tick failed; retrying after the polling interval:", error);
      }
      if (!stopping) {
        // No interval-driven jobs: ticks never overlap and missed work is not replayed.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { wake = undefined; resolve(); }, config.pollMs);
          wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
        });
      }
    }
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await heartbeatInFlight;
    // Signals only request shutdown; do not close connections underneath a running job/transaction.
    await closeDatabase();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error("Worker stopped:", error); process.exitCode = 1; });
}