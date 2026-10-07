import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { isPlatformAdminId } from "./platform-admin";

/**
 * Community Phase 5 — global community search.
 *
 * The search itself runs ENTIRELY in Postgres (v6 migration,
 * `community_search`): tsvector + GIN + websearch_to_tsquery, keyset
 * pagination, DMs excluded by construction, blocked/hidden/deleted rows
 * filtered inside the function. This module only translates the HTTP
 * params into the RPC call and the RPC rows into the API shape — no
 * content is ever downloaded into Node.js for filtering.
 */

export type SearchKind = "all" | "message" | "question" | "answer" | "user" | "room";

export const SEARCH_KINDS: readonly SearchKind[] = [
  "all",
  "message",
  "question",
  "answer",
  "user",
  "room",
];

export interface SearchResultItem {
  kind: SearchKind;
  id: string;
  roomId: string | null;
  roomSlug: string | null;
  roomName: string | null;
  authorId: string | null;
  authorName: string | null;
  /** Phase 10: server-trusted platform-admin flag of the author (badge). */
  authorIsAdmin: boolean;
  content: string;
  createdAt: string;
  /** Deep-link target for question/answer rows (null for other kinds). */
  questionId: string | null;
}

export interface SearchPage {
  items: SearchResultItem[];
  /** (created_at, id) of the oldest row — pass back for the next page. */
  cursor: { createdAt: string; id: string } | null;
  unavailable: boolean;
}

export interface SearchParams {
  /** The session user — p_user for the RPC (never client-supplied). */
  userId: string;
  query: string;
  kind?: SearchKind;
  roomId?: string | null;
  authorId?: string | null;
  /** Lower bound for created_at (date filtering). */
  since?: string | null;
  /**
   * URL-driven date window — converted to `since` in this data layer.
   * Server components must not compute `Date.now()` during render, so the
   * window → lower-bound translation lives HERE, not in the page body.
   */
  date?: SearchDate | null;
  cursor?: { createdAt: string; id: string } | null;
  limit?: number;
}

/** URL date window accepted by the search surface. */
export type SearchDate = "all" | "week" | "month" | "year";

/** Window → created_at lower bound (data layer only, never in render). */
export function sinceForDate(date: SearchDate | null): string | null {
  const now = Date.now();
  switch (date) {
    case "week":
      return new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    case "month":
      return new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    case "year":
      return new Date(now - 365 * 24 * 60 * 60 * 1000).toISOString();
    default:
      return null;
  }
}

/** Run ONE bounded search page (20 results max, server-enforced). */
export async function runCommunitySearch(params: SearchParams): Promise<SearchPage> {
  const fail: SearchPage = { items: [], cursor: null, unavailable: true };
  const query = params.query.trim();
  if (query.length < 2 || query.length > 200) {
    return { items: [], cursor: null, unavailable: false };
  }
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 20);
  const since = params.since ?? sinceForDate(params.date ?? null);
  try {
    const admin = createAdminClient();
    const { data, error } = (await admin.rpc("community_search", {
      p_user: params.userId,
      p_query: query,
      p_kind: params.kind ?? "all",
      p_room: params.roomId ?? null,
      p_author: params.authorId ?? null,
      p_since: since,
      p_before_at: params.cursor?.createdAt ?? null,
      p_before_id: params.cursor?.id ?? null,
      p_limit: limit,
    })) as {
      data: Array<{
        kind: string;
        id: string;
        room_id: string | null;
        room_slug: string | null;
        room_name: string | null;
        author_id: string | null;
        author_name: string | null;
        content: string | null;
        created_at: string;
        question_id: string | null;
      }> | null;
      error: { message: string } | null;
    };
    if (error) {
      console.error("[community] search rpc failed:", error.message);
      return fail;
    }
    const items: SearchResultItem[] = (data ?? []).map((r) => ({
      kind: (SEARCH_KINDS as readonly string[]).includes(r.kind)
        ? (r.kind as SearchKind)
        : "message",
      id: r.id,
      roomId: r.room_id,
      roomSlug: r.room_slug,
      roomName: r.room_name,
      authorId: r.author_id,
      authorName: r.author_name,
      // The author id comes from the DATABASE row — never client input — so
      // deriving the flag here is the same trusted-source contract as
      // withAdminFlag (rooms.ts) / toSocialProfile (social.ts).
      authorIsAdmin: r.author_id ? isPlatformAdminId(r.author_id) : false,
      content: r.content ?? "",
      createdAt: r.created_at,
      questionId:
        (r.kind === "question" || r.kind === "answer") && typeof r.question_id === "string"
          ? r.question_id
          : null,
    }));
    const last = items[items.length - 1];
    return {
      items,
      cursor: items.length === limit && last ? { createdAt: last.createdAt, id: last.id } : null,
      unavailable: false,
    };
  } catch (error) {
    console.error("[community] search rpc threw:", error);
    return fail;
  }
}
