import { difficultyBadge, loadPublishedProjects } from "./project-ui.js";

const state = { projects: [], category: "all", difficulty: "all", query: "" };
const list = document.querySelector("#project-list");
const total = document.querySelector("#project-total");
const filters = document.querySelector("#project-filters");
const search = document.querySelector("#project-search");
const difficulty = document.querySelector("#difficulty-filter");
const clear = document.querySelector("#clear-filters");
let loadFailed = false;
difficulty.addEventListener("change", (event) => {
  state.difficulty = event.target.value;
  renderProjects();
});

search.addEventListener("input", () => {
  state.query = search.value.trim().toLowerCase();
  renderProjects();
});

filters.addEventListener("change", () => {
  state.category = filters.value;
  renderProjects();
});

clear.addEventListener("click", () => {
  state.category = state.difficulty = "all";
  state.query = "";
  filters.value = difficulty.value = "all";
  search.value = "";
  renderProjects();
  search.focus();
});

try {
  state.projects = await loadPublishedProjects();
  renderFilters();
  renderProjects();
} catch (error) {
  loadFailed = true;
  total.textContent = "Projects unavailable";
  list.replaceChildren(empty("Could not load projects. Reload the page to try again."));
  console.error(error);
}

function renderFilters() {
  const categories = [...new Set(state.projects.flatMap((project) => project.categories ?? []))].sort();
  for (const category of categories) {
    const option = element("option", category);
    option.value = category;
    filters.append(option);
  }
}

function renderProjects() {
  clear.disabled = state.category === "all" && state.difficulty === "all" && !search.value;
  if (loadFailed) return;
  const projects = state.projects.filter((project) => {
    const categoryMatch = state.category === "all" || project.categories?.includes(state.category);
    const text = [project.title, project.executiveSummary, ...(project.categories ?? []), ...project.tasks.map((task) => task.discipline)].join(" ").toLowerCase();
    const difficultyMatch = state.difficulty === "all" || (project.difficulty?.level ?? "unassessed") === state.difficulty;
    return categoryMatch && difficultyMatch && text.includes(state.query);
  });
  total.textContent = `${projects.length} of ${state.projects.length} project${state.projects.length === 1 ? "" : "s"}`;
  list.replaceChildren();
  if (projects.length === 0) {
    list.append(empty(state.projects.length === 0 ? "No projects have been published yet." : "No projects match. Try a different search or clear the filters."));
    return;
  }
  for (const project of projects) list.append(projectRow(project));
}

function projectRow(project) {
  const link = document.createElement("a");
  link.className = "project-row";
  link.href = `project.html?id=${encodeURIComponent(project.id)}`;
  const copy = document.createElement("div");
  copy.className = "project-row-copy";
  const metadata = document.createElement("div");
  metadata.className = "project-row-meta";
  metadata.append(element("span", "Build difficulty"), difficultyBadge(project.difficulty));
  copy.append(element("h2", project.title), chips(project.categories ?? []), element("p", project.executiveSummary), metadata);
  const facts = document.createElement("dl");
  facts.className = "project-row-facts";
  facts.append(fact("Tasks", String(project.tasks.length)), fact("Milestones", String(project.milestones.length)));
  const aside = document.createElement("div");
  aside.className = "project-row-aside";
  const action = element("span", "View project →");
  action.className = "project-row-action";
  aside.append(facts, action);
  link.append(copy, aside);
  return link;
}

function chips(items) {
  const node = document.createElement("div");
  node.className = "project-chips";
  items.forEach((item) => node.append(element("span", item)));
  return node;
}

function fact(label, value) {
  const group = document.createElement("div");
  group.append(element("dt", label), element("dd", value));
  return group;
}

function empty(text) { const node = element("p", text); node.className = "project-empty"; return node; }
function element(tag, text) { const node = document.createElement(tag); node.textContent = text; return node; }