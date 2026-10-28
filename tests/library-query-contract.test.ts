import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Deutsch Bibliothek — SEARCH CONTRACT (regression suite for the 2026-10
 * bugs: the Search button performed a FULL page reload, and title/category
 * filtering silently did nothing).
 *
 * Root cause #2 was a param-shape mismatch: the page parsed the URL into
 * `{ q, cat, page }` and passed that object to `listPublishedBooks`, which
 * reads `{ search, category, page }` — both filters arrived as `undefined`,
 * so every search rendered the unfiltered catalog. All-optional param
 * types made the mismatch invisible to the compiler, and the existing
 * tests called the data layer directly with the right keys, so the join
 * itself was never covered.
 *
 * These tests pin the JOIN (URL shape → data-layer shape) end to end,
 * plus the search semantics the data layer must honor:
 *   - case-insensitive title match (ILIKE, never LIKE);
 *   - trimmed, empty-safe queries;
 *   - `%` / `_` / `\` are literal, not wildcards;
 *   - category narrows independently AND combined with the title;
 *   - clearing both restores the full listing;
 *   - the page index is bounded.
 *
 * Mock boundary: the anon/auth server client only (RLS remains the real
 * visibility boundary; here we pin the query shape, as in
 * library-public-reads.test.ts).
 */

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/config", () => ({
  getSupabaseEnv: () => ({
    supabaseUrl: "https://proj.supabase.co",
    supabaseAnonKey: "anon-test-key",
  }),
}));

import { createClient } from "@/lib/supabase/server";
import {
  listPublishedBooks,
  parseLibraryQuery,
  LIBRARY_PAGE_SIZE,
} from "@/lib/book-library";

interface PublicQueryResult {
  data: unknown;
  error: unknown;
  count: number | null;
}

/** Records the query chain (same contract as library-public-reads). */
function mockPublicQuery(result: PublicQueryResult, rows: unknown[] = []) {
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

// ---------------------------------------------------------------------------
// 1. The JOIN: raw URL params → data-layer params (the regression itself)
// ---------------------------------------------------------------------------

describe("parseLibraryQuery — URL shape to data-layer shape", () => {
  it("maps q/cat/page to search/category/page (the exact keys listPublishedBooks reads)", () => {
    expect(
      parseLibraryQuery({ q: "wortschatz", cat: "hoeren", page: "2" }),
    ).toEqual({ search: "wortschatz", category: "hoeren", page: 2 });
  });

  it("trims whitespace and treats blank values as empty", () => {
    expect(parseLibraryQuery({ q: "   band 2  " })).toEqual({
      search: "band 2",
      category: null,
      page: 1,
    });
    expect(parseLibraryQuery({ q: "   ", cat: "  " })).toEqual({
      search: null,
      category: null,
      page: 1,
    });
    expect(parseLibraryQuery({})).toEqual({
      search: null,
      category: null,
      page: 1,
    });
  });

  it("clamps the page index (1 .. 10000; garbage → 1)", () => {
    expect(parseLibraryQuery({ page: "0" }).page).toBe(1);
    expect(parseLibraryQuery({ page: "-5" }).page).toBe(1);
    expect(parseLibraryQuery({ page: "abc" }).page).toBe(1);
    expect(parseLibraryQuery({ page: "999999999" }).page).toBe(10_000);
    expect(parseLibraryQuery({ page: "3" }).page).toBe(3);
  });

  it("ignores repeated (array) params instead of crashing", () => {
    expect(parseLibraryQuery({ q: ["a", "b"] })).toEqual({
      search: null,
      category: null,
      page: 1,
    });
  });
});

describe("page → data layer contract (end to end, the regression)", () => {
  it("raw searchParams flow into REAL narrowing: title ILIKE + category EQ + range", async () => {
    const { calls } = mockPublicQuery({ data: [], error: null, count: 0 });
    // Exactly what the page does: parseLibraryQuery(rawParams) →
    // listPublishedBooks(filters).
    const filters = parseLibraryQuery({
      q: "  Mittelstufe ",
      cat: "wortschatz",
    });
    const result = await listPublishedBooks(filters);

    expect(calls).toContain("ilike:title~%Mittelstufe%");
    expect(calls).toContain("eq:category=wortschatz");
    expect(calls).toContain("eq:published=true");
    expect(calls).toContain(`range:0:${LIBRARY_PAGE_SIZE - 1}`);
    expect(result.total).toBe(0);
  });

  it("a TITLE-ONLY query narrows by title and adds NO category condition", async () => {
    const { calls } = mockPublicQuery({ data: [], error: null, count: 0 });
    await listPublishedBooks(parseLibraryQuery({ q: "band 2" }));
    expect(calls).toContain("ilike:title~%band 2%");
    expect(calls.filter((c) => c.startsWith("eq:category"))).toHaveLength(0);
  });

  it("a CATEGORY-ONLY query narrows by category and adds NO title condition (works without a title)", async () => {
    const { calls } = mockPublicQuery({ data: [], error: null, count: 0 });
    await listPublishedBooks(parseLibraryQuery({ cat: "pruefungsvorbereitung" }));
    expect(calls.filter((c) => c.startsWith("ilike:"))).toHaveLength(0);
    expect(calls).toContain("eq:category=pruefungsvorbereitung");
  });

  it("clearing BOTH (no params) restores the full published listing", async () => {
    const { calls } = mockPublicQuery({ data: [], error: null, count: 0 });
    await listPublishedBooks(parseLibraryQuery({}));
    expect(calls.filter((c) => c.startsWith("ilike:"))).toHaveLength(0);
    expect(calls.filter((c) => c.startsWith("eq:category"))).toHaveLength(0);
    expect(calls).toContain("eq:published=true");
    expect(calls).toContain(`range:0:${LIBRARY_PAGE_SIZE - 1}`);
  });

  it("search + category + page combine (AND semantics, page 3 → correct range)", async () => {
    const { calls } = mockPublicQuery({ data: [], error: null, count: 0 });
    await listPublishedBooks(
      parseLibraryQuery({ q: "grammatik", cat: "lehrbuch", page: "3" }),
    );
    expect(calls).toContain("ilike:title~%grammatik%");
    expect(calls).toContain("eq:category=lehrbuch");
    expect(calls).toContain(
      `range:${2 * LIBRARY_PAGE_SIZE}:${3 * LIBRARY_PAGE_SIZE - 1}`,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Title-search semantics (case, trimming, wildcard safety)
// ---------------------------------------------------------------------------

describe("title search semantics in listPublishedBooks", () => {
  it("matches case-insensitively via ILIKE (never LIKE)", async () => {
    const { calls } = mockPublicQuery({ data: [], error: null, count: 0 });
    await listPublishedBooks({ search: "MiTTelStufe" });
    // The mock records the METHOD used: ilike is the case-insensitive one.
    expect(calls).toContain("ilike:title~%MiTTelStufe%");
    expect(calls.some((c) => c.startsWith("like:"))).toBe(false);
  });

  it("trims the query before matching (leading/trailing spaces are not searched)", async () => {
    const { calls } = mockPublicQuery({ data: [], error: null, count: 0 });
    await listPublishedBooks({ search: "   band 2   " });
    expect(calls).toContain("ilike:title~%band 2%");
  });

  it("treats whitespace-only queries as empty (no ilike condition)", async () => {
    const { calls } = mockPublicQuery({ data: [], error: null, count: 0 });
    await listPublishedBooks({ search: " \t " });
    expect(calls.filter((c) => c.startsWith("ilike:"))).toHaveLength(0);
  });

  it("escapes % and _ so they match LITERALLY (no wildcard injection)", async () => {
    const { calls } = mockPublicQuery({ data: [], error: null, count: 0 });
    await listPublishedBooks({ search: "100% sicher" });
    expect(calls).toContain("ilike:title~%100\\% sicher%");
    const { calls: calls2 } = mockPublicQuery({
      data: [],
      error: null,
      count: 0,
    });
    await listPublishedBooks({ search: "a_b" });
    expect(calls2).toContain("ilike:title~%a\\_b%");
  });

  it("escapes a literal backslash in the query", async () => {
    const { calls } = mockPublicQuery({ data: [], error: null, count: 0 });
    await listPublishedBooks({ search: "c:\\buch" });
    expect(calls).toContain("ilike:title~%c:\\\\buch%");
  });

  it("caps the searched fragment at 100 characters", async () => {
    const { calls } = mockPublicQuery({ data: [], error: null, count: 0 });
    await listPublishedBooks({ search: "a".repeat(200) });
    expect(calls).toContain(`ilike:title~%${"a".repeat(100)}%`);
  });
});
