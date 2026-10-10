import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { HousingListing } from "@/lib/housing/types";
import {
  claimNextPage,
  createSession,
  dropSession,
  markEnriched,
  wasEnriched,
  __resetSessions,
} from "@/lib/housing/web-search/sessions";
import { PROVIDER_LIMITS } from "@/lib/housing/web-search/config";

const T0 = 1_760_000_000_000;

function listing(i: number): HousingListing {
  return {
    source_id: `s${i}`,
    source_url: `https://portal.de/expose/${100000000 + i}`,
    listing_url: `https://portal.de/expose/${100000000 + i}`,
    title: `Wohnung ${i}`,
    city: "Köln",
    rent_warm_eur: 800,
  } as unknown as HousingListing;
}

const n = (count: number): HousingListing[] => Array.from({ length: count }, (_, i) => listing(i));

beforeEach(() => __resetSessions());
afterEach(() => __resetSessions());

describe("createSession", () => {
  it("starts at page size and reports the true remainder", () => {
    const r = createSession(n(30), T0);
    expect(r.hasMore).toBe(true);
    expect(r.remaining).toBe(30 - PROVIDER_LIMITS.pageSize);
    expect(r.token.length).toBeGreaterThan(8);
  });

  it("exactly one page → no continuation", () => {
    const r = createSession(n(PROVIDER_LIMITS.pageSize), T0);
    expect(r.hasMore).toBe(false);
    expect(r.remaining).toBe(0);
  });

  it("caps stored candidates at sessionMaxCandidates (never unbounded memory)", () => {
    const r = createSession(n(PROVIDER_LIMITS.sessionMaxCandidates + 100), T0);
    expect(r.remaining).toBe(
      PROVIDER_LIMITS.sessionMaxCandidates - PROVIDER_LIMITS.pageSize,
    );
  });
});

describe("claimNextPage", () => {
  it("pages through the rest, then reports nothing left", () => {
    const { token } = createSession(n(30), T0);
    const page = claimNextPage(token, 24, T0 + 1000)!;
    expect(page.page).toHaveLength(30 - PROVIDER_LIMITS.pageSize);
    expect(page.hasMore).toBe(false);
    expect(page.remaining).toBe(0);
    // Consumed session is deleted (no leak).
    expect(claimNextPage(token, 24, T0 + 2000)).toBeNull();
  });

  it("partial claims keep the remainder; limit is clamped to 48", () => {
    // 100 candidates − 24 (page 1) = 76 to serve.
    const { token } = createSession(n(100), T0);
    const first = claimNextPage(token, 48, T0 + 1000)!;
    expect(first.page).toHaveLength(48);
    expect(first.hasMore).toBe(true);
    expect(first.remaining).toBe(76 - 48);
    // The next claim asks for 999 → clamped to 48, but only 28 remain.
    const second = claimNextPage(token, 999, T0 + 2000)!;
    expect(second.page).toHaveLength(28);
    expect(second.hasMore).toBe(false);
    expect(claimNextPage(token, 48, T0 + 3000)).toBeNull();
  });

  it("the 48-clamp actually binds when enough candidates remain", () => {
    const { token } = createSession(n(200), T0);
    const first = claimNextPage(token, 999, T0 + 1000)!;
    expect(first.page).toHaveLength(48); // not 999
    expect(first.hasMore).toBe(true);
  });

  it("unknown token → null (caller degrades to 'start a new search')", () => {
    expect(claimNextPage("does-not-exist", 24, T0)).toBeNull();
  });

  it("TTL expiry → null and the session is dropped", () => {
    const { token } = createSession(n(30), T0);
    const expired = T0 + PROVIDER_LIMITS.sessionTtlMs + 1;
    expect(claimNextPage(token, 24, expired)).toBeNull();
    expect(claimNextPage(token, 24, expired + 1)).toBeNull();
  });

  it("evicts the oldest sessions when the entry cap is exceeded", () => {
    const oldest = createSession(n(30), T0);
    for (let i = 0; i < PROVIDER_LIMITS.sessionMaxEntries; i += 1) {
      createSession(n(30), T0 + (i + 1) * 1000);
    }
    // A fresh session triggers the prune: the oldest must be gone.
    createSession(n(30), T0 + 100_000);
    expect(claimNextPage(oldest.token, 24, T0 + 100_000)).toBeNull();
  });
});

describe("enrichment bookkeeping", () => {
  it("markEnriched/wasEnriched are session- and URL-scoped", () => {
    const a = createSession(n(30), T0).token;
    const b = createSession(n(30), T0).token;
    expect(wasEnriched(a, "u1")).toBe(false);
    markEnriched(a, "u1");
    expect(wasEnriched(a, "u1")).toBe(true);
    expect(wasEnriched(b, "u1")).toBe(false); // other session unaffected
    expect(wasEnriched("ghost", "u1")).toBe(false);
  });

  it("dropSession removes the session", () => {
    const { token } = createSession(n(30), T0);
    dropSession(token);
    expect(claimNextPage(token, 24, T0 + 1000)).toBeNull();
  });
});
