import { createEvidence, type Evidence } from "../schemas/evidence.js";
import type { SourceAdapter, SourceSearchOptions } from "./types.js";

interface RedditPost {
  title: string;
  selftext: string;
  permalink: string;
  subreddit_name_prefixed: string;
  created_utc: number;
}

export const redditAdapter: SourceAdapter = {
  name: "reddit",
  async search({ query, limit }: SourceSearchOptions): Promise<Evidence[]> {
    const url = new URL("https://www.reddit.com/search.json");
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("sort", "new");

    const response = await fetch(url, { headers: { "user-agent": "the-engineers/0.1" } });
    if (!response.ok) throw new Error(`Reddit returned ${response.status}`);
    const payload = (await response.json()) as {
      data?: { children?: Array<{ data: RedditPost }> };
    };

    return (payload.data?.children ?? []).map(({ data }) => createEvidence({
      url: `https://www.reddit.com${data.permalink}`,
      title: data.title,
      publisher: data.subreddit_name_prefixed,
      sourceType: "community_report",
      observedAt: new Date().toISOString(),
      publishedAt: new Date(data.created_utc * 1_000).toISOString(),
      excerpt: truncate(data.selftext || data.title),
      adapter: this.name,
      query,
    }));
  },
};

function truncate(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 2_000);
}