/**
 * Housing / "Wohnen" — affordability (Mietkosten-Rechner).
 *
 * Pure, deterministic cost math with no I/O so it is trivially testable and
 * safe to run server-side or in the API. The headline rule of thumb is the
 * German guideline that the WARM rent should stay at or under ~30% of net
 * monthly income.
 */

import type { AffordabilityInput, AffordabilityResult } from "./types";

/** Guideline: warm rent ≤ 30% of net monthly income. */
export const RENT_SHARE_GUIDELINE = 0.3;

/** Clamp a numeric input to a sane non-negative range (guards bad client math). */
function clampFinite(value: number, max = 10_000_000): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(value, max);
}

/**
 * Compute the full monthly housing cost picture for an income + warm rent.
 *
 * - `monthly_total` = warm rent + other recurring costs (electricity, internet).
 * - `deposit_total` = warm rent × deposit months (the one-off Kaution).
 * - `rent_share`    = warm rent / net income (0 when income is 0).
 * - `affordable`    = rent_share ≤ the 30% guideline (and income > 0).
 */
export function computeAffordability(input: AffordabilityInput): AffordabilityResult {
  const income = clampFinite(input.net_monthly_income);
  const warm = clampFinite(input.warm_rent);
  const other = clampFinite(input.other_monthly_costs);
  const depositMonths = clampFinite(input.deposit_months, 12);

  const monthlyTotal = warm + other;
  const depositTotal = warm * depositMonths;
  const rentShare = income > 0 ? warm / income : 0;

  return {
    monthly_total: round2(monthlyTotal),
    deposit_total: round2(depositTotal),
    rent_share: round4(rentShare),
    affordable: income > 0 && rentShare <= RENT_SHARE_GUIDELINE,
    guideline_share: RENT_SHARE_GUIDELINE,
  };
}

/** The maximum warm rent that keeps the share at/below the guideline. */
export function maxAffordableWarmRent(netMonthlyIncome: number): number {
  const income = clampFinite(netMonthlyIncome);
  return round2(income * RENT_SHARE_GUIDELINE);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * Format an EUR amount the way the rest of the app does (German-style, e.g.
 * "1.234,56 €"). Kept here so the calculator + listings share one format.
 */
export function formatEur(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "–";
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: value % 1 === 0 ? 0 : 2,
  })
    // CLDR emits a non-breaking space (U+00A0, or U+202F in newer ICU) between
    // the number and the € symbol. Normalize to a plain space so the output is
    // deterministic across ICU versions, tests, and HTML rendering.
    .format(value)
    .replace(/[\u00A0\u202F]/g, " ");
}
