import { afterEach, describe, expect, it, vi } from "vitest";

import { CostTracker, worstCaseGoogleQueriesPerRun } from "@/lib/housing/web-search/cost";
import { PROVIDER_LIMITS } from "@/lib/housing/web-search/config";

afterEach(() => vi.unstubAllEnvs());

describe("CostTracker — measured, not guessed", () => {
  it("counts EXECUTED Google queries and prices them at list (1.4¢)", () => {
    vi.stubEnv("HOUSING_SEARCH_MAX_COST_CENTS_PER_RUN", "");
    const c = new CostTracker();
    c.addGoogleQueries(2);
    c.addGoogleQueries(1);
    expect(c.googleEstimateCents()).toBeCloseTo(4.2, 5);
    expect(c.googleCapReached()).toBe(false);
    const snap = c.snapshot();
    const g = snap.find((s) => s.provider === "google")!;
    expect(g.units).toBe(3);
    expect(g.estimatedCostCents).toBeCloseTo(4.2, 5);
    expect(g.basis).toContain("3 executed Google search queries");
  });

  it("ignores null/negative/NaN query counts (never fabricates cost)", () => {
    vi.stubEnv("HOUSING_SEARCH_MAX_COST_CENTS_PER_RUN", "");
    const c = new CostTracker();
    c.addGoogleQueries(null);
    c.addGoogleQueries(-2);
    c.addGoogleQueries(NaN);
    expect(c.googleEstimateCents()).toBe(0);
    expect(c.snapshot().find((s) => s.provider === "google")!.units).toBe(0);
  });

  it("caps at the built-in default (50¢) and the env may only LOWER it", () => {
    vi.stubEnv("HOUSING_SEARCH_MAX_COST_CENTS_PER_RUN", "");
    expect(new CostTracker().maxCentsPerRun()).toBe(PROVIDER_LIMITS.defaultMaxCostCentsPerRun);

    vi.stubEnv("HOUSING_SEARCH_MAX_COST_CENTS_PER_RUN", "10");
    expect(new CostTracker().maxCentsPerRun()).toBe(10);

    // Raise attempts are clamped back to the built-in ceiling.
    vi.stubEnv("HOUSING_SEARCH_MAX_COST_CENTS_PER_RUN", "500");
    expect(new CostTracker().maxCentsPerRun()).toBe(PROVIDER_LIMITS.defaultMaxCostCentsPerRun);
  });

  it("googleCapReached stops exactly at the cap", () => {
    vi.stubEnv("HOUSING_SEARCH_MAX_COST_CENTS_PER_RUN", "2");
    const c = new CostTracker();
    expect(c.googleCapReached()).toBe(false);
    c.addGoogleQueries(1); // 1.4¢ < 2¢
    expect(c.googleCapReached()).toBe(false);
    c.addGoogleQueries(1); // 2.8¢ ≥ 2¢
    expect(c.googleCapReached()).toBe(true);
  });

  it("Azure is tracked in UNITS (credits — no fixed public price), never cents", () => {
    vi.stubEnv("HOUSING_SEARCH_MAX_COST_CENTS_PER_RUN", "");
    const c = new CostTracker();
    c.addBingTransactions(2);
    const a = c.snapshot().find((s) => s.provider === "azure")!;
    expect(a.units).toBe(2);
    expect(a.estimatedCostCents).toBeNull();
    expect(a.basis).toContain("credits");
  });
});

describe("worst-case bound", () => {
  it("the per-run Google query worst case stays inside the default cost cap", () => {
    const worst = worstCaseGoogleQueriesPerRun();
    expect(worst).toBe(9 * 3);
    const c = new CostTracker();
    // Simulate the worst case: 9 calls × 3 executed queries.
    for (let i = 0; i < worst; i += 1) c.addGoogleQueries(1);
    // Worst case ≈ 37.8¢ < 50¢ default cap — the cap can stop a pathological
    // response, and the round/call caps bound the rest.
    expect(c.googleEstimateCents()).toBeLessThan(c.maxCentsPerRun());
  });
});
