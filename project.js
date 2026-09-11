import { difficultyBadge, difficultyDescription, difficultyLabel, loadProject } from "./project-ui.js";

const root = document.querySelector("#project-detail");
const params = new URLSearchParams(location.search);
const projectId = params.get("id");
const isPreview = params.get("preview") === "1";
const tabNames = ["Overview", "Tasks", "Design", "Requirements", "Build", "Test", "Evidence"];
document.querySelector("#project-preview-notice").hidden = !isPreview;
if (isPreview) {
  const robots = document.createElement("meta");
  robots.name = "robots";
  robots.content = "noindex, nofollow";
  document.head.append(robots);
}

try {
  const project = await loadProject(projectId, { preview: isPreview });
  if (project) {
    document.title = `${isPreview ? "Unpublished preview · " : ""}${project.title} · The Engineers`;
    render(project);
  } else {
    root.replaceChildren(backLink(), element("h1", "", "Project not found"), element("p", "project-summary", isPreview
      ? "This preview is unavailable or the link is incomplete. Open the project from the local admin page."
      : "This project has not been published, or the link is incomplete."));
  }
} catch (error) {
  root.replaceChildren(backLink(), element("h1", "", isPreview ? "Preview unavailable" : "Project unavailable"), element("p", "project-summary", isPreview
    ? "Previews are only available through the local admin page. Return there or reload the page to try again."
    : "Could not load this project. Reload the page to try again."));
  console.error(error);
} finally {
  root.setAttribute("aria-busy", "false");
}

function render(project) {
  const tasks = project.tasks ?? [];
  const milestones = project.milestones ?? [];
  const evidence = project.evidence ?? [];
  const taskById = new Map(tasks.map((item) => [item.id, item]));
  const milestoneById = new Map(milestones.map((item) => [item.id, item]));
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const tabs = element("div", "project-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Project plan");
  const panels = new Map();
  const buttons = new Map();

  function activate(id, { focus = false, updateHash = true } = {}) {
    if (!panels.has(id)) id = "overview";
    panels.forEach((panel, key) => {
      const selected = key === id;
      panel.hidden = !selected;
      buttons.get(key).setAttribute("aria-selected", String(selected));
      buttons.get(key).tabIndex = selected ? 0 : -1;
    });
    if (updateHash) history.replaceState(null, "", `#${id}`);
    if (focus) buttons.get(id).focus();
  }

  function jump(label, id, targetId) {
    const button = element("button", "text-button", label);
    button.type = "button";
    button.addEventListener("click", () => {
      activate(id, { focus: !targetId });
      const target = targetId ? document.getElementById(targetId) : panels.get(id);
      if (targetId && target) {
        history.replaceState(null, "", `#${targetId}`);
        target.focus();
      }
      target?.scrollIntoView({ block: "nearest" });
    });
    return button;
  }

  tabNames.forEach((name, index) => {
    const id = name.toLowerCase();
    const button = element("button", "", name);
    button.type = "button";
    button.id = `tab-${id}`;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", id);
    button.addEventListener("click", () => activate(id));
    button.addEventListener("keydown", (event) => {
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % tabNames.length;
      if (event.key === "ArrowLeft") next = (index + tabNames.length - 1) % tabNames.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = tabNames.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      activate(tabNames[next].toLowerCase(), { focus: true });
    });
    const panel = element("section", "project-panel");
    panel.id = id;
    panel.tabIndex = 0;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", button.id);
    buttons.set(id, button);
    panels.set(id, panel);
    tabs.append(button);
  });

  const intro = element("header", "project-intro");
  intro.append(element("p", "project-domain", "Project plan"), element("h1", "", project.title), element("p", "project-summary", project.executiveSummary));
  const categories = element("div", "project-chips");
  categories.setAttribute("aria-label", "Project categories");
  (project.categories ?? []).forEach((category) => categories.append(element("span", "", category)));
  if (categories.childElementCount) intro.append(categories);
  const metadata = element("div", "project-meta");
  metadata.append(element("span", "", "Build difficulty"), difficultyBadge(project.difficulty), element("span", "", countLabel(tasks.length, "task")));
  intro.append(metadata);
  intro.append(disclosure("About build difficulty", [
    element("p", "", `${difficultyDescription(project.difficulty)} Difficulty is for the whole build. You can contribute to individual tasks.`),
    ...(project.difficulty?.rationale ? [element("p", "", project.difficulty.rationale)] : []),
  ]));
  const start = jump(tasks.length ? "Start with a task →" : "View task instructions →", "tasks");
  start.className = "button button-primary";
  intro.append(start);
  const hero = element("div", "project-hero");
  const visual = designPlaceholder(project.blueprint.components ?? []);
  visual.querySelector("figcaption").append(jump("Read component details →", "design"));
  hero.append(visual, intro);

  const overview = panels.get("overview");
  overview.classList.add("project-overview");
  const narrative = element("div", "overview-narrative");
  narrative.append(
    card("Why it matters", [element("p", "", project.rationale), labeledText("Who it helps", (project.beneficiaries ?? []).join(" · ")), jump("Read the requirements →", "requirements")]),
    card("The plan", [element("p", "", project.objective), list((project.approach ?? []).slice(0, 3).map((item) => preview(item, 200)), "ol"), jump("Read the design →", "design")]),
  );
  const snapshot = element("aside", "overview-snapshot");
  const facts = element("dl", "build-snapshot");
  facts.append(
    fact("Build difficulty", difficultyLabel(project.difficulty)),
    fact("Components", String(project.blueprint.components.length)),
    fact("Tasks", String(tasks.length)),
    fact("Milestones", String(milestones.length)),
    fact("Expected results", String(project.deliverables.length)),
    fact("Sources", String(evidence.length)),
  );
  snapshot.append(card("At a glance", [element("p", "snapshot-note", "From this project plan."), facts, jump("Build steps & milestones →", "build"), jump("Tests & expected results →", "test")]));
  const firstTask = tasks.find((task) => task.status === "proposed" && !task.dependencyTaskIds?.length) ?? tasks[0];
  if (firstTask) snapshot.append(card("Find your first task", [element("p", "", firstTask.title), element("p", "snapshot-note", `${firstTask.discipline} · ${firstTask.status.replaceAll("_", " ")}`), jump("Read task steps & what to do first →", "tasks", `task-${firstTask.id}`)]));
  overview.append(narrative, snapshot);

  panels.get("requirements").append(
    card("Summary & goal", [labeledText("Summary", project.executiveSummary), labeledText("Goal", project.objective), labeledText("Why it matters", project.rationale), labeledList("Who it helps", project.beneficiaries)]),
    card("What this project covers", [labeledList("Included", project.scope.included), labeledList("Not included", project.scope.excluded), labeledList("Limits", project.constraints)]),
    card("Before you start", [labeledList("What you need", project.resourceNeeds), labeledList("Do first", project.blueprint.prerequisites)]),
    card("Open questions & risks", [labeledList("What we don't know yet", project.unknowns), ...project.risks.map((risk) => record(risk.description, [labeledText("How to reduce the risk", risk.mitigation)]))]),
  );
  panels.get("design").append(
    card("Design plan", [element("p", "", project.blueprint.overview), labeledList("How it will work", project.approach, true)]),
    card("Components", project.blueprint.components.map((item) => record(item.name, [element("p", "", item.purpose), labeledList("Connections", item.interfaces)]))),
  );
  panels.get("build").append(
    card("Build steps", [labeledList("Do first", project.blueprint.prerequisites), list(project.blueprint.buildSequence, "ol")]),
    card("Milestones", milestones.map((milestone, index) => record(`${index + 1}. ${milestone.title}`, [
      element("p", "", milestone.objective), labeledList("Done when", milestone.successCriteria),
      labeledNodes("Tasks", tasks.filter((task) => task.milestoneId === milestone.id).map((task) => jump(task.title, "tasks", `task-${task.id}`))),
    ]))),
  );
  panels.get("test").append(
    card("How to test it", [list(project.blueprint.validationPlan, "ol"), labeledList("How to measure success", project.successMetrics)]),
    card("Expected results", project.deliverables.map((item) => record(item.title, [element("p", "", item.description), labeledList("Done when", item.acceptanceCriteria)]))),
  );

  function evidenceReferences(ids) {
    return labeledNodes("Sources", (ids ?? []).map((id) => evidenceById.has(id)
      ? jump(evidenceById.get(id).title, "evidence", `evidence-${id}`)
      : element("span", "", `Source unavailable (${id})`)));
  }

  const taskPanel = panels.get("tasks");
  taskPanel.append(element("h2", "panel-heading", "Task instructions"));
  tasks.forEach((task, index) => {
    const metadata = element("dl", "task-metadata");
    metadata.append(fact("Area of work", task.discipline), fact("Status", task.status), fact("Milestone", milestoneById.get(task.milestoneId)?.title ?? `Milestone unavailable (${task.milestoneId})`));
    const article = record(`${index + 1}. ${task.title}`, [
      metadata, element("p", "", task.description),
      labeledList("Steps", task.instructions, true),
      labeledList("What you need", task.inputs), labeledList("What you'll produce", task.outputs),
      labeledList("Done when", task.completionCriteria),
      labeledNodes("Do first", (task.dependencyTaskIds ?? []).map((id) => taskById.has(id)
        ? jump(taskById.get(id).title, "tasks", `task-${id}`)
        : element("span", "", `Task unavailable (${id})`))),
      evidenceReferences(task.evidenceIds),
    ]);
    article.classList.add("task-detail");
    article.id = `task-${task.id}`;
    article.tabIndex = -1;
    taskPanel.append(article);
  });
  if (!tasks.length) taskPanel.append(element("p", "", "No tasks are published for this project."));

  const evidencePanel = panels.get("evidence");
  evidencePanel.append(element("h2", "panel-heading", "Evidence"));
  evidence.forEach((item) => {
    const source = safeSource(item);
    const article = record(item.title, [source]);
    article.classList.add("evidence-record");
    article.id = `evidence-${item.id}`;
    article.tabIndex = -1;
    if (item.excerpt) article.append(element("p", "", item.excerpt));
    evidencePanel.append(article);
  });
  if (!evidence.length) evidencePanel.append(element("p", "", "No public source links are available."));
  const missingEvidence = (project.evidenceIds ?? []).filter((id) => !evidenceById.has(id));
  if (missingEvidence.length) evidencePanel.append(labeledList("Sources not available", missingEvidence));
  if (project.lifecycleStatus || project.verificationHistory?.length) {
    const checks = disclosure("Automated checks", [
      element("p", "", "Internal review records, not a record of contributor progress."),
    ]);
    if (project.lifecycleStatus) checks.append(labeledText("Recorded status", project.lifecycleStatus.replaceAll("_", " ")));
    if (project.verificationHistory?.length) checks.append(card("Check history", project.verificationHistory.map((item) => record(item.status.replaceAll("_", " "), [
      element("p", "", item.summary), labeledText("Checked", item.checkedAt), evidenceReferences(item.evidenceIds),
    ]))));
    evidencePanel.append(checks);
  }
  if (project.agentReview) evidencePanel.append(disclosure("Automated plan review", [
    labeledText("Decision", project.agentReview.decision),
    ...(project.agentReview.rationale ? [labeledText("Why this decision", project.agentReview.rationale)] : []),
    labeledList("Findings", project.agentReview.findings),
    ...(project.agentReview.reviewedAt ? [labeledText("Reviewed", project.agentReview.reviewedAt)] : []),
  ]));

  root.replaceChildren(backLink(), hero, tabs, ...panels.values());
  function fromHash() {
    const hash = location.hash.slice(1);
    const targetPanel = hash.startsWith("task-") ? "tasks" : hash.startsWith("evidence-") ? "evidence" : hash;
    activate(targetPanel, { updateHash: false });
    if (hash !== targetPanel) {
      const target = document.getElementById(hash);
      target?.focus();
      target?.scrollIntoView({ block: "nearest" });
    }
  }
  window.addEventListener("hashchange", fromHash);
  fromHash();
}

function safeSource(item) {
  let url;
  try { url = new URL(item.url); } catch { /* Invalid sources remain readable, never clickable. */ }
  if (!url || !["https:", "http:"].includes(url.protocol)) return element("p", "", `${item.publisher || "Source"} · Public link unavailable`);
  const link = element("a", "evidence-link", `${item.publisher || url.hostname} ↗`);
  link.href = url.href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.setAttribute("aria-label", `${item.title} — ${item.publisher || url.hostname} (opens in a new tab)`);
  return link;
}

function designPlaceholder(components) {
  const figure = element("figure", "project-design-surface");
  figure.append(element("p", "design-surface-label", "Project plan · no drawings supplied"));
  const pending = element("div", "design-media-pending");
  pending.append(element("p", "design-pending-title", "No photos or drawings supplied"), element("p", "", "This plan does not include project photos, computer-aided design (CAD) files, or engineering drawings."));
  const caption = element("figcaption", "design-inventory");
  caption.append(element("p", "design-inventory-label", "Planned components · not CAD"));
  const inventory = element("ol", "");
  components.slice(0, 3).forEach((component) => {
    const item = element("li", "");
    item.append(element("strong", "", component.name), element("span", "", preview(component.purpose, 100)));
    inventory.append(item);
  });
  caption.append(inventory, element("p", "design-inventory-count", components.length
    ? `${countLabel(components.length, "component")} described in the plan${components.length > 3 ? ` · ${components.length - 3} more in Design` : ""}`
    : "No components listed."));
  figure.append(pending, caption);
  return figure;
}

function countLabel(count, noun) { return `${count} ${noun}${count === 1 ? "" : "s"}`; }
function preview(text, length = 230) {
  if (!text || text.length <= length) return text || "";
  const clipped = text.slice(0, length);
  const boundary = clipped.lastIndexOf(" ");
  return `${boundary > length / 2 ? clipped.slice(0, boundary) : clipped}…`;
}
function backLink() { const node = element("a", "project-back", "← Back to projects"); node.href = "projects.html"; return node; }
function card(title, children) { const node = element("section", "project-card"); node.append(element("h2", "", title), ...children); return node; }
function record(title, children) { const node = element("article", "project-record"); node.append(element("h3", "", title), ...children); return node; }
function disclosure(title, children) { const node = element("details", "project-disclosure"); node.append(element("summary", "", title), ...children); return node; }
function labeledText(title, text) { const node = element("div", "project-list-group"); node.append(element("h3", "field-label", title), element("p", "", text)); return node; }
function labeledList(title, items = [], ordered = false) { return labeledNodes(title, items, ordered); }
function labeledNodes(title, items = [], ordered = false) { const node = element("div", "project-list-group"); node.append(element("h4", "field-label", title), items.length ? list(items, ordered ? "ol" : "ul") : element("p", "", "None listed.")); return node; }
function list(items = [], tag = "ul") { const node = element(tag, ""); items.forEach((item) => { const li = element("li", ""); li.append(typeof item === "string" ? document.createTextNode(item) : item); node.append(li); }); return node; }
function fact(label, value) { const group = element("div", "snapshot-row"); group.append(element("dt", "", label), element("dd", "", value)); return group; }
function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }