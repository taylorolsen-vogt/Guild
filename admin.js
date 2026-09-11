import { cycleSummary, projectGroup, projectStatus, resultStatus, searchStatus } from "./admin-view.js";

const state = { data: null, filter: "review", openProposalIds: new Set(), openResultIds: new Set(), reviewers: new Map(), reviewMessages: new Map(), submitting: new Set(), requesting: false, loadError: false };
const runSearchButton = document.querySelector("#run-search");
const runMessage = document.querySelector("#run-message");

document.querySelectorAll(".filter").forEach((button) => {
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    document.querySelectorAll(".filter").forEach((item) => {
      item.classList.toggle("active", item === button);
      item.setAttribute("aria-pressed", String(item === button));
    });
    renderProposals();
  });
});

runSearchButton?.addEventListener("click", async () => {
  if (!runSearchButton || state.requesting) return;
  state.requesting = true;
  runSearchButton.disabled = true;
  runSearchButton.textContent = "Requesting search…";
  setRunMessage("Requesting a search…", "");
  try {
    const run = await request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: document.querySelector("#search-profile").value }),
    });
    setRunMessage(run.alreadyQueued ? "A search is already in progress. Its results will appear below." : "Search requested. Results will appear below; nothing is published automatically.", "success");
    document.querySelector("#search-results").open = true;
    await loadState();
  } catch (error) {
    setRunMessage("Could not request a search. Please try again.", "error");
    console.error(error);
  } finally {
    state.requesting = false;
    if (state.data) render();
    else runSearchButton.disabled = true;
  }
});

async function loadState() {
  try {
    state.data = await request("/api/state");
    if (state.loadError) document.querySelector("#operations-notice").textContent = "";
    state.loadError = false;
    render();
  } catch (error) {
    state.loadError = true;
    console.error(`Admin API unavailable: ${error.message}`);
    document.querySelector("#operations-notice").textContent = state.data
      ? "Could not refresh projects. Showing the last update; trying again shortly."
      : "Could not load projects. Please reload to try again.";
    if (!state.data) {
      document.querySelector("#worker-progress").textContent = "Search availability could not be checked.";
      document.querySelector("#proposals").replaceChildren(paragraph("Projects are unavailable right now."));
      document.querySelector("#search-summary").textContent = "Unavailable";
      document.querySelector("#search-cycles").replaceChildren(paragraph("Search results are unavailable right now."));
    }
  } finally {
    document.querySelector("#proposals").setAttribute("aria-busy", "false");
  }
}

function render() {
  const counts = proposalCounts();
  for (const [name, count] of Object.entries(counts)) {
    document.querySelector(`#filter-${name}`)?.replaceChildren(String(count));
  }
  const worker = state.data.worker;
  const search = searchStatus(state.data);
  if (runSearchButton) {
    runSearchButton.disabled = state.requesting || search.disabled;
    runSearchButton.textContent = state.requesting ? "Requesting search…" : search.label;
  }
  document.querySelector("#worker-progress").textContent = search.message;
  document.querySelector("#worker-details").textContent = worker
    ? `${worker.count} / ${worker.target} checked projects. Last service update: ${worker.heartbeatAt ? new Date(worker.heartbeatAt).toLocaleString() : "unavailable"}. Pause: ${worker.pausedReason ?? "none"}. Stage: ${worker.lastRunStage ?? "none"}.`
    : "Worker status unavailable.";
  renderRuns();
  renderCycles();
  renderProposals();
}

function resultProjectLinks(ids) {
  const links = element("div", "result-links");
  for (const id of ids) {
    const project = state.data.projects.find((item) => item.id === id);
    if (!project) continue;
    const link = element("a", "", `${project.title} · ${projectStatus(project, missionStatusForProject(project))}`);
    link.href = `project.html?id=${encodeURIComponent(id)}&preview=1`;
    links.append(link);
  }
  return links;
}

function renderCycles() {
  const container = document.querySelector("#search-cycles");
  const cycles = state.data.cycles ?? [];
  document.querySelector("#search-summary").textContent = cycleSummary(cycles[0]);
  if (container.contains(document.activeElement)) return;
  container.replaceChildren();
  if (!cycles.length) container.append(element("p", "empty", "Run a search to find projects worth building."));
  for (const [index, cycle] of cycles.entries()) {
    const article = element("article", "cycle-result");
    article.append(element("h3", "", cycle.profile === "image_review" ? "Five reference ideas" : "New project search"), paragraph(cycleSummary(cycle)));
    const date = element("time", "search-date", new Date(cycle.createdAt).toLocaleString());
    date.dateTime = cycle.createdAt;
    article.append(date);
    for (const result of cycle.results) {
      const details = element("details", "concept-result");
      const key = `${cycle.id}-${result.conceptId}`;
      details.open = state.openResultIds.has(key);
      details.addEventListener("toggle", () => details.open ? state.openResultIds.add(key) : state.openResultIds.delete(key));
      const summary = element("summary", "");
      summary.append(element("strong", "", result.title), badge(resultStatus(result)));
      details.append(summary);
      if (result.assessment) {
        details.append(assessmentField(result, "rationale", "Why"));
        const research = disclosure("Research and sources", `${key}-research`);
        for (const [field, label] of [["value", "Why it matters"], ["targetUsers", "Who it helps"], ["alternatives", "What already exists"], ["gap", "What still needs work"], ["feasibility", "Can we build it?"], ["duplicateSaturation", "Is someone already doing this?"]]) research.append(assessmentField(result, field, label));
        details.append(research);
      } else if (result.evidence.length) {
        const sources = disclosure("Sources found", `${key}-sources`);
        for (const evidence of result.evidence) {
          if (!/^https?:\/\//i.test(evidence.url)) continue;
          const link = element("a", "", evidence.title);
          link.href = evidence.url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          const item = paragraph("");
          item.append(link);
          sources.append(item);
        }
        details.append(sources);
      }
      if (["failed", "interrupted"].includes(result.status)) details.append(paragraph("This search did not finish. Its findings may be incomplete."));
      if (result.status === "skipped") details.append(paragraph(result.assessment ? "This idea was checked, but no plan was created. See details below for why." : "This idea was not checked. See details below for why."));
      if (result.warnings.length || result.error || result.status === "skipped") {
        const diagnostic = disclosure("Technical details", `${key}-errors`);
        diagnostic.append(list(result.warnings));
        if (result.error) diagnostic.append(paragraph(result.error));
        if (result.status === "skipped") diagnostic.append(paragraph(result.message));
        details.append(diagnostic);
      }
      if (result.runId) {
        const link = element("a", "", "Search history");
        link.href = `#run-${result.runId}`;
        link.addEventListener("click", () => { document.querySelector(".technical-details").open = true; });
        details.append(link);
      }
      details.append(resultProjectLinks(result.projectIds));
      article.append(details);
    }
    if (index === 0) container.append(article);
    else {
      const previous = disclosure(`Earlier search · ${new Date(cycle.createdAt).toLocaleDateString()}`, cycle.id);
      previous.append(article);
      container.append(previous);
    }
  }
}

function assessmentField(result, field, label) {
  const assessment = result.assessment[field];
  const block = element("div", "assessment-field");
  block.append(element("b", "", label), paragraph(assessment.text));
  for (const id of assessment.evidenceIds) {
    const evidence = result.evidence.find((item) => item.id === id);
    if (!evidence || !/^https?:\/\//i.test(evidence.url)) continue;
    const link = element("a", "", evidence.title);
    link.href = evidence.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    block.append(link);
  }
  return block;
}

function proposalCounts() {
  const counts = { review: 0, published: 0, other: 0 };
  for (const project of state.data.projects) counts[projectGroup(project, missionStatusForProject(project))] += 1;
  return counts;
}

function renderRuns() {
  const container = document.querySelector("#runs");
  container.replaceChildren();
  if (state.data.runs.length === 0) {
    container.append(element("p", "empty", "No runs yet."));
    return;
  }
  for (const run of state.data.runs) {
    const item = element("article", "run-item");
    item.id = `run-${run.id}`;
    const top = element("div", "run-top");
    const query = run.query.startsWith("[manual] ") ? `Manual cycle: ${run.query.replace("[manual] ", "")}` : run.query;
    top.append(element("p", "run-query", query), badge(run.status));
    item.append(top, element("p", "run-message", run.error || run.message));
    const meta = element("div", "run-meta");
    meta.append(
      element("span", "", run.stage),
      element("span", "", run.reviewMode.replace("_", " ")),
      element("span", "", `${run.artifactIds.evidence.length} sources · ${run.artifactIds.candidates.length} candidates · ${run.artifactIds.projects.length} plans`),
    );
    item.append(meta);
    if (run.warnings.length) {
      const warnings = element("details", "");
      warnings.append(element("summary", "", `${run.warnings.length} warnings`), list(run.warnings));
      item.append(warnings);
    }
    item.append(resultProjectLinks(run.artifactIds.projects));
    container.append(item);
  }
}

function renderProposals(force = false) {
  if (!state.data) return;
  const container = document.querySelector("#proposals");
  // Keep keyboard focus and unsent decisions intact while someone reads or reviews.
  if (!force && container.contains(document.activeElement)) return;
  if (state.submitting.size) return;
  container.replaceChildren();
  const proposals = state.data.projects.filter((project) => projectGroup(project, missionStatusForProject(project)) === state.filter);
  if (proposals.length === 0) {
    container.append(element("p", "empty", { review: "No projects waiting for review. Run a search to find more.", published: "No projects published yet. Review a plan and approve it to put it on the website.", other: "No projects set aside." }[state.filter]));
    return;
  }
  for (const project of proposals) container.append(proposalElement(project));
}

function proposalElement(project) {
  const problem = state.data.problems.find((item) => item.id === project.canonicalProblemId);
  const details = document.createElement("details");
  details.className = "proposal";
  details.dataset.projectId = project.id;
  details.open = state.openProposalIds.has(project.id);
  details.addEventListener("toggle", () => {
    if (details.open) state.openProposalIds.add(project.id);
    else state.openProposalIds.delete(project.id);
    details.querySelector(".plan-toggle").textContent = details.open ? "Close plan −" : "Review plan +";
  });
  const summary = document.createElement("summary");
  summary.className = "proposal-summary";
  const title = element("div", "proposal-title");
  title.append(element("h3", "", project.title), element("p", "", project.executiveSummary));
  const badges = element("div", "proposal-badges");
  badges.append(badge(projectStatus(project, missionStatusForProject(project))), element("span", "plan-toggle", details.open ? "Close plan −" : "Review plan +"));
  summary.append(title, badges);

  const body = element("div", "proposal-body");
  const review = disclosure("Research checks", `${project.id}-checks`);
  review.append(
    section("Does it fit the mission?", [paragraph(problem?.missionAlignment.rationale ?? "Not checked yet.")]),
    section("Plan check", [paragraph(project.agentReview.rationale ?? "Waiting for the plan to be checked."), list(project.agentReview.findings)]),
    verificationSection(project),
  );
  const fullPlan = disclosure("Full build plan", `${project.id}-plan`);
  fullPlan.append(
    twoColumn(section("Included", [list(project.scope.included)]), section("Not included", [list(project.scope.excluded)])),
    section("Design", [paragraph(project.blueprint.overview), subrecord("Before you start", "What you need", project.blueprint.prerequisites),
      ...project.blueprint.components.map((item) => subrecord(item.name, item.purpose, item.interfaces)),
      subrecord("Build steps", "Work in this order", project.blueprint.buildSequence), subrecord("How to test it", "Check the result", project.blueprint.validationPlan)]),
    section("Approach", [orderedList(project.approach)]),
    section("What we will produce", project.deliverables.map((item) => subrecord(item.title, item.description, item.acceptanceCriteria))),
    twoColumn(section("What we don't know yet", [list(project.unknowns)]), section("Limits", [list(project.constraints)])),
    section("Risks", project.risks.map((item) => subrecord(item.description, `How to reduce the risk: ${item.mitigation}`))),
    section("How we will measure success", [list(project.successMetrics)]),
    section("What we need", [list(project.resourceNeeds)]),
    section("Milestones", project.milestones.map((item, index) => subrecord(`${index + 1}. ${item.title}`, item.objective, item.successCriteria))),
    section("Tasks", project.tasks.map((item) => taskRecord(item, project.tasks))),
  );
  body.append(
    reviewBar(project),
    section("What we're building", [paragraph(project.objective)]),
    section("Why it matters", [paragraph(project.rationale)]),
    section("Who it helps", [list(project.beneficiaries)]),
    section("Difficulty", [paragraph(project.difficulty
      ? `${project.difficulty.level.toUpperCase()} — ${project.difficulty.rationale}`
      : "Not checked yet.")]),
    citationSection(project.evidenceIds),
    fullPlan,
    review,
  );
  details.append(summary, body);
  return details;
}

function missionStatusForProject(project) {
  return state.data.problems.find((item) => item.id === project.canonicalProblemId)?.missionAlignment.status ?? "unassessed";
}

function taskRecord(task, tasks) {
  const node = subrecord(task.title, `${task.discipline} — ${task.description}`);
  node.append(
    labeledList("Instructions", task.instructions, true),
    labeledList("What you need", task.inputs),
    labeledList("What you'll produce", task.outputs),
    labeledList("Done when", task.completionCriteria),
  );
  const dependencyNames = task.dependencyTaskIds
    .map((id) => tasks.find((candidate) => candidate.id === id)?.title)
    .filter(Boolean);
  if (dependencyNames.length) node.append(labeledList("Do first", dependencyNames));
  return node;
}

function labeledList(title, items, ordered = false) {
  const node = element("div", "task-detail");
  node.append(element("b", "", title), ordered ? orderedList(items) : list(items));
  return node;
}

function verificationSection(project) {
  if (project.verificationHistory.length === 0) {
    return section("Verification", [paragraph("Not yet checked against fresh sources.")]);
  }
  return section("Verification", project.verificationHistory.map((record) =>
    subrecord(`${record.status.replace("_", " ")} · ${new Date(record.checkedAt).toLocaleDateString()}`, record.summary),
  ));
}

function citationSection(ids) {
  const evidenceById = new Map(state.data.evidence.map((item) => [item.id, item]));
  const links = element("ul", "citation-list");
  for (const id of ids) {
    const evidence = evidenceById.get(id);
    const li = document.createElement("li");
    if (evidence) {
      const link = element("a", "", evidence.title);
      link.href = evidence.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      li.append(link);
    } else li.textContent = id;
    links.append(li);
  }
  return section("Sources", [links]);
}

function reviewBar(project) {
  const bar = element("div", "review-bar");
  const published = projectGroup(project, missionStatusForProject(project)) === "published";
  const preview = element("a", "review-preview", published ? "View on website ↗" : "Preview project ↗");
  preview.href = `project.html?id=${encodeURIComponent(project.id)}${published ? "" : "&preview=1"}`;
  preview.target = "_blank";
  preview.rel = "noopener";
  bar.append(preview);
  if (project.status === "archived" || project.lifecycleStatus === "completed" || project.agentReview.decision !== "approved") {
    bar.append(paragraph("This plan isn't ready to publish. See Research checks below for details."));
    return bar;
  }
  const reviewer = document.createElement("input");
  reviewer.placeholder = "Your name";
  reviewer.setAttribute("aria-label", "Your name");
  reviewer.maxLength = 100;
  reviewer.value = state.reviewers.get(project.id) ?? "";
  reviewer.addEventListener("input", () => state.reviewers.set(project.id, reviewer.value));
  const select = element("button", "select", "Approve and publish");
  const reject = element("button", "reject", "Set aside");
  const message = element("span", "review-message");
  message.setAttribute("role", "status");
  message.textContent = state.reviewMessages.get(project.id) ?? "";
  select.type = reject.type = "button";
  select.disabled = published;
  select.textContent = published ? "Published" : "Approve and publish";
  reject.textContent = published ? "Remove from website" : "Set aside";
  select.addEventListener("click", () => submitReview(project.id, "selected", reviewer.value));
  reject.addEventListener("click", () => submitReview(project.id, "rejected", reviewer.value));
  bar.append(reviewer, select, reject, message);
  return bar;
}

function setRunMessage(message, variant) {
  if (!runMessage) return;
  runMessage.className = variant ? `run-message ${variant}` : "run-message";
  runMessage.textContent = message;
}

async function submitReview(projectId, decision, reviewer) {
  if (state.submitting.has(projectId)) return;
  if (!reviewer.trim()) {
    setReviewMessage(projectId, "Enter your name first.");
    return;
  }
  const title = state.data.projects.find((project) => project.id === projectId)?.title ?? "this project";
  if (!confirm(decision === "selected" ? `Publish “${title}” on the website?` : `Set aside “${title}”? It will move to Not ready and will not appear on the website.`)) return;
  state.submitting.add(projectId);
  document.querySelectorAll(`[data-project-id="${projectId}"] .review-bar button`).forEach((button) => { button.disabled = true; });
  try {
    await request(`/api/projects/${projectId}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision, reviewer }),
    });
    setReviewMessage(projectId, decision === "selected" ? "Project published." : "Project set aside.");
    document.querySelector("#operations-notice").textContent = decision === "selected" ? `Published: ${title}` : `Set aside: ${title}`;
  } catch (error) {
    setReviewMessage(projectId, error.message);
  } finally {
    state.submitting.delete(projectId);
    await loadState();
    renderProposals(true);
  }
}

function setReviewMessage(projectId, message) {
  state.reviewMessages.set(projectId, message);
  const proposal = document.querySelector(`[data-project-id="${projectId}"]`);
  const target = proposal?.querySelector(".review-message");
  if (target) target.textContent = message;
}

function section(title, children) {
  const node = element("section", "proposal-section");
  node.append(element("h4", "", title), ...children);
  return node;
}
function disclosure(title, key) {
  const node = element("details", "more-details");
  node.open = state.openResultIds.has(key);
  node.append(element("summary", "", title));
  node.addEventListener("toggle", () => node.open ? state.openResultIds.add(key) : state.openResultIds.delete(key));
  return node;
}
function twoColumn(left, right) { const node = element("div", "two-col"); node.append(left, right); return node; }
function paragraph(text) { return element("p", "", text); }
function list(items) { const node = document.createElement("ul"); items.forEach((item) => node.append(element("li", "", item))); return node; }
function orderedList(items) { const node = document.createElement("ol"); items.forEach((item) => node.append(element("li", "", item))); return node; }
function subrecord(title, description, criteria = []) {
  const node = element("div", "subrecord");
  node.append(element("strong", "", title), paragraph(description));
  if (criteria.length) node.append(list(criteria));
  return node;
}
function badge(text) { return element("span", `badge ${text.replaceAll(" ", "_")}`, text); }
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function request(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

await loadState();
let pollTimer = setTimeout(poll, 10000);

document.addEventListener("visibilitychange", () => {
  clearTimeout(pollTimer);
  if (!document.hidden) {
    void loadState();
    pollTimer = setTimeout(poll, 10000);
  }
});

async function poll() {
  if (document.hidden) return;
  await loadState();
  pollTimer = setTimeout(poll, 10000);
}