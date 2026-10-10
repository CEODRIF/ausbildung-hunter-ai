/**
 * German monthly wage calculation for 2026 (statutory values).
 *
 * Method (the same approach the BMF Lohnsteuertabellen use):
 *   1. compute the employee's monthly social-security shares (capped at the
 *      2026 Beitragsbemessungsgrenzen),
 *   2. annualize the zu versteuerndes Einkommen (taxable income),
 *   3. apply the official 2026 tariff (polynomials of § 32a(1) EStG),
 *   4. apply the solidarity surcharge (progressive between its two official
 *      anchors) and the church tax (8 %/9 % of Lohnsteuer + Soli),
 *   5. divide back to a monthly figure.
 *
 * Honesty guarantees:
 *   - Tax classes I and VI are exact for the 2026 tariff (incl. the
 *     small-amount allowance).
 *   - Tax classes II–IV do NOT apply the spouse allowance (Ehegattenfreibetrag
 *     2026 could not be verified against an official source at build time)
 *     and class V uses a splitting approximation on the single tariff. Both
 *     are flagged `taxClassIsEstimate: true` and the UI must disclose it.
 *   - Private health insurance uses the user's own premium — no assumed rate.
 */

import {
  BUNDESLAENDER,
  KINDERFREIBETRAG_2026,
  KIST_8_STATES,
  KIST_RATE_8,
  KIST_RATE_DEFAULT,
  KLEINBETRAGSFREIBETRAG,
  SOLI_2026,
  SOCIAL_2026,
  TAX_TARIFF_2026,
  WERBKOSTENPAUSCHALE_YEAR,
} from "./params";

export type Steuerklasse = 1 | 2 | 3 | 4 | 5 | 6;
export type HealthInsurance = "gkv" | "pkv";

export interface SalaryInput {
  /** Gross salary per month in € (annual inputs are divided by 12 upstream). */
  grossMonthly: number;
  steuerklasse: Steuerklasse;
  /** Bundesland id — only relevant for the church tax rate (8 % vs 9 %). */
  bundesland: string;
  healthInsurance: HealthInsurance;
  /** PKV: the user's actual monthly premium in € (required for "pkv"). */
  pkvMonthly?: number;
  churchTax: boolean;
  /** Number of children (each adds the full Kinderfreibetrag). */
  children: number;
}

export interface SalaryMonthly {
  gross: number;
  pension: number;
  unemployment: number;
  health: number;
  care: number;
  privateHealth: number;
  incomeTax: number;
  soli: number;
  churchTax: number;
  net: number;
}

export interface SalaryResult {
  monthly: SalaryMonthly;
  /** Annualized figures (monthly × 12, before payroll rounding). */
  annual: SalaryMonthly;
  zuVersteuerndesEinkommenAnnual: number;
  /** True when the tax class result is an estimate (II–V, see header). */
  taxClassIsEstimate: boolean;
  /** True when the small-amount allowance zeroed the wage tax. */
  kleinbetragsFreibetragApplied: boolean;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * 2026 income tax on an annual zu versteuerndes Einkommen — the official
 * polynomials of § 32a(1) EStG (zvE truncated to whole euros, per the statute
 * "nach dem auf volle Euro abgerundeten zu versteuernden Einkommen").
 */
export function incomeTax2026(zvE: number): number {
  if (zvE <= 0) return 0;
  const E = Math.floor(zvE);
  const T = TAX_TARIFF_2026;
  if (E <= T.grundfreibetrag) return 0;
  if (E <= T.zone2End) {
    const y = (E - T.grundfreibetrag) / 10_000;
    return (T.zone2A * y + T.zone2B) * y;
  }
  if (E <= T.zone3End) {
    const z = (E - T.zone2End) / 10_000;
    return (T.zone3A * z + T.zone3B) * z + T.zone3C;
  }
  if (E <= T.topRateStart) return T.zone4Rate * E - T.zone4Offset;
  return T.zone5Rate * E - T.zone5Offset;
}

/**
 * Solidarity surcharge on an ANNUAL income-tax amount: 0 below the threshold,
 * full 5.5 % at/above `fullFrom`, linear ramp in between (the official
 * "Gleitzone" shape, anchored at the two published values).
 */
export function soli2026(annualIncomeTax: number): number {
  if (annualIncomeTax <= 0) return 0;
  const { rate, threshold, fullFrom } = SOLI_2026;
  if (annualIncomeTax <= threshold) return 0;
  if (annualIncomeTax >= fullFrom) return rate * annualIncomeTax;
  return rate * annualIncomeTax * ((annualIncomeTax - threshold) / (fullFrom - threshold));
}

export function kistRateFor(bundesland: string): number {
  return KIST_8_STATES.has(bundesland) ? KIST_RATE_8 : KIST_RATE_DEFAULT;
}

export function isValidBundesland(id: string): boolean {
  return BUNDESLAENDER.some((b) => b.id === id);
}

export function calculateSalary(input: SalaryInput): SalaryResult {
  const g = Math.max(0, input.grossMonthly);

  // --- social security (employee shares, capped at the 2026 ceilings) ------
  const puCeiling = SOCIAL_2026.pensionUnemploymentCeilingYear / 12;
  const hvCeiling = SOCIAL_2026.healthCareCeilingYear / 12;
  const puBase = Math.min(g, puCeiling);
  const hvBase = Math.min(g, hvCeiling);

  const pension = puBase * SOCIAL_2026.pensionEmployeeRate;
  const unemployment = puBase * SOCIAL_2026.unemploymentEmployeeRate;

  let health = 0;
  let care = 0;
  let privateHealth = 0;
  if (input.healthInsurance === "gkv") {
    health =
      hvBase *
      (SOCIAL_2026.healthEmployeeBaseRate + SOCIAL_2026.healthSupplementaryRate);
    const careRate =
      SOCIAL_2026.careEmployeeRate +
      (input.children === 0 ? SOCIAL_2026.careChildlessEmployeeSurcharge : 0);
    care = hvBase * careRate;
  } else {
    privateHealth = Math.max(0, input.pkvMonthly ?? 0);
  }
  const social = pension + unemployment + health + care;

  // --- annual zu versteuerndes Einkommen ------------------------------------
  const childrenAllowance = Math.max(0, Math.floor(input.children)) * KINDERFREIBETRAG_2026;
  const zvEAnnual =
    12 * (g - social) - WERBKOSTENPAUSCHALE_YEAR - childrenAllowance;

  // --- wage tax (Lohnsteuer) by tax class -----------------------------------
  let annualTax = 0;
  let taxClassIsEstimate = false;
  let kleinbetrags = false;
  switch (input.steuerklasse) {
    case 1:
    case 6: {
      annualTax = incomeTax2026(zvEAnnual);
      if (zvEAnnual <= KLEINBETRAGSFREIBETRAG && annualTax > 0) {
        annualTax = 0;
        kleinbetrags = true;
      }
      break;
    }
    case 2:
    case 3:
    case 4: {
      // No Ehegattenfreibetrag — official 2026 value unverified at build time.
      annualTax = incomeTax2026(zvEAnnual);
      taxClassIsEstimate = true;
      break;
    }
    case 5: {
      // Widowed splitting approximated on the official single tariff.
      annualTax = incomeTax2026(2 * Math.max(0, zvEAnnual)) / 2;
      taxClassIsEstimate = true;
      break;
    }
    default:
      throw new Error(`unknown steuerklasse: ${String(input.steuerklasse)}`);
  }

  const incomeTax = round2(annualTax / 12);
  const soli = round2(soli2026(annualTax) / 12);
  const churchTax = input.churchTax
    ? round2(kistRateFor(input.bundesland) * (incomeTax + soli))
    : 0;

  const net = g - social - privateHealth - incomeTax - soli - churchTax;

  const scale = (m: SalaryMonthly): SalaryMonthly => ({
    gross: round2(m.gross * 12),
    pension: round2(m.pension * 12),
    unemployment: round2(m.unemployment * 12),
    health: round2(m.health * 12),
    care: round2(m.care * 12),
    privateHealth: round2(m.privateHealth * 12),
    incomeTax: round2(m.incomeTax * 12),
    soli: round2(m.soli * 12),
    churchTax: round2(m.churchTax * 12),
    net: round2(m.net * 12),
  });

  const monthly: SalaryMonthly = {
    gross: round2(g),
    pension: round2(pension),
    unemployment: round2(unemployment),
    health: round2(health),
    care: round2(care),
    privateHealth: round2(privateHealth),
    incomeTax,
    soli,
    churchTax,
    net: round2(net),
  };

  return {
    monthly,
    annual: scale(monthly),
    zuVersteuerndesEinkommenAnnual: round2(zvEAnnual),
    taxClassIsEstimate,
    kleinbetragsFreibetragApplied: kleinbetrags,
  };
}
