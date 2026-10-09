"use client";

import { useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/icon";
import { Input } from "@/components/ui";
import {
  computeAffordability,
  formatEur,
  maxAffordableWarmRent,
  RENT_SHARE_GUIDELINE,
} from "@/lib/housing/affordability";

function toNum(value: string): number {
  const n = Number(value.replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Mietkosten-Rechner — pure client-side cost math (no API call, no secrets).
 * Recomputes live as the user types; the 30% rule-of-thumb drives the
 * "affordable" verdict.
 */
export function AffordabilityCalculator() {
  const { t } = useI18n();
  const [income, setIncome] = useState("");
  const [warm, setWarm] = useState("");
  const [other, setOther] = useState("");
  const [depositMonths, setDepositMonths] = useState("2");

  const result = useMemo(() => {
    const net = toNum(income);
    if (net <= 0) return null;
    return computeAffordability({
      net_monthly_income: net,
      warm_rent: toNum(warm),
      other_monthly_costs: toNum(other),
      deposit_months: toNum(depositMonths),
    });
  }, [income, warm, other, depositMonths]);

  const maxWarm = useMemo(() => maxAffordableWarmRent(toNum(income)), [income]);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div className="space-y-4 rounded-3xl border border-line bg-surface p-5 shadow-[var(--shadow-card)] sm:p-6">
        <Input
          label={t("housing.calcIncome")}
          inputMode="decimal"
          placeholder="1800"
          value={income}
          onChange={(e) => setIncome(e.target.value)}
        />
        <Input
          label={t("housing.calcWarmRent")}
          inputMode="decimal"
          placeholder="900"
          value={warm}
          onChange={(e) => setWarm(e.target.value)}
        />
        <Input
          label={t("housing.calcOther")}
          inputMode="decimal"
          placeholder="120"
          value={other}
          onChange={(e) => setOther(e.target.value)}
        />
        <Input
          label={t("housing.calcDepositMonths")}
          inputMode="decimal"
          placeholder="2"
          value={depositMonths}
          onChange={(e) => setDepositMonths(e.target.value)}
        />
      </div>

      <div className="space-y-4">
        {result ? (
          <>
            <div
              className={`rounded-3xl border p-5 shadow-[var(--shadow-card)] sm:p-6 ${
                result.affordable
                  ? "border-success/30 bg-success-soft"
                  : "border-danger/30 bg-danger-soft"
              }`}
            >
              <div className="flex items-center gap-2 text-sm font-bold">
                <Icon
                  name={result.affordable ? "check" : "alert"}
                  size={16}
                  strokeWidth={2.2}
                  className={result.affordable ? "text-success" : "text-danger"}
                />
                <span className={result.affordable ? "text-success" : "text-danger"}>
                  {result.affordable ? t("housing.calcAffordable") : t("housing.calcHigh")}
                </span>
              </div>
              <p className="mt-3 text-3xl font-extrabold text-ink">
                {formatEur(result.monthly_total)}
                <span className="ms-1 text-sm font-semibold text-muted">/Monat</span>
              </p>
              <p className="mt-1 text-xs text-muted">{t("housing.calcMonthly")}</p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-2xl border border-line bg-surface p-4">
                <p className="text-xs text-muted">{t("housing.calcShare")}</p>
                <p className="mt-1 text-xl font-extrabold text-ink">
                  {Math.round(result.rent_share * 100)} %
                </p>
              </div>
              <div className="rounded-2xl border border-line bg-surface p-4">
                <p className="text-xs text-muted">{t("housing.calcDeposit")}</p>
                <p className="mt-1 text-xl font-extrabold text-ink">
                  {formatEur(result.deposit_total)}
                </p>
              </div>
              <div className="col-span-2 rounded-2xl border border-line bg-surface p-4">
                <p className="text-xs text-muted">{t("housing.calcMaxWarm")}</p>
                <p className="mt-1 text-xl font-extrabold text-accent">{formatEur(maxWarm)}</p>
              </div>
            </div>

            <p className="rounded-2xl bg-surface-2 p-4 text-xs leading-5 text-muted">
              {t("housing.calcGuideline")}
            </p>
          </>
        ) : (
          <div className="flex h-full min-h-48 flex-col items-center justify-center rounded-3xl border border-dashed border-line-strong bg-surface p-6 text-center">
            <Icon name="chart" size={30} strokeWidth={1.5} className="text-faint" />
            <p className="mt-3 text-sm text-muted">
              {Math.round(RENT_SHARE_GUIDELINE * 100)} % · {t("housing.calcGuideline")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
