// Presentation only. Publication decisions and safety checks remain server-side.
export function projectGroup(project, missionStatus) {
  const eligible = project.agentReview?.decision === "approved"
    && project.status !== "archived" && project.lifecycleStatus !== "completed";
  if (eligible && project.decision === "selected") return "published";
  if (eligible && project.decision === "pending" && missionStatus === "aligned") return "review";
  return "other";
}

export function projectStatus(project, missionStatus) {
  const group = projectGroup(project, missionStatus);
  if (group === "published") return "Published";
  if (group === "review") return "Ready to review";
  if (project.lifecycleStatus === "completed") return "Completed";
  if (project.status === "archived" || project.decision === "rejected" || project.agentReview?.decision === "rejected") return "Not selected";
  return "Needs more work";
}

export function searchStatus(data) {
  const worker = data.worker;
  const age = Date.parse(data.generatedAt) - Date.parse(worker?.heartbeatAt ?? "");
  const online = Number.isFinite(age) && age >= 0 && age < 180_000;
  const cycle = (data.cycles ?? []).find((item) => item.status === "queued" || item.status === "running");
  if (cycle && !online) return { disabled: true, label: "Search waiting", message: cycle.status === "queued"
    ? "Your search is queued, but the search service is offline. It can start when the service is back."
    : "The search service is offline. This search may have stopped; check its result when the service is back before requesting another." };
  if (cycle) return { disabled: true, label: cycle.status === "running" ? "Searching…" : "Search queued", message: cycle.status === "running" ? "Looking for useful projects. Results will appear here when ready." : "Your search is queued. Results will appear here when ready." };
  if (!online) return { disabled: true, label: "Run search", message: "The search service is offline. You can still review and publish existing projects." };
  if (worker.attemptPending) return { disabled: false, label: "Run search", message: "An automatic search is running. A new search will wait for it to finish." };
  if (worker.pausedReason === "goal_reached") return { disabled: false, label: "Run search", message: "The project list has reached its search limit. Review the existing plans; new searches can still assess ideas." };
  if (worker.pausedReason === "no_progress") return { disabled: false, label: "Run search", message: "Automatic search is paused because recent searches found no new projects. You can run another search." };
  return { disabled: false, label: "Run search", message: "Ready to search. New plans will appear under To review after they have been checked." };
}

export function resultStatus(result) {
  if (result.status === "failed" || result.status === "interrupted") return "Search incomplete";
  if (result.status === "skipped") return result.assessment ? "Checked · no plan created" : "Not checked";
  if (result.status === "pending") return "Waiting";
  if (result.status === "searching") return "Searching";
  if (result.status === "running") return "Preparing a plan";
  return { propose: "Worth developing", do_not_add: "Not recommended", needs_evidence: "Need more information" }[result.assessment?.recommendation]
    ?? (result.status === "completed" ? "Search finished" : "Reviewing");
}

export function cycleSummary(cycle) {
  if (!cycle) return "No searches yet";
  if (cycle.status === "queued") return "Waiting to start";
  if (cycle.status === "running") {
    const finished = cycle.results.filter((result) => ["completed", "failed", "interrupted", "skipped"].includes(result.status)).length;
    return cycle.profile === "image_review" ? `${finished} of ${cycle.results.length} ideas checked` : "Search in progress";
  }
  const count = new Set(cycle.projectIds ?? []).size;
  const incomplete = cycle.status === "failed" || cycle.results.some((result) => ["failed", "interrupted"].includes(result.status));
  const outcome = count ? `${count} draft plan${count === 1 ? "" : "s"} created` : "No new plans";
  return incomplete ? `Search incomplete · ${outcome.toLowerCase()}` : outcome;
}