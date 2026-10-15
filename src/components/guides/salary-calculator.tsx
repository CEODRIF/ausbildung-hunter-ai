"use client";

/**
 * Brutto → Netto calculator (2026, statutory values).
 *
 * Honesty rules enforced here:
 *  - Year selector: only 2026 is enabled; 2025/2024 are shown but disabled
 *    (their official parameters were not verified at build time — see
 *    src/lib/salary/params.ts).
 *  - Tax classes II–V: results are flagged as estimates (skNote) because the
 *    official 2026 Ehegattenfreibetrag / splitting tariff could not be
 *    verified at build time.
 *  - PKV: uses the user's own premium — no assumed rate.
 */
import { useMemo, useState } from "react";
import { dictionaries, useI18n } from "@/lib/i18n";
import {
  BUNDESLAENDER,
  PARAMS_SOURCES,
  SALARY_YEAR,
} from "@/lib/salary/params";
import {
  calculateSalary,
  type SalaryResult,
  type Steuerklasse,
} from "@/lib/salary/calculate";

const eur = (n: number): string =>
  n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function SalaryCalculator() {
  const { t, lang } = useI18n();

  const [grossText, setGrossText] = useState("4000");
  const [annualMode, setAnnualMode] = useState(false);
  const [sk, setSk] = useState<Steuerklasse>(1);
  const [pl, setPl] = useState("nw");
  const [kv, setKv] = useState<"gkv" | "pkv">("gkv");
  const [pkvText, setPkvText] = useState("500");
  const [church, setChurch] = useState(false);
  const [children, setChildren] = useState(0);
  const [result, setResult] = useState<SalaryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The params list is a string[] in the dictionary — t()/lookup only return
  // string leaves, so the array is read directly (typed per language).
  const params = useMemo(() => dictionaries[lang].guides.gehalt.params, [lang]);

  const calc = () => {
    const grossParsed = Number(grossText.replace(",", "."));
    if (!Number.isFinite(grossParsed) || grossParsed <= 0) {
      setError(t("guides.gehalt.brutto") + " ?");
      setResult(null);
      return;
    }
    let grossMonthly: number;
    if (annualMode) {
      grossMonthly = grossParsed / 12;
    } else {
      grossMonthly = grossParsed;
    }
    let pkvMonthly = 0;
    if (kv === "pkv") {
      pkvMonthly = Number(pkvText.replace(",", "."));
      if (!Number.isFinite(pkvMonthly) || pkvMonthly <= 0) {
        setError(t("guides.gehalt.pkvPremium") + " ?");
        setResult(null);
        return;
      }
    }
    setError(null);
    setResult(
      calculateSalary({
        grossMonthly,
        steuerklasse: sk,
        bundesland: pl,
        healthInsurance: kv,
        pkvMonthly,
        churchTax: church,
        children,
      }),
    );
  };

  const rows: Array<{ key: string; value: number; emphasize?: boolean }> = result
    ? [
        { key: "guides.gehalt.rowBrutto", value: result.monthly.gross },
        { key: "guides.gehalt.rowRv", value: result.monthly.pension },
        { key: "guides.gehalt.rowAv", value: result.monthly.unemployment },
        ...(kv === "gkv"
          ? [
              { key: "guides.gehalt.rowKv", value: result.monthly.health },
              { key: "guides.gehalt.rowPv", value: result.monthly.care },
            ]
          : [{ key: "guides.gehalt.rowPkv", value: result.monthly.privateHealth }]),
        { key: "guides.gehalt.rowLohnsteuer", value: result.monthly.incomeTax },
        { key: "guides.gehalt.rowSoli", value: result.monthly.soli },
        ...(church ? [{ key: "guides.gehalt.rowKist", value: result.monthly.churchTax }] : []),
        { key: "guides.gehalt.rowNetto", value: result.monthly.net, emphasize: true },
      ]
    : [];

  // Shared control styling: one 38px control height for inputs, selects and
  // segmented options (consistent radius, borders and focus states).
  const controlCls =
    "w-full min-h-[38px] rounded-xl border border-line-strong bg-surface px-3 py-2 text-sm font-semibold text-ink outline-none transition-colors focus:border-accent";
  const labelCls = "mb-1 block text-[11px] font-bold uppercase tracking-[0.08em] text-faint";
  // Segmented option (toggle): centered, accessible pressed state, keyboard
  // focus ring inset so it never spills outside the rounded group border.
  const segCls =
    "flex min-h-[38px] w-full items-center justify-center px-3 py-1.5 text-[11px] font-bold leading-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70";
  const segOn = "bg-accent text-white";
  const segOff = "bg-surface text-muted hover:text-ink";

  return (
    <div className="space-y-5">
      <p className="text-sm leading-relaxed text-muted">{t("guides.gehalt.intro")}</p>

      <div className="surface-elevated rounded-3xl p-5 sm:p-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {/* Gross — spans two columns so the amount input keeps a comfortable
              width next to the per-month/per-year control at every size
              (before, the fixed-width control squeezed the input to a
              single digit and pushed the card past the viewport). */}
          <div className="sm:col-span-2">
            <label className={labelCls} htmlFor="sal-gross">
              {t("guides.gehalt.bruttoLabel")}
            </label>
            <div className="flex items-stretch gap-2">
              <input
                id="sal-gross"
                inputMode="decimal"
                value={grossText}
                onChange={(e) => setGrossText(e.target.value)}
                className={`${controlCls} num min-w-[5rem] flex-1`}
                placeholder="4000"
              />
              <div className="grid shrink-0 grid-cols-2 overflow-hidden rounded-xl border border-line-strong">
                <button
                  type="button"
                  aria-pressed={!annualMode}
                  onClick={() => setAnnualMode(false)}
                  className={`${segCls} ${!annualMode ? segOn : segOff}`}
                >
                  {t("guides.gehalt.modeMonthly")}
                </button>
                <button
                  type="button"
                  aria-pressed={annualMode}
                  onClick={() => setAnnualMode(true)}
                  className={`${segCls} ${annualMode ? segOn : segOff}`}
                >
                  {t("guides.gehalt.modeAnnual")}
                </button>
              </div>
            </div>
          </div>

          {/* Year (2026 only, verified) */}
          <div>
            <label className={labelCls} htmlFor="sal-year">
              {t("guides.gehalt.yearLabel")}
            </label>
            <select id="sal-year" className={controlCls} value={String(SALARY_YEAR)} disabled>
              <option value="2026">2026</option>
              <option value="2025" disabled>
                {t("guides.gehalt.year2025")}
              </option>
              <option value="2024" disabled>
                {t("guides.gehalt.year2024")}
              </option>
            </select>
          </div>

          {/* Tax class */}
          <div>
            <label className={labelCls} htmlFor="sal-sk">
              {t("guides.gehalt.skLabel")}
            </label>
            <select
              id="sal-sk"
              className={controlCls}
              value={sk}
              onChange={(e) => setSk(Number(e.target.value) as Steuerklasse)}
            >
              <option value={1}>{t("guides.gehalt.skI")}</option>
              <option value={2}>{t("guides.gehalt.skII")}</option>
              <option value={3}>{t("guides.gehalt.skIII")}</option>
              <option value={4}>{t("guides.gehalt.skIV")}</option>
              <option value={5}>{t("guides.gehalt.skV")}</option>
              <option value={6}>{t("guides.gehalt.skVI")}</option>
            </select>
          </div>

          {/* Bundesland */}
          <div>
            <label className={labelCls} htmlFor="sal-pl">
              {t("guides.gehalt.plLabel")}
            </label>
            <select id="sal-pl" className={controlCls} value={pl} onChange={(e) => setPl(e.target.value)}>
              {BUNDESLAENDER.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.nameDe}
                </option>
              ))}
            </select>
          </div>

          {/* Health insurance — stacked equal-height options: the labels are
              long ("Statutory (GKV)"), so a full-width row per option keeps
              the text on one line and both options the same size. */}
          <div>
            <label className={labelCls}>{t("guides.gehalt.kvLabel")}</label>
            <div className="grid grid-rows-2 divide-y divide-line-strong overflow-hidden rounded-xl border border-line-strong">
              <button
                type="button"
                aria-pressed={kv === "gkv"}
                onClick={() => setKv("gkv")}
                className={`${segCls} ${kv === "gkv" ? segOn : segOff}`}
              >
                {t("guides.gehalt.kvGkv")}
              </button>
              <button
                type="button"
                aria-pressed={kv === "pkv"}
                onClick={() => setKv("pkv")}
                className={`${segCls} ${kv === "pkv" ? segOn : segOff}`}
              >
                {t("guides.gehalt.kvPkv")}
              </button>
            </div>
            {kv === "pkv" && (
              <input
                inputMode="decimal"
                value={pkvText}
                onChange={(e) => setPkvText(e.target.value)}
                className={`${controlCls} num mt-2`}
                placeholder="500"
                aria-label={t("guides.gehalt.pkvPremium")}
              />
            )}
          </div>

          {/* Church tax — same stacked pattern as health insurance (the
              explanatory "Yes" label is the longest control text on the
              form; a full-width row prevents the 5-line wrap and the
              unbalanced selected block). */}
          <div>
            <label className={labelCls}>{t("guides.gehalt.kistLabel")}</label>
            <div className="grid grid-rows-2 divide-y divide-line-strong overflow-hidden rounded-xl border border-line-strong">
              <button
                type="button"
                aria-pressed={church}
                onClick={() => setChurch(true)}
                className={`${segCls} ${church ? segOn : segOff}`}
              >
                {t("guides.gehalt.kistYes")}
              </button>
              <button
                type="button"
                aria-pressed={!church}
                onClick={() => setChurch(false)}
                className={`${segCls} ${!church ? segOn : segOff}`}
              >
                {t("guides.gehalt.kistNo")}
              </button>
            </div>
          </div>

          {/* Children */}
          <div>
            <label className={labelCls} htmlFor="sal-kinder">
              {t("guides.gehalt.kinderLabel")}
            </label>
            <select
              id="sal-kinder"
              className={controlCls}
              value={children}
              onChange={(e) => setChildren(Number(e.target.value))}
            >
              {[0, 1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        </div>

        <button
          type="button"
          onClick={calc}
          className="mt-5 w-full rounded-2xl bg-accent px-5 py-3 text-sm font-bold text-white shadow-sm transition-colors hover:bg-accent-deep sm:w-auto"
        >
          {t("guides.gehalt.calc")}
        </button>
        {error && <p className="mt-3 text-sm font-semibold text-danger">{error}</p>}
      </div>

      {result && (
        <div className="surface-elevated rounded-3xl p-5 sm:p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-bold tracking-tight text-ink">
              {t("guides.gehalt.resultTitle")}
            </h2>
            <span className="num text-3xl font-extrabold text-ink">
              {eur(result.monthly.net)} €
            </span>
          </div>
          <dl className="mt-4 divide-y divide-line">
            {rows.map((r) => (
              <div key={r.key} className="flex items-baseline justify-between gap-3 py-2">
                <dt
                  className={`text-sm ${r.emphasize ? "font-extrabold text-ink" : "text-muted"}`}
                >
                  {t(r.key)}
                  {r.key === "guides.gehalt.rowKv" && (
                    <span className="ms-2 text-[11px] text-faint">{t("guides.gehalt.kvNote")}</span>
                  )}
                </dt>
                <dd
                  className={`num text-sm ${
                    r.emphasize ? "font-extrabold text-success" : "font-semibold text-ink-soft"
                  }`}
                >
                  {r.value > 0 ? `− ${eur(r.value)} €` : "0,00 €"}
                </dd>
              </div>
            ))}
          </dl>
          <p className="num mt-3 text-xs text-faint">
            {t("guides.gehalt.annualNote", { annual: eur(result.annual.net) + " €" })}
          </p>

          <div className="mt-5 space-y-3 border-t border-line pt-4 text-xs leading-relaxed text-muted">
            <p className="font-semibold text-warning">
              ⚠ {t("guides.gehalt.disclaimer")}
            </p>
            {result.taxClassIsEstimate && (
              <p className="font-semibold text-warning">⚠ {t("guides.gehalt.skNote")}</p>
            )}
            {kv === "gkv" && <p>{t("guides.gehalt.pvNote")}</p>}
            {kv === "pkv" && <p>{t("guides.gehalt.pkvNote")}</p>}
            {result.kleinbetragsFreibetragApplied && <p>{t("guides.gehalt.kleinbetragsNote")}</p>}
          </div>

          <details className="mt-4 rounded-2xl border border-line bg-surface p-4">
            <summary className="cursor-pointer text-sm font-bold text-ink">
              {t("guides.gehalt.paramsTitle")}
            </summary>
            <ul className="mt-3 list-disc space-y-1.5 ps-5 text-xs leading-relaxed text-muted">
              {params.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            <p className="mt-3 text-xs font-semibold text-ink-soft">{t("guides.gehalt.lastReviewed")}</p>
            <p className="mt-2 text-xs text-muted">
              <a
                href={PARAMS_SOURCES.estg}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-accent underline-offset-2 hover:underline"
              >
                {t("guides.gehalt.sourceEStg")}
              </a>
              {" · "}
              <a
                href={PARAMS_SOURCES.rechengroessen}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-accent underline-offset-2 hover:underline"
              >
                {t("guides.gehalt.sourceRechengroessen")}
              </a>
            </p>
          </details>
        </div>
      )}
    </div>
  );
}
