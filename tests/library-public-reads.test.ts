import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Deutsch Bibliothek — PUBLIC read path contracts.
 *
 * The public page runs as anon (visitor) or authenticated (member) through
 * the session/anon server client — RLS is the boundary. These tests pin the
 * query shape that makes that boundary airtight in the app layer too:
 *
 *   - EVERY public listing query carries `.eq("published", true)` — the
 *     explicit defence-in-depth filter on top of the RLS policy;
 *   - search/filter/pagination only NARROW the result set (title ilike,
 *     category eq, bounded range);
 *   - the count is exact (drives the empty state + pagination);
 *   - the cover URL is a PUBLIC storage URL constructed from the public
 *     project env value — no privileged material.
 */

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
// config.ts captures the env values at module load — pin the public project
// URL for the URL-construction tests (the anon key is irrelevant here).
vi.mock("@/lib/supabase/config", () => ({
  getSupabaseEnv: () => ({
    supabaseUrl: "https://proj.supabase.co",
    supabaseAnonKey: "anon-test-key",
  }),
}));

import { createClient } from "@/lib/supabase/server";
import {
  bookCoverPublicUrl,
  listPublishedBooks,
  LIBRARY_PAGE_SIZE,
} from "@/lib/book-library";

const BOOK = {
  id: "aaaaaaaa-1111-4111-8111-111111111111",
  title: "Mittelstufenwortschatz Band 2",
  category: "wortschatz",
  description: "Übungsbuch für B1",
  cover_path: "covers/cover-uuid.png",
  cover_mime: "image/png",
  download_url: "https://example.com/wortschatz-b2.pdf",
  created_at: "2026-12-01T00:00:00Z",
};

interface PublicQuery {
  calls: string[];
  result: { data: unknown; error: unknown; count: number | null };
}

/** Records the query chain and resolves with the given result. */
function mockPublicQuery(result: PublicQuery["result"], rows: unknown[] = []) {
  const calls: string[] = [];
  const chain: Record<string, unknown> = {
    eq: (c: string, v: unknown) => ((calls.push(`eq:${c}=${String(v)}`), chain)),
    ilike: (c: string, v: unknown) => ((calls.push(`ilike:${c}~${v}`), chain)),
    order: (c: string, opts: { ascending: boolean }) =>
      ((calls.push(`order:${c}:${opts.ascending ? "asc" : "desc"}`), chain)),
    range: (a: number, b: number) => ((calls.push(`range:${a}:${b}`), chain)),
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: rows, error: result.error, count: result.count }).then(resolve),
  };
  vi.mocked(createClient).mockResolvedValue({
    from: (table: string) => {
      calls.push(`from:${table}`);
      return {
        select: (sel: string, opts?: unknown) => {
          calls.push(`select:${sel}:${JSON.stringify(opts ?? null)}`);
          return chain;
        },
      };
    },
  } as never);
  return { calls };
}

afterEach(() => vi.clearAllMocks());

describe("listPublishedBooks — published-only boundary", () => {
  it("always filters published = true (defence in depth on top of RLS)", async () => {
    const { calls } = mockPublicQuery({ data: [BOOK], error: null, count: 1 }, [BOOK]);
    const result = await listPublishedBooks({});
    expect(calls[0]).toBe("from:german_books");
    expect(calls).toContain("eq:published=true");
    expect(result.books).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.pageCount).toBe(1);
  });

  it("requests an exact count (drives empty state + pagination)", async () => {
    const { calls } = mockPublicQuery({ data: [], error: null, count: 0 });
    await listPublishedBooks({});
    expect(calls[1]).toContain('"count":"exact"');
  });

  it("search narrows by title (ILIKE), filter narrows by category", async () => {
    const { calls } = mockPublicQuery({ data: [], error: null, count: 0 });
    await listPublishedBooks({ search: "  wortschatz ", category: "hoeren" });
    expect(calls).toContain("ilike:title~%wortschatz%");
    expect(calls).toContain("eq:category=hoeren");
  });

  it("blank search/filter add no narrowing conditions", async () => {
    const { calls } = mockPublicQuery({ data: [], error: null, count: 0 });
    await listPublishedBooks({ search: "   ", category: "" });
    expect(calls.filter((c) => c.startsWith("ilike:"))).toHaveLength(0);
    expect(calls.filter((c) => c === "eq:category=")).toHaveLength(0);
    expect(calls.filter((c) => c.startsWith("eq:category"))).toHaveLength(0);
  });

  it("orders newest first and paginates with a bounded range", async () => {
    const { calls } = mockPublicQuery({ data: [], error: null, count: 40 });
    await listPublishedBooks({ page: 2 });
    expect(calls).toContain("order:created_at:desc");
    expect(calls).toContain(`range:${LIBRARY_PAGE_SIZE}:${2 * LIBRARY_PAGE_SIZE - 1}`);
  });

  it("clamps invalid page values (never a negative range)", async () => {
    const { calls } = mockPublicQuery({ data: [], error: null, count: 5 });
    await listPublishedBooks({ page: 0 });
    expect(calls).toContain(`range:0:${LIBRARY_PAGE_SIZE - 1}`);
    const again = mockPublicQuery({ data: [], error: null, count: 5 });
    await listPublishedBooks({ page: -3 });
    expect(again.calls).toContain(`range:0:${LIBRARY_PAGE_SIZE - 1}`);
    const huge = mockPublicQuery({ data: [], error: null, count: 5 });
    await listPublishedBooks({ page: 1_000_000 });
    // Bounded — the server never issues an unbounded range.
    const range = huge.calls.find((c) => c.startsWith("range:"));
    expect(range).toBeTruthy();
    const [, from] = range!.split(":").map(Number);
    expect(from).toBeGreaterThan(0);
  });

  it("computes pageCount from the exact count", async () => {
    mockPublicQuery({ data: [], error: null, count: 25 });
    const result = await listPublishedBooks({});
    expect(result.total).toBe(25);
    expect(result.pageCount).toBe(Math.ceil(25 / LIBRARY_PAGE_SIZE));
  });

  it("an empty result is an empty page, not an error", async () => {
    const { calls } = mockPublicQuery({ data: null, error: null, count: 0 });
    const result = await listPublishedBooks({});
    expect(result.books).toEqual([]);
    expect(calls).toContain("eq:published=true");
  });

  it("a database failure throws (the page renders its error state)", async () => {
    mockPublicQuery({ data: null, error: { message: "boom", code: "42P01" }, count: null });
    await expect(listPublishedBooks({})).rejects.toThrow("boom");
  });
});

describe("bookCoverPublicUrl — public read-only mechanism", () => {
  it("builds the public storage object URL from the PUBLIC env value", () => {
    const url = bookCoverPublicUrl("covers/abc-123.png");
    expect(url).toBe(
      "https://proj.supabase.co/storage/v1/object/public/book-covers/covers/abc-123.png",
    );
  });

  it("URL-encodes each path segment (no injection through a stored path)", () => {
    const url = bookCoverPublicUrl("covers/a b.png");
    expect(url).toBe(
      "https://proj.supabase.co/storage/v1/object/public/book-covers/covers/a%20b.png",
    );
  });
});
