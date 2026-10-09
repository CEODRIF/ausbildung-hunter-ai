import { describe, expect, it } from "vitest";

const {
  computeAffordability,
  maxAffordableWarmRent,
  formatEur,
  RENT_SHARE_GUIDELINE,
} = await import("@/lib/housing/affordability");

describe("affordability (Mietkosten-Rechner)", () => {
  it("computes monthly total = warm rent + other costs", () => {
    const r = computeAffordability({
      net_monthly_income: 2000,
      warm_rent: 900,
      other_monthly_costs: 120,
      deposit_months: 2,
    });
    expect(r.monthly_total).toBe(1020);
  });

  it("computes the one-off deposit = warm rent × months", () => {
    const r = computeAffordability({
      net_monthly_income: 2000,
      warm_rent: 900,
      other_monthly_costs: 0,
      deposit_months: 3,
    });
    expect(r.deposit_total).toBe(2700);
  });

  it("is affordable at or under the 30% guideline", () => {
    // 600 / 2000 = 30% → affordable (<=).
    const r = computeAffordability({
      net_monthly_income: 2000,
      warm_rent: 600,
      other_monthly_costs: 0,
      deposit_months: 2,
    });
    expect(r.rent_share).toBeCloseTo(0.3, 5);
    expect(r.affordable).toBe(true);
    expect(r.guideline_share).toBe(RENT_SHARE_GUIDELINE);
  });

  it("is NOT affordable above the guideline", () => {
    const r = computeAffordability({
      net_monthly_income: 2000,
      warm_rent: 700, // 35%
      other_monthly_costs: 0,
      deposit_months: 2,
    });
    expect(r.rent_share).toBeCloseTo(0.35, 5);
    expect(r.affordable).toBe(false);
  });

  it("never reports affordable with zero income (no division-by-zero share)", () => {
    const r = computeAffordability({
      net_monthly_income: 0,
      warm_rent: 900,
      other_monthly_costs: 0,
      deposit_months: 2,
    });
    expect(r.rent_share).toBe(0);
    expect(r.affordable).toBe(false);
  });

  it("guards against non-finite / negative inputs (client math safety)", () => {
    const r = computeAffordability({
      net_monthly_income: Number.NaN,
      warm_rent: -500,
      other_monthly_costs: Infinity,
      deposit_months: -1,
    });
    expect(Number.isFinite(r.monthly_total)).toBe(true);
    expect(r.monthly_total).toBe(0);
  });

  it("maxAffordableWarmRent = income × 30%", () => {
    expect(maxAffordableWarmRent(2000)).toBe(600);
    expect(maxAffordableWarmRent(0)).toBe(0);
  });

  it("formatEur renders German-style and a dash for null", () => {
    expect(formatEur(1234.5)).toBe("1.234,50 €");
    expect(formatEur(1234)).toBe("1.234 €");
    expect(formatEur(null)).toBe("–");
    expect(formatEur(undefined)).toBe("–");
  });
});
