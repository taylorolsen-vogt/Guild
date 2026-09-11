export const discoveryBriefs = [
  "buildable open energy systems: modular storage, power electronics, geothermal instruments, grid-forming controls, microreactor tooling, and open test equipment with a documented unmet need and a prototype a distributed engineering team can deliver",
  "open-source robotics and manufacturing equipment: field robots, inspection systems, machine tools, additive manufacturing, repairable automation, and low-cost production hardware that need a concrete new design rather than more research alone",
  "accessible human capability hardware: open prosthetics, rehabilitation devices, laboratory automation, diagnostic instruments, assistive robotics, and human-machine interfaces with unresolved engineering requirements and a realistic prototype path",
  "autonomous ocean, climate, and environmental instruments: reef and water monitors, sensor platforms, sampling robots, carbon measurement tools, and rugged edge systems that can become replicable open hardware",
  "space and extreme-environment hardware: power, sensing, communications, thermal systems, autonomous maintenance, and scientific payloads that can be decomposed into testable terrestrial prototypes",
  "open compute and scientific infrastructure: efficient AI hardware, photonics, cooling, distributed instruments, verification tools, and research equipment where contributors can build a reusable physical or software system",
  "future transportation and infrastructure tools: autonomous inspection, resilient construction systems, charging hardware, mobility robotics, and structural monitoring with a concrete build, field-test, and open documentation path",
] as const;

export function dailyDiscoveryBrief(date = new Date()): string {
  const epochDay = Math.floor(date.getTime() / 86_400_000);
  return discoveryBriefs[epochDay % discoveryBriefs.length]!;
}

// Search terms, not the long planning prompts above. GitHub ANDs terms and strips
// punctuation; arXiv prefixes all:, while government/news accept these plain terms.
// Single topics avoid adapter-specific Boolean syntax and overly restrictive prompts.
export const workerDiscoveryBriefs = [
  "microgrids", "robotics", "prosthetics", "oceanography",
  "spacecraft", "photonics", "infrastructure",
] as const;

export function discoveryBriefAt(cursor: number): string {
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Discovery cursor must be a nonnegative safe integer.");
  return workerDiscoveryBriefs[cursor % workerDiscoveryBriefs.length]!;
}

/** Worker-only follow-up searches: bounded keywords, not full model-written hypotheses. */
export function compactSourceQuery(text: string): string {
  const stopwords = new Set("a an the and or of for to in on at by with without is are be being has have that this these those need needs lack lacks low cost open source system systems project build develop completed deployed solved".split(" "));
  const words = (text.toLowerCase().match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? [])
    .filter((word) => word.length > 2 && !stopwords.has(word));
  return [...new Set(words)].slice(0, 3).join(" ").slice(0, 80) || "engineering";
}