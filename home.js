import { difficultyBadge, loadPublishedProjects } from "./project-ui.js";

const container = document.querySelector("#featured-projects");
try {
  const projects = await loadPublishedProjects();
  if (projects.length === 0) {
    message("No projects have been published yet.");
  } else {
    container.replaceChildren(...projects.slice(0, 5).map(projectCard));
  }
} catch (error) {
  message("Could not load projects. Reload the page to try again.");
  console.error(error);
} finally {
  container.setAttribute("aria-busy", "false");
}

function projectCard(project, index) {
  const card = document.createElement("a");
  card.className = "featured-project";
  card.href = `project.html?id=${encodeURIComponent(project.id)}`;
  const copy = document.createElement("div");
  copy.className = "featured-project-copy";

  const meta = document.createElement("div");
  meta.className = "featured-project-meta";
  if (project.categories?.length) {
    const category = document.createElement("span");
    category.className = "featured-project-category";
    category.textContent = project.categories[0];
    meta.append(category);
  }
  const difficulty = document.createElement("span");
  difficulty.className = "featured-project-difficulty";
  difficulty.append("Build difficulty ", difficultyBadge(project.difficulty));
  meta.append(difficulty);

  const title = document.createElement("h3");
  title.id = `featured-project-title-${index}`;
  title.textContent = project.title;
  card.setAttribute("aria-labelledby", title.id);
  const summary = document.createElement("p");
  summary.className = "featured-project-summary";
  summary.textContent = project.executiveSummary;
  copy.append(meta, title, summary);

  const footer = document.createElement("div");
  footer.className = "featured-project-footer";
  const facts = document.createElement("span");
  facts.textContent = `${countLabel(project.tasks.length, "task")} · ${countLabel(project.milestones.length, "milestone")}`;
  const action = document.createElement("span");
  action.className = "featured-project-action";
  action.textContent = "View project →";
  footer.append(facts);
  copy.append(footer);
  card.append(copy, action);
  return card;
}

function countLabel(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function message(text) {
  const node = document.createElement("p");
  node.className = "home-work-empty";
  node.textContent = text;
  container.replaceChildren(node);
}