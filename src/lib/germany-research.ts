import "server-only";

import {
  buildSearchQuery,
  needsCurrentInformation,
  rankSearchResults,
  type RankableResult,
} from "@/lib/germany-knowledge";
import { getWebSearchClient } from "@/lib/web-search";

/**
 * Live research for the Germany Copilot.
 *
 * The chat runs the pipeline the product asked for:
 *
 *   user question → intent (does it need current information?) → official-first
 *   web search → source ranking/validation → context block → model synthesis
 *
 * Reuses the EXISTING server-side search provider (Tavily, server-only API key,
 * cached, hard request cap, SSRF-guarded page fetching) — no second search
 * stack, no key on the client.
 *
 * Failure policy: a chat answer must never be blocked or broken by search.
 * Every failure (no key configured, provider error, budget exhausted, timeout)
 * degrades to "not searched" so the model still answers with its rule-level
 * knowledge and tells the user to verify on the official source.
 */

export type ResearchReason =
  | "current_information"
  | "not_needed"
  | "no_provider"
  | "failed";

export interface GermanyResearch {
  searched: boolean;
  reason: ResearchReason;
  query: string;
  results: RankableResult[];
}

const MAX_RESULTS = 6;

export async function researchGermany(question: string): Promise<GermanyResearch> {
  const skip = (reason: ResearchReason): GermanyResearch => ({
    searched: false,
    reason,
    query: "",
    results: [],
  });

  if (!needsCurrentInformation(question)) return skip("not_needed");

  // One request per question: the client also caches identical queries and
  // enforces its own per-run cap, so a burst cannot fan out into paid calls.
  const client = getWebSearchClient({ maxRequests: 1 });
  if (!client) return skip("no_provider");

  const query = buildSearchQuery(question);
  try {
    const raw = await client.search(query, MAX_RESULTS);
    // Official sources first; user-generated content is only ever a last
    // resort and is labelled as such downstream.
    const results = rankSearchResults(raw).slice(0, MAX_RESULTS);
    return {
      searched: results.length > 0,
      reason: results.length ? "current_information" : "failed",
      query,
      results,
    };
  } catch (error) {
    // Never leak the provider error text (it can echo request details) and
    // never fail the chat because of it.
    console.error(
      "[ai-chat] germany research failed",
      JSON.stringify({
        name: error instanceof Error ? error.name : "unknown",
        results: 0,
      }),
    );
    return skip("failed");
  }
}
