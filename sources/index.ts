import type { Evidence } from "../schemas/evidence.js";
import { arxivAdapter } from "./arxiv.js";
import { githubAdapter } from "./github.js";
import { governmentAdapter } from "./government.js";
import { newsAdapter } from "./news.js";
import { redditAdapter } from "./reddit.js";
import type { SourceAdapter } from "./types.js";

export const adapters: Record<string, SourceAdapter> = {
  arxiv: arxivAdapter,
  github: githubAdapter,
  government: governmentAdapter,
  news: newsAdapter,
  reddit: redditAdapter,
};

export async function searchSources(
  names: string[],
  query: string,
  limit: number,
): Promise<{ evidence: Evidence[]; warnings: string[] }> {
  const selected = names.map((name) => {
    const adapter = adapters[name];
    if (!adapter) throw new Error(`Unknown source adapter: ${name}`);
    return adapter;
  });
  const results = await Promise.allSettled(selected.map((adapter) => withTimeout(
    adapter.search({ query, limit }),
    30_000,
    `${adapter.name} timed out after 30 seconds`,
  )));
  const evidence: Evidence[] = [];
  const warnings: string[] = [];

  results.forEach((result, index) => {
    const adapterName = selected[index]?.name ?? "unknown";
    if (result.status === "fulfilled") evidence.push(...result.value);
    else warnings.push(`${adapterName}: ${String(result.reason)}`);
  });

  return { evidence: deduplicate(evidence), warnings };
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const rejection = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  try {
    return await Promise.race([promise, rejection]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function deduplicate(evidence: Evidence[]): Evidence[] {
  return [...new Map(evidence.map((item) => [item.contentHash, item])).values()];
}