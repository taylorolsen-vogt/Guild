# The Engineers

The repository contains the public site and an automated, provenance-first project discovery pipeline.

## Pipeline

The pipeline uses focused agent stages in one TypeScript process:

1. **Scout** turns normalized source evidence into candidate problems.
2. **Investigator** tries to disprove a candidate and records solutions, prior attempts, contradictions, and open questions.
3. **Curator** deduplicates against the problem graph and computes transparent measurements from stored evidence. It does not create a synthetic priority score.
4. **Planner** creates complete draft proposals, including an engineering blueprint and independently assignable tasks.
5. **Approver** independently checks each draft for evidence, buildability, scope, validation, and completeness before it reaches human curation.

Artifacts are validated with Zod and stored as JSONB in Supabase PostgreSQL. Every downstream artifact references evidence IDs, and agent output containing unknown evidence IDs is rejected. Planner drafts the complete proposal before selection so the decision can be based on scope, deliverables, risks, milestones, tasks, resources, and source evidence.

### Bounded agent inputs and URL handling

The Curator prompt-overflow fix is in the actual model-input path in [agents/curator.ts](agents/curator.ts), not just a shorter source query: it sends at most **80 cited evidence excerpts** (2,000 characters each), **50 relevance-ranked compact problem records**, and **20 items each** from the dossier's solutions, prior attempts, contradictions, and open questions, with bounded candidate and metadata text. Mission reassessment uses the same bounded excerpts. Merge/related IDs must come from the supplied shortlist, and citations must come from the supplied evidence. These model-only bounds do not truncate stored records, merged provenance, or the evidence used for measurements; they are not a universal token or spending cap.

In [agents/investigator.ts](agents/investigator.ts), model-returned `null` URLs for existing solutions and prior attempts are normalized to an omitted optional URL. Valid URLs and evidence IDs are preserved; malformed non-null URLs still fail validation. This corrects the model-output boundary without weakening the stored URL schema or inventing links. Offline regressions are in [tests/agent-inputs.test.ts](tests/agent-inputs.test.ts).

## Claude configuration

The agents use Anthropic's Claude Messages API. Choose the Claude model explicitly so model upgrades remain deliberate:

```sh
export ANTHROPIC_API_KEY="..."
export CLAUDE_MODEL="your-claude-model-id"
```

`DATABASE_URL` must contain the private Supabase PostgreSQL connection string. `ANTHROPIC_API_URL` can override the default `https://api.anthropic.com/v1/messages` endpoint. `GITHUB_TOKEN` is optional and raises GitHub API rate limits.

The admin server loads these values from a gitignored `.env` file. Keep `.env.example` empty of secrets.

## Admin workspace

```sh
npm run admin
```

Open `http://127.0.0.1:4190/` for the public homepage or `http://127.0.0.1:4190/admin` to manage projects. The main view is **Run search → To review → Approve and publish**. **Published** lists live projects; **Not ready** keeps unfinished, completed, or set-aside plans accessible. Counts match these separate lists. Open a plan to see what is being built, why it matters, who it helps, and its sources. Full build instructions and research checks remain available in expandable sections.

Search results show plain-language outcomes. Search options and technical history are collapsed by default; raw stage names, errors, and worker counters are not the main interface. Loading and unavailable states do not pretend there are zero projects. The localhost-only server connects to Supabase PostgreSQL; credentials remain server-side. The admin/API and recurring worker are separate processes: starting or restarting the admin does not start discovery.

New plans are instructed to use short, concrete names and brief summaries explaining the build and who it helps. Detailed tasks retain exact technical requirements, explained jargon, and source references. These writing changes do not rewrite existing database records or weaken evidence and publication checks.

`GET /api/state` includes the read-only `worker` status: current active-approved count and target, heartbeat, pause reason, no-progress counter, next brief cursor, tracked run ID/status/stage, activity timestamps, and a public-safe error summary. It also returns durable search `cycles` with their per-concept results and linked runs/projects. Status reads do not launch jobs, change state, or recover runs. Both processes initialize worker state and search-cycle storage at startup; admin startup no longer calls global `recoverInterruptedRuns()` and can coexist with a live worker.

The operating flow is discovery → draft proposal → agent approval → human curation. Agent-approved drafts appear in the admin queue. A named curator can publish or reject them; only published projects appear on the public Work page.

### Manual Run search cycles

The admin **Run search cycle** button sends `POST /api/runs` with a `profile` of `frontier_scan` (the default) or `image_review`. The old long-prompt/direct-execution endpoint behavior is removed: this route only enqueues a durable record in the private, RLS-enabled `search_cycles` table and returns HTTP 202 with `{ cycle, alreadyQueued }`. It does not launch a pipeline in the admin process. A short enqueue lock and unique outstanding-cycle index deduplicate repeated requests, including requests for different profiles while one is queued or running.

- **`frontier_scan`** requests one bounded scan at the worker's current durable brief cursor; creating its linked run advances that cursor atomically.
- **`image_review`** independently reviews five concepts: autonomous reef monitoring module, open-source prosthetic hand, emergency shelter system, modular orbital sensor platform, and autonomous precision agriculture rover. Each gets its own source searches, verdict (`propose`, `do_not_add`, or `needs_evidence`), gap status, and seven assessment fields: rationale, value, target users, existing alternatives, unresolved gap, feasibility, and duplicate saturation. Each field in a `propose` verdict must cite supplied textual source evidence; uncertainty remains explicit when evidence is missing. **Images and concept titles are inspiration, not evidence** of demand, novelty, performance, or an unresolved gap.

The worker consumes at most one queued cycle per tick **under the same advisory work lock as automatic discovery and revalidation**, after settling any tracked automatic attempt. It awaits the cycle, so manual and scheduled jobs do not overlap while that lock is held. A queued request requires a live worker on an awake machine; HTTP 202 does not mean work has started. Assessments are saved before downstream proposal work, with linked run/artifact IDs and failures retained per concept. Interrupted started cycles are settled only by the worker under the lock, not by status reads; they are not automatically retried.

An explicit cycle can bypass automatic discovery's cooldown and `no_progress` pause **for that requested cycle only**. It does not clear the sticky pause or reset its no-progress counter, and completion checkpoints a fresh discovery cooldown. New proposal work still respects the active-approved target, capped at **50** (or a lower configured target). Image concepts can still be assessed at capacity, but no new proposal pipeline starts. This is not an automatic-discovery resume or a promise that agents are always running.

A `propose` verdict only seeds the assessed concept into Investigator → Curator → Planner → Approver; it does not bypass their evidence, mission, or quality gates. **Neither `propose` nor agent approval means published.** Manual and worker runs retain `human_review` and a pending human decision until deliberate curation.

### Local preview and publication

**Preview website** opens the shared [project.html](project.html) renderer with `id=<project-uuid>&preview=1`, using the read-only local `GET /api/projects/:id/preview` endpoint. Preview is explicitly labeled unpublished and does not fall back to public data, publish a project, or change its decision. Keep this endpoint within localhost operations; it is not an authenticated multi-user preview service and must not be exposed as a public API.

**Approve and publish**, **Reject**, and **Unpublish and reject** require a nonblank curator name and a confirmation dialog before submitting `POST /api/projects/:id/review`. Publication requires `agentReview.decision = approved`, `decision = selected`, and neither archived status nor completed lifecycle. Pending, rejected, unapproved, archived, and completed projects are excluded from `GET /api/public/projects`. The decision records the supplied curator and server timestamp without changing tasks, blueprint, or agent review. Rejection removes a selected project from public results; repeating the same eligible decision preserves the original `decidedBy` and `decidedAt`.

The updated public project template presents Overview, Tasks, Design, Requirements, Build, Test, and Evidence from the stored plan. It honestly displays **Design media pending** when no photographs, CAD files, or engineering drawings were supplied; the component inventory is explicitly **not CAD**. It does not substitute fake project photos, fabricated CAD, or invented cost estimates. Build facts come from actual plan fields and counts, and missing source links remain unavailable rather than being invented.

## Manual workflow

```sh
npm install
npm run typecheck
npm test

npm run scout -- --query "industrial maintenance failures" --sources arxiv,github,reddit,government --limit 5
npm run list -- --kind candidate
npm run investigate -- --candidate <candidate-uuid>
npm run curate -- --dossier <dossier-uuid>
npm run plan -- --problem <problem-uuid> --mode human_review
```

`npm run typecheck` and `npm test` are offline validation, not discovery or publication. [tests/publication.test.ts](tests/publication.test.ts) tests the pure publication helpers with in-memory fixtures only: visibility, selection guards, plan preservation, rejection, and idempotent decision metadata. It imports no database or service and performs no real publication or paid model work. The research CLI commands above are legacy manual operations; run them only with workers stopped, as described below.

The older problem approval command remains available for research review, but it no longer blocks proposal drafting. Project selection happens after Planner has produced the full proposal.

The adapters query bounded APIs; they do not crawl the web. Source failures are reported independently so one unavailable adapter does not erase evidence returned by the others.

## Scheduled operations

### Installed macOS worker service

The per-user LaunchAgent `org.theengineers.discovery` is installed on the current Mac. It starts at login (`RunAtLoad`) and is kept alive by launchd (`KeepAlive`), with a 60-second restart throttle. It runs only while this Mac is awake and the login session is active; it does not keep the Mac awake. The service runs Node directly with `--import tsx`, using the repository as its working directory and loading the same private environment credentials as the admin. It can make paid source/model calls without the admin running.

This describes the installed configuration, not a guarantee of current uptime or continuous discovery. Check the service, recent heartbeat, queued/running cycle, and pause reason separately; a healthy process may be waiting or safety-paused.

Only the two legacy Guild cron entries for discovery and revalidation were removed; unrelated cron entries were left alone. Do not restore those entries alongside this service.

Service controls (run as the logged-in user, without `sudo`):

```sh
# Status of the installed service.
launchctl print "gui/$(id -u)/org.theengineers.discovery"

# Start/load after a stop; unnecessary if already loaded. RunAtLoad starts Node.
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/org.theengineers.discovery.plist"

# Stop/unload until explicitly loaded again or the next login.
launchctl bootout "gui/$(id -u)/org.theengineers.discovery"
```

Killing only the Node process is not a service stop: `KeepAlive` restarts it. Stopping the service does not clear a discovery pause. The installed service allows up to 900 seconds for shutdown before forced termination; prefer stopping when idle.

Inspect logs and, with the separate admin server running, database-backed status:

```sh
tail -n 100 /tmp/engineers-worker.log /tmp/engineers-worker-error.log
curl -fsS http://127.0.0.1:4190/api/state | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["worker"], indent=2))'
```

For foreground diagnosis **only with the service unloaded and no other worker running**, the equivalent direct invocation is:

```sh
cd /Users/taylorolsen-vogt/Guild
/opt/homebrew/bin/node --import tsx pipeline/worker.ts
```

The `worker` package script already exists, but the LaunchAgent does not depend on npm or a package-script wrapper. Implementation lives in [pipeline/worker.ts](pipeline/worker.ts), [pipeline/worker-schedule.ts](pipeline/worker-schedule.ts), and [db/worker-state.ts](db/worker-state.ts).

### Discovery goal, cooldown, and durable pauses

The default goal is **50 active agent-approved projects**, not 50 published projects. Counted projects must have `agentReview.decision = approved`, a human decision of `pending` or `selected`, and be neither archived nor completed. Rejected projects and unapproved drafts do not count; approved proposals can still have draft status while awaiting curation. **50 is the configured target, not a claim that it has been achieved**; consult `/api/state` for the current count. The installed LaunchAgent explicitly sets `WORKER_TARGET_PROJECTS=50`.

Automatic discovery runs sequential batches while below the goal and unpaused, with a **five-minute cooldown after each batch**, including failures, followed by the polling delay as applicable. Before paid work, the worker atomically persists its queued run, tracked attempt, no-progress charge, and next brief cursor. The default briefs rotate **per batch**, not by date: microgrids → robotics → prosthetics → oceanography → spacecraft → photonics → infrastructure. The durable `briefIndex` survives restarts; a crashed attempt consumes its brief rather than replaying it.

- Reaching the goal records a sticky `goal_reached` discovery pause.
- **Eight consecutive runs without a new active-approved project** record a sticky `no_progress` pause. Failed or interrupted attempts without additions count too. New approved project IDs from the tracked run reset the counter; unrelated human rejections do not hide those additions.
- Neither pause clears on a poll, restart, falling count, later rejection/completion, increased target, or manual cycle. Resuming automatic discovery requires diagnosis and explicit operator reassessment using the procedure below. A single requested cycle can still run as described above without resuming automatic discovery.
- A discovery pause does not stop the process, heartbeat, or independently scheduled selected-project revalidation. It never publishes a proposal.

Defaults and optional environment settings:

| Setting | Default | Validation / purpose |
| --- | --- | --- |
| `WORKER_TARGET_PROJECTS` | `50` | Positive safe integer; effective worker/manual-cycle goal capped at 50, lower targets respected (also set to 50 by the installed LaunchAgent) |
| `WORKER_MAX_NO_PROGRESS_RUNS` | `8` | Positive safe integer; consecutive no-addition attempts before sticky pause |
| `WORKER_DISCOVERY_HOURS` | 1/12 hour (5 minutes) | Finite positive numeric hours; fractional values allowed, minimum 1 ms, at most `Number.MAX_SAFE_INTEGER` milliseconds |
| `WORKER_REVALIDATION_HOURS` | `24` | Same validation; selected-project sweep interval and per-project freshness window |
| `WORKER_POLL_SECONDS` | `60` | 5–3600 seconds, delay after the previous tick finishes |
| `WORKER_DISCOVERY_LIMIT` | `5` | Integer 1–25 results per source search, also used for revalidation |
| `DISCOVERY_QUERY` | durable per-batch brief | Optional fixed search query, at most 120 characters and 8 words; blank uses rotation |

Invalid settings fail startup rather than silently creating a tight loop. Discovery uses existing Scout → Investigator → Curator → Planner → Approver orchestration with **`human_review` hardcoded**. Sources are fixed to `arxiv,github,government,news`; Reddit is excluded. Legacy `DISCOVERY_SOURCES`, `DISCOVERY_LIMIT`, and `DISCOVERY_REVIEW_MODE` do not override the worker. Results per search are bounded, not a total token/spend cap: investigation can issue further searches and the sweep checks every eligible selected project sequentially. Human selection/publication remains required; the worker never publishes a proposal.

### Scheduling, recovery, and limitations

Both worker and admin initialize the cached repository schema and private, RLS-enabled `worker_state` and `search_cycles` tables at startup (DDL permissions required), before holding work locks. No schema DDL occurs on ticks or status reads. One stable PostgreSQL **transaction-scoped advisory try lock** `(1196771660, 1)` covers tracked-attempt settlement, manual-cycle recovery/execution, and the due checks and awaited automatic discovery/revalidation jobs. `sql.begin` pins that transaction's connection, including with a transaction-mode pooler; jobs, short state reads, and durable checkpoint writes use the remaining connections in the existing five-connection pool. Losing workers skip the tick, and a single process never overlaps its own ticks. Startup table setup and enqueue use separate short advisory locks; enqueue never waits for the long work lock.

Due checks use the **database clock** and each job's persisted `worker_state` activity, not unrelated pipeline-run creation times. Revalidation has its own sweep checkpoint (including empty fleets and no-evidence/failing sweeps), then considers each selected, nonarchived, unfinished project's latest verifier `checkedAt`. Missing activity is immediately due; future activity defers work. Attempts are durably checkpointed **before paid work**, outside the lock transaction, and again after completion/failure for a full cooldown. Missed intervals are not replayed. Failed projects do not block the rest of a sweep. Completed verification archives only that project and appends its evidence-backed history; inconclusive verification preserves lifecycle status.

After interruption of automatic discovery, the next worker holding the shared lock settles **only its atomically tracked pending run**: an unfinished queued/running run is marked failed, partial artifacts remain, additions and the circuit breaker are reconciled, and a full cooldown is checkpointed before another batch. Manual-cycle recovery separately settles only runs atomically linked to that started cycle. Neither worker nor admin performs global interrupted-run recovery or replays stale runs. Heartbeats continue during long batches but indicate process health, not successful progress; inspect the tracked run, pause reason, and logs too.

**Operations and limitations:**

- Prefer one supervised worker process on one awake machine. It runs only while the machine is awake and the process is alive; after sleep it checks once, not once per missed interval. The admin/API is separate: `npm run admin` does not enable recurring work. GitHub Pages cannot run either backend process.
- **Do not run the worker and legacy run-once/CLI discovery or revalidation jobs simultaneously.** Those jobs do not participate in this advisory lock or the worker's target/pause controls. Multiple workers must share one database and lock key, preferably identical settings; this is not a distributed exactly-once job queue.
- Keep the database/pooler connection alive for the longest job. The lock transaction disables its local `idle_in_transaction_session_timeout`; configure any server `transaction_timeout`, pooler transaction/lifetime limits, and hosting shutdown limits accordingly. A network partition or externally terminated transaction can release the lock while an already-sent model request is still running; checkpoints reduce duplicate retries but cannot fence that external request. No hard cancellation or automatic stale-run replay is attempted.
- `SIGINT`/`SIGTERM` clears the pending timer, prevents further jobs/projects, waits for in-flight work, releases the transaction, then closes the database. The pipeline checks continuation between stages; already-sent requests are not cancelled. Allow enough shutdown grace; forced termination can leave the tracked run queued/running for settlement on the next lock acquisition.
- Verification persistence re-reads and row-locks its project after the model response to preserve committed human edits. The publication review path also reads and updates the project under a row lock. Other writers that do a stale read followed by a whole-payload write still need their own concurrency control for a full concurrent-edit guarantee.
- Startup/schema errors exit nonzero; tick/job errors are logged, with automatic discovery subject to polling, cooldown, and sticky pauses. Failed/interrupted manual cycles need a new explicit request, not automatic replay. Monitor the service/logs plus `/api/state`, `pipeline_runs`, `worker_state`, and `search_cycles`. Schedule unit tests are offline; live PostgreSQL failover/pooler behavior is not covered by those tests.

### Manual pause clear: explicit operator reassessment only

First diagnose the pause using logs and the tracked pipeline run; review the current count, target, source/model failures, and whether more paid discovery is appropriate. **Only an operator deliberately authorizing resumed discovery should run this command; never put it in startup, cron, or a retry loop.**

Wait for the worker to be idle, unload the service using the stop command above, and confirm any in-flight work has finished and `/api/state` reports `worker.attemptPending = false`. If an attempt remains pending after a crash, allow the worker's lock-protected tracked-run settlement to resolve it before reassessing; do not force-clear state or invoke global recovery. Stop any other worker sharing this database as well.

From the repository root, with the normal private environment credentials available:

```sh
cd /Users/taylorolsen-vogt/Guild
/opt/homebrew/bin/node --import tsx --input-type=module <<'NODE'
import "dotenv/config";
const { closeDatabase } = await import("./db/repository.ts");
try {
	const { clearWorkerPause } = await import("./db/worker-state.ts");
	await clearWorkerPause();
	console.log("Discovery pause cleared after explicit operator reassessment.");
} finally {
	await closeDatabase();
}
NODE
```

`clearWorkerPause()` initializes state before taking the same advisory try lock and refuses to clear while work owns that lock or a discovery attempt is unfinished. It clears the pause, no-progress counter, and error summary, but **does not change the target, brief cursor, or cooldown**. Restart with the service start command only when ready to resume. If the goal is still satisfied, discovery pauses again on its next goal check. There is no automatic reset or user-facing pause-clear endpoint.

### Legacy run-once commands (not the installed schedule)

These remain available for deliberate manual use **only with all workers stopped**; they bypass worker goal/pause safeguards and are not a way to clear a pause:

```sh
npm run scheduled:discover -- --mode human_review
npm run scheduled:revalidate
```

The legacy discovery command still uses a date-based brief when no query is supplied; that is separate from the installed worker's durable per-batch rotation. Keep human review enabled. Revalidation records evidence-backed lifecycle findings and archives completed projects rather than deleting their history. The removed daily/weekly cron schedule is not the current operating setup.

The internal `artifacts`, `pipeline_runs`, `worker_state`, and `search_cycles` tables have Row Level Security enabled with no browser policies. The admin and worker access them through the private server-side `DATABASE_URL`; do not expose that connection string in frontend code. GitHub Pages cannot host these processes; multi-user deployment requires a separately hosted, authenticated admin/API.

Curator applies a transparent mission gate before Planner. A problem must create frontier capability, be broadly reusable, have engineering/R&D at its core, be feasible for Guild contributors, and not primarily be routine delivery or compliance. Problems marked `not_aligned` or `uncertain` remain in the internal research history but do not produce or surface active proposals. Reassess existing records with `npm run mission:assess`.

The original local database can be imported idempotently with `npm run db:migrate:sqlite`. This command is only for migration and is not used by the running application.