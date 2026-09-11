const levels = {
  easy: { label: "Easy", description: "Hobbyist-friendly. Basic tools, readily available materials, and step-by-step instructions." },
  medium: { label: "Medium", description: "Some practical experience, specialist tools, or integration work needed." },
  hard: { label: "Hard", description: "Advanced engineering, research, professional equipment, or demanding validation. Everyone can contribute." },
};

export function difficultyLabel(difficulty) {
  return levels[difficulty?.level]?.label ?? "Not yet assessed";
}

export function difficultyDescription(difficulty) {
  return levels[difficulty?.level]?.description ?? "The build difficulty has not been assessed yet.";
}

export function difficultyBadge(difficulty) {
  const level = levels[difficulty?.level];
  const badge = document.createElement("span");
  badge.className = `difficulty-badge ${level ? difficulty.level : "unassessed"}`;
  badge.textContent = level?.label ?? "Difficulty pending";
  badge.title = level?.description || "The build difficulty has not been assessed yet.";
  return badge;
}

export async function loadPublishedProjects() {
  const response = await fetch("/api/public/projects", { cache: "no-store" });
  if (!response.ok) throw new Error(`Project service unavailable (${response.status})`);
  const { projects } = await response.json();
  if (!Array.isArray(projects)) throw new Error("Invalid public project response");
  return projects;
}

// Preview is an explicit, local-operations-only contract. Never fall back between
// private preview and public data: both use the same renderer, not the same API.
export async function loadProject(id, { preview = false } = {}) {
  if (!id) return null;
  if (!preview) return (await loadPublishedProjects()).find((project) => project.id === id) ?? null;
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}/preview`, { cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Project preview unavailable (${response.status})`);
  const { project } = await response.json();
  if (!project || project.id !== id) throw new Error("Invalid project preview response");
  return project;
}