import { XMLParser } from "fast-xml-parser";
import { createEvidence, type Evidence } from "../schemas/evidence.js";
import type { SourceAdapter, SourceSearchOptions } from "./types.js";

interface NewsItem {
  title?: string;
  link?: string;
  description?: string;
  pubDate?: string;
  source?: string | { "#text"?: string };
}

export const newsAdapter: SourceAdapter = {
  name: "news",
  async search({ query, limit }: SourceSearchOptions): Promise<Evidence[]> {
    const url = new URL("https://news.google.com/rss/search");
    url.searchParams.set("q", query);
    url.searchParams.set("hl", "en-US");
    url.searchParams.set("gl", "US");
    url.searchParams.set("ceid", "US:en");

    const response = await fetch(url, { headers: { "user-agent": "the-engineers/0.1" } });
    if (!response.ok) throw new Error(`Google News returned ${response.status}`);
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(await response.text()) as {
      rss?: { channel?: { item?: NewsItem | NewsItem[] } };
    };
    const rawItems = parsed.rss?.channel?.item;
    const items = rawItems ? (Array.isArray(rawItems) ? rawItems : [rawItems]) : [];

    return items.slice(0, limit).flatMap((item) => {
      if (!item.title || !item.link) return [];
      const publisher = typeof item.source === "string"
        ? item.source
        : item.source?.["#text"] ?? "Google News";
      return [createEvidence({
        url: item.link,
        title: clean(item.title),
        publisher: clean(publisher),
        sourceType: "news_report",
        observedAt: new Date().toISOString(),
        ...(item.pubDate ? { publishedAt: new Date(item.pubDate).toISOString() } : {}),
        excerpt: clean(item.description ?? item.title),
        adapter: this.name,
        query,
      })];
    });
  },
};

function clean(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}