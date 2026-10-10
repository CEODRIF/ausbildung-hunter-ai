/**
 * Salary engine tests — 2026 statutory values.
 *
 * Every expected value below is derived from the official sources the engine
 * is built on (see src/lib/salary/params.ts): the § 32a(1) EStG polynomials
 * (current statute text), the two published 2026 Solidaritätszuschlag anchors,
 * and the 2026 Rechengrößen — no third-party calculator output.
 */
import { describe, expect, it } from "vitest";
import {
  calculateSalary,
  incomeTax2026,
  isValidBundesland,
  kistRateFor,
  soli2026,
  type SalaryInput,
} from "@/lib/salary/calculate";
import {
  KINDERFREIBETRAG_2026,
  KIST_8_STATES,
  PARAMS_REVIEWED_AT,
  SOCIAL_2026,
  TAX_TARIFF_2026,
  WERBKOSTENPAUSCHALE_YEAR,
} from "@/lib/salary/params";

const base: Omit<SalaryInput, "grossMonthly" | "steuerklasse"> = {
  bundesland: "nw",
  healthInsurance: "gkv",
  churchTax: false,
  children: 0,
};

describe("incomeTax2026 (§ 32a Abs. 1 EStG, amtliche Formeln)", () => {
  it("is zero up to and at the Grundfreibetrag", () => {
    expect(incomeTax2026(0)).toBe(0);
    expect(incomeTax2026(-50)).toBe(0);
    expect(incomeTax2026(TAX_TARIFF_2026.grundfreibetrag)).toBe(0);
    // zvE is truncated to whole euros per the statute.
    expect(incomeTax2026(TAX_TARIFF_2026.grundfreibetrag + 0.99)).toBe(0);
  });

  it("zone 2 matches the statutory polynomial at 15,000 €", () => {
    const E = 15_000;
    const y = (E - TAX_TARIFF_2026.grundfreibetrag) / 10_000;
    const expected = (TAX_TARIFF_2026.zone2A * y + TAX_TARIFF_2026.zone2B) * y;
    expect(incomeTax2026(E)).toBeCloseTo(expected, 6);
    // and is inside the 14 % → 23.97 % band
    expect(expected).toBeGreaterThan(0.14 * (E - TAX_TARIFF_2026.grundfreibetrag) - 1);
  });

  it("zone 4 statutory anchor: 100,000 € zvE → 30,864.37 €", () => {
    expect(incomeTax2026(100_000)).toBeCloseTo(0.42 * 100_000 - 11_135.63, 2);
    expect(incomeTax2026(100_000)).toBeCloseTo(30_864.37, 2);
  });

  it("zone 5 statutory anchor: 300,000 € zvE → 115,529.62 €", () => {
    expect(incomeTax2026(300_000)).toBeCloseTo(0.45 * 300_000 - 19_470.38, 2);
    expect(incomeTax2026(300_000)).toBeCloseTo(115_529.62, 2);
  });

  it("is continuous at all zone boundaries (statutory rounding ≤ 0.50 €)", () => {
    for (const b of [
      TAX_TARIFF_2026.zone2End,
      TAX_TARIFF_2026.zone3End,
      TAX_TARIFF_2026.topRateStart,
    ]) {
      const step = incomeTax2026(b + 1) - incomeTax2026(b);
      expect(step, `boundary ${b}`).toBeGreaterThan(0);
      expect(step, `boundary ${b}`).toBeLessThanOrEqual(0.49 + 1e-9);
    }
  });

  it("is monotonically non-decreasing up to 350,000 €", () => {
    let prev = incomeTax2026(0);
    for (let e = 1; e <= 350_000; e += 137) {
      const cur = incomeTax2026(e);
      expect(cur, `zvE ${e}`).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = cur;
    }
  });
});

describe("soli2026 (amtliche Ankerwerte)", () => {
  it("is zero at and below the 20,350 € income-tax threshold", () => {
    expect(soli2026(0)).toBe(0);
    expect(soli2026(20_350)).toBe(0);
  });

  it("is full 5.5 % at and above 37,839 € income tax", () => {
    expect(soli2026(37_839)).toBeCloseTo(0.055 * 37_839, 6);
    expect(soli2026(100_000)).toBeCloseTo(0.055 * 100_000, 6);
  });

  it("ramps linearly between the two anchors", () => {
    const mid = (20_350 + 37_839) / 2;
    const expected = (0.055 * mid * (mid - 20_350)) / (37_839 - 20_350);
    expect(soli2026(mid)).toBeCloseTo(expected, 6);
    expect(soli2026(30_000)).toBeGreaterThan(soli2026(25_000));
    expect(soli2026(21_000)).toBeGreaterThan(0);
  });
});

describe("church tax rate + bundesland validation", () => {
  it("8 % only in Bayern, Baden-Württemberg and Hessen", () => {
    for (const id of KIST_8_STATES) expect(kistRateFor(id)).toBe(0.08);
    expect(kistRateFor("nw")).toBe(0.09);
    expect(kistRateFor("bb")).toBe(0.09);
  });

  it("accepts exactly the 16 state ids", () => {
    expect(isValidBundesland("th")).toBe(true);
    expect(isValidBundesland("be")).toBe(true);
    expect(isValidBundesland("xx")).toBe(false);
    expect(isValidBundesland("")).toBe(false);
  });
});

describe("calculateSalary — social security (Rechengrößen 2026)", () => {
  it("employee share: 9.3 % RV + 1.3 % AV + (7.3 + 2.9) % KV + (1.8 + 0.3) % PV childless", () => {
    const r = calculateSalary({ ...base, grossMonthly: 4_000, steuerklasse: 1 });
    expect(r.monthly.pension).toBeCloseTo(4_000 * 0.093, 2); // 372.00
    expect(r.monthly.unemployment).toBeCloseTo(4_000 * 0.013, 2); // 52.00
    expect(r.monthly.health).toBeCloseTo(4_000 * 0.102, 2); // 408.00
    expect(r.monthly.care).toBeCloseTo(4_000 * 0.021, 2); // 84.00 (childless surcharge)
  });

  it("with children the PV surcharge disappears", () => {
    const r = calculateSalary({ ...base, grossMonthly: 4_000, steuerklasse: 1, children: 2 });
    expect(r.monthly.care).toBeCloseTo(4_000 * 0.018, 2); // 72.00
  });

  it("caps contributions at the 2026 ceilings (8,450 €/mo and 5,812.50 €/mo)", () => {
    const r = calculateSalary({ ...base, grossMonthly: 20_000, steuerklasse: 6 });
    expect(r.monthly.pension).toBeCloseTo(8_450 * 0.093, 2); // 785.85
    expect(r.monthly.unemployment).toBeCloseTo(8_450 * 0.013, 2); // 109.85
    expect(r.monthly.health).toBeCloseTo(5_812.5 * 0.102, 2); // 592.88
    expect(r.monthly.care).toBeCloseTo(5_812.5 * 0.021, 2); // 122.06
  });
});

describe("calculateSalary — wage tax scenarios", () => {
  it("4,000 €/Monat, SK I, GKV, no children: zvE 35,778 €/y, net 2,592 €", () => {
    const r = calculateSalary({ ...base, grossMonthly: 4_000, steuerklasse: 1 });
    expect(r.zuVersteuerndesEinkommenAnnual).toBe(35_778);
    expect(r.monthly.incomeTax).toBeCloseTo(492, 0.01);
    expect(r.monthly.soli).toBe(0);
    expect(r.monthly.net).toBeCloseTo(2_592, 0.5);
    expect(r.taxClassIsEstimate).toBe(false);
    expect(r.kleinbetragsFreibetragApplied).toBe(false);
  });

  it("applies the Kleinbetragsfreibetrag for SK I (zvE ≤ 18,000 €/y)", () => {
    // gross such that zvEAnnual = 12·(g − 0.229·g) − 1,230 = 15,000
    const g = 16_230 / 9.252;
    const r = calculateSalary({ ...base, grossMonthly: g, steuerklasse: 1 });
    expect(r.zuVersteuerndesEinkommenAnnual).toBeCloseTo(15_000, 1);
    // the tariff would produce tax — the allowance zeroes it
    expect(incomeTax2026(15_000)).toBeGreaterThan(0);
    expect(r.monthly.incomeTax).toBe(0);
    expect(r.kleinbetragsFreibetragApplied).toBe(true);
    expect(r.monthly.net).toBeCloseTo(g * (1 - 0.229), 0.5);
  });

  it("applies the Kleinbetragsfreibetrag for SK VI as well", () => {
    const g = 16_230 / 9.252;
    const r = calculateSalary({ ...base, grossMonthly: g, steuerklasse: 6 });
    expect(r.monthly.incomeTax).toBe(0);
    expect(r.kleinbetragsFreibetragApplied).toBe(true);
  });

  it("does not apply the allowance above 18,000 € zvE", () => {
    const g = 20_000 / 9.252 + 0.01; // zvE ≈ 18,788 €
    const r = calculateSalary({ ...base, grossMonthly: g, steuerklasse: 1 });
    expect(r.zuVersteuerndesEinkommenAnnual).toBeGreaterThan(18_000);
    expect(r.monthly.incomeTax).toBeGreaterThan(0);
    expect(r.kleinbetragsFreibetragApplied).toBe(false);
  });

  it("children reduce zvE by the full Kinderfreibetrag each (and lift zvE by the vanished 0.3 % PV surcharge)", () => {
    const noKid = calculateSalary({ ...base, grossMonthly: 4_000, steuerklasse: 1 });
    const kids = calculateSalary({ ...base, grossMonthly: 4_000, steuerklasse: 1, children: 2 });
    // with children the 0.3 % employee PV surcharge disappears:
    // +12 · 4,000 · 0.003 = +144 €/y less social contribution → less deduction
    expect(kids.zuVersteuerndesEinkommenAnnual).toBe(
      noKid.zuVersteuerndesEinkommenAnnual + 12 * 4_000 * 0.003 - 2 * KINDERFREIBETRAG_2026,
    );
    expect(kids.monthly.incomeTax).toBeLessThan(noKid.monthly.incomeTax);
  });

  it("flags tax classes II–V as estimates, I/VI as exact", () => {
    for (const sk of [1, 6] as const) {
      expect(
        calculateSalary({ ...base, grossMonthly: 4_000, steuerklasse: sk }).taxClassIsEstimate,
      ).toBe(false);
    }
    for (const sk of [2, 3, 4, 5] as const) {
      expect(
        calculateSalary({ ...base, grossMonthly: 4_000, steuerklasse: sk }).taxClassIsEstimate,
      ).toBe(true);
    }
  });

  it("church tax is 8 %/9 % of Lohnsteuer + Soli depending on the state", () => {
    const r9 = calculateSalary({
      ...base,
      grossMonthly: 6_000,
      steuerklasse: 1,
      bundesland: "nw",
      churchTax: true,
    });
    expect(r9.monthly.churchTax).toBeCloseTo(
      0.09 * (r9.monthly.incomeTax + r9.monthly.soli),
      0.01,
    );
    const r8 = calculateSalary({
      ...base,
      grossMonthly: 6_000,
      steuerklasse: 1,
      bundesland: "by",
      churchTax: true,
    });
    expect(r8.monthly.churchTax).toBeCloseTo(
      0.08 * (r8.monthly.incomeTax + r8.monthly.soli),
      0.01,
    );
    expect(r8.monthly.churchTax).toBeLessThan(r9.monthly.churchTax);
  });
});

describe("calculateSalary — PKV path", () => {
  it("no GKV/care contributions; the user's own premium is deducted", () => {
    const r = calculateSalary({
      ...base,
      grossMonthly: 4_000,
      steuerklasse: 1,
      healthInsurance: "pkv",
      pkvMonthly: 500,
    });
    expect(r.monthly.health).toBe(0);
    expect(r.monthly.care).toBe(0);
    expect(r.monthly.privateHealth).toBe(500);
    // social = 372 + 52 = 424 → zvE = 12·(4,000 − 424) − 1,230
    expect(r.zuVersteuerndesEinkommenAnnual).toBe(41_682);
    expect(r.monthly.net).toBeCloseTo(4_000 - 424 - 500 - r.monthly.incomeTax, 0.01);
  });
});

describe("calculateSalary — result shape", () => {
  it("annual figures are monthly × 12 (before payroll rounding)", () => {
    const r = calculateSalary({ ...base, grossMonthly: 4_000, steuerklasse: 1 });
    const keys = [
      "gross",
      "pension",
      "unemployment",
      "health",
      "care",
      "privateHealth",
      "incomeTax",
      "soli",
      "churchTax",
      "net",
    ] as const;
    for (const k of keys) {
      expect(r.annual[k], k).toBeCloseTo(r.monthly[k] * 12, 0);
    }
  });

  it("net = gross − social − privateHealth − Lohnsteuer − Soli − Kirchensteuer", () => {
    const r = calculateSalary({
      ...base,
      grossMonthly: 6_000,
      steuerklasse: 1,
      bundesland: "he",
      churchTax: true,
    });
    const m = r.monthly;
    const expectedNet =
      m.gross - m.pension - m.unemployment - m.health - m.care - m.privateHealth -
      m.incomeTax - m.soli - m.churchTax;
    expect(m.net).toBeCloseTo(expectedNet, 0.01);
  });
});

describe("params metadata (honesty invariants)", () => {
  it("pins the verified review date and core statutory values", () => {
    expect(PARAMS_REVIEWED_AT).toBe("2026-10-11");
    expect(TAX_TARIFF_2026.grundfreibetrag).toBe(12_348);
    expect(TAX_TARIFF_2026.topRateStart).toBe(277_825);
    expect(SOCIAL_2026.pensionEmployeeRate).toBe(0.093);
    expect(SOCIAL_2026.healthEmployeeBaseRate).toBe(0.073);
    expect(SOCIAL_2026.healthSupplementaryRate).toBe(0.029);
    expect(WERBKOSTENPAUSCHALE_YEAR).toBe(1_230);
    expect(KINDERFREIBETRAG_2026).toBe(6_826);
  });
});
