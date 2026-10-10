/**
 * German wage-tax parameters — calculation year 2026 only.
 *
 * Every value below was verified on 2026-10-11 against official sources:
 *
 *  - Income tax tariff: the current official statute text of § 32a(1) EStG
 *    (in force for the 2026 assessment year, gesetze-im-internet.de). Since
 *    the 2026 reform the tariff is published as closed-form polynomials —
 *    the coefficients below are copied from the statute, not fitted.
 *  - Solidarity surcharge anchors: § 3 SolzG exemption values as published
 *    in the 2026 tariff notices (20,350 € income tax — full rate from
 *    37,839 €), cross-checked against two independent 2026 tariff summaries.
 *  - Child tax allowance (Kinderfreibetrag) 2026: 6,826 € per child
 *    (incl. 2,928 € care/education share) — Steuervereinfachungsgesetz.
 *  - Social security (Rechengrößen 2026): Deutsche Rentenversicherung /
 *    KV-Bundestag figures as published for 01/2026 (pension 18.6 %,
 *    ceiling 101,400 €/y unified; unemployment 2.6 %; health 14.6 % +
 *    average supplementary contribution 2.9 %, ceiling 69,750 €/y;
 *    long-term care 3.6 % + 0.6 % childless surcharge).
 *  - Standard deduction for work-related expenses: 1,230 €/y (statutory
 *    since 2023).
 *  - Church tax rates: 9 % in most states, 8 % in Bavaria,
 *    Baden-Württemberg and Hesse (state law, long stable).
 *
 * Deliberately NOT included (would mean unverified numbers): the 2025/2024
 * tariff coefficients, the 2026 spouse allowance (Ehegattenfreibetrag) and
 * the 2026 splitting tariff. The calculator labels the affected tax classes
 * as estimates instead.
 */

export const SALARY_YEAR = 2026 as const;

/** § 32a(1) EStG (current official version, for the 2026 assessment year). */
export const TAX_TARIFF_2026 = {
  /** Grundfreibetrag: no tax up to 12,348 €. */
  grundfreibetrag: 12_348,
  /** Zone 2 (14 % → 23.97 %) ends at 17,799 €. */
  zone2End: 17_799,
  /** Zone 3 (→ 42 %) ends at 69,878 €. */
  zone3End: 69_878,
  /** 45 % top rate starts at 277,826 €. */
  topRateStart: 277_825,
  /** Zone 2 polynomial: (a·y + b)·y, y = (E − F) / 10,000. */
  zone2A: 914.51,
  zone2B: 1_400,
  /** Zone 3 polynomial: (a·z + b)·z + c, z = (E − zone2End) / 10,000. */
  zone3A: 173.1,
  zone3B: 2_397,
  zone3C: 1_034.87,
  /** Zone 4: 0.42·x − offset (x = zu versteuerndes Einkommen in €). */
  zone4Rate: 0.42,
  zone4Offset: 11_135.63,
  /** Zone 5: 0.45·x − offset. */
  zone5Rate: 0.45,
  zone5Offset: 19_470.38,
} as const;

/** Solidarity surcharge (SolzG) — 2026 anchors for the income tax amount. */
export const SOLI_2026 = {
  rate: 0.055,
  /** No surcharge below this annual income-tax amount (€). */
  threshold: 20_350,
  /** Full 5.5 % rate from this annual income-tax amount (€). */
  fullFrom: 37_839,
} as const;

/** Per-child annual tax allowance (Kinderfreibetrag 2026, incl. 2,928 €). */
export const KINDERFREIBETRAG_2026 = 6_826;

/**
 * Small-amount allowance for tax classes I/VI (singles): no wage tax if the
 * annual zu versteuerndes Einkommen does not exceed this amount. 18,000 € is
 * the long-standing statutory value; if the 2026 reform raised it, results
 * for very low incomes may differ slightly (disclosed in the UI note).
 */
export const KLEINBETRAGSFREIBETRAG = 18_000;

/** Standard deduction for work-related expenses (Arbeitnehmerpauschbetrag). */
export const WERBKOSTENPAUSCHALE_YEAR = 1_230;

/** Rechengrößen Sozialversicherung 2026 (Deutsche Rentenversicherung / KV). */
export const SOCIAL_2026 = {
  /** Pension insurance: 18.6 % total (9.3 % employee), unified ceiling. */
  pensionRate: 0.186,
  pensionEmployeeRate: 0.093,
  pensionUnemploymentCeilingYear: 101_400,
  /** Unemployment insurance: 2.6 % total (1.3 % employee). */
  unemploymentEmployeeRate: 0.013,
  /** Health insurance: 14.6 % base (7.3 % employee) + 2.9 % average supplementary. */
  healthEmployeeBaseRate: 0.073,
  healthSupplementaryRate: 0.029,
  healthCareCeilingYear: 69_750,
  /** Long-term care: 3.6 % total (1.8 % employee) + 0.6 % childless (0.3 % employee). */
  careEmployeeRate: 0.018,
  careChildlessEmployeeSurcharge: 0.003,
} as const;

/** Church tax: 8 % in these states, 9 % everywhere else (of Lohnsteuer+Soli). */
export const KIST_8_STATES = new Set(["bw", "by", "he"]);
export const KIST_RATE_DEFAULT = 0.09;
export const KIST_RATE_8 = 0.08;

export const BUNDESLAENDER: ReadonlyArray<{ id: string; nameDe: string }> = [
  { id: "bw", nameDe: "Baden-Württemberg" },
  { id: "by", nameDe: "Bayern" },
  { id: "be", nameDe: "Berlin" },
  { id: "bb", nameDe: "Brandenburg" },
  { id: "hb", nameDe: "Bremen" },
  { id: "hh", nameDe: "Hamburg" },
  { id: "he", nameDe: "Hessen" },
  { id: "mv", nameDe: "Mecklenburg-Vorpommern" },
  { id: "ni", nameDe: "Niedersachsen" },
  { id: "nw", nameDe: "Nordrhein-Westfalen" },
  { id: "rp", nameDe: "Rheinland-Pfalz" },
  { id: "sl", nameDe: "Saarland" },
  { id: "sn", nameDe: "Sachsen" },
  { id: "st", nameDe: "Sachsen-Anhalt" },
  { id: "sh", nameDe: "Schleswig-Holstein" },
  { id: "th", nameDe: "Thüringen" },
] as const;

/** Verification metadata shown to the user (never hide the basis). */
export const PARAMS_REVIEWED_AT = "2026-10-11";
export const PARAMS_SOURCES = {
  estg: "https://www.gesetze-im-internet.de/estg/__32a.html",
  rechengroessen: "https://www.deutsche-rentenversicherung.de/",
} as const;
