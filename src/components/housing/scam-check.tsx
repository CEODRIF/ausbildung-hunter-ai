"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/icon";
import { Button, Textarea } from "@/components/ui";
import type { ScamCheckResult, ScamRiskLevel } from "@/lib/housing/types";

type Phase = "idle" | "loading" | "done" | "error";

const RISK_STYLE: Record<ScamRiskLevel, { ring: string; text: string; icon: "check" | "alert" }> = {
  low: { ring: "border-success/30 bg-success-soft text-success", text: "text-success", icon: "check" },
  medium: { ring: "border-warning/30 bg-warning-soft text-warning", text: "text-warning", icon: "alert" },
  high: { ring: "border-danger/30 bg-danger-soft text-danger", text: "text-danger", icon: "alert" },
};

/**
 * Miet-Check — paste a listing or the landlord's message and get scam
 * indicators. Heuristics always run (offline); an optional AI summary is added
 * on top. `initialText` (a `?text=` deep link, read server-side by the page)
 * prefills the field via lazy state init — no client URL parsing, so SSR and
 * hydration always agree.
 */
export function ScamCheck({ initialText = "" }: { initialText?: string }) {
  const { t } = useI18n();
  const [text, setText] = useState(initialText);
  const [useAi, setUseAi] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<ScamCheckResult | null>(null);

  async function run() {
    if (!text.trim()) return;
    setPhase("loading");
    setResult(null);
    try {
      const res = await fetch("/api/housing/scam-check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, useAi }),
      });
      if (!res.ok) {
        setPhase("error");
        return;
      }
      setResult((await res.json()) as ScamCheckResult);
      setPhase("done");
    } catch {
      setPhase("error");
    }
  }

  const riskKey = result?.risk
    ? ({ low: "riskLow", medium: "riskMedium", high: "riskHigh" } as const)[result.risk]
    : null;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {/* input */}
      <div className="space-y-4 rounded-3xl border border-line bg-surface p-5 shadow-[var(--shadow-card)] sm:p-6">
        <Textarea
          label={t("housing.scamTitle")}
          placeholder={t("housing.scamPlaceholder")}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="min-h-44"
        />
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-soft">
          <input
            type="checkbox"
            checked={useAi}
            onChange={(e) => setUseAi(e.target.checked)}
            className="h-4 w-4 rounded accent-accent"
          />
          {t("housing.scamAi")}
        </label>
        <Button onClick={() => void run()} disabled={!text.trim() || phase === "loading"} className="w-full">
          <Icon name="shield" size={16} strokeWidth={1.8} />
          {phase === "loading" ? t("housing.scamChecking") : t("housing.scamCheck")}
        </Button>
      </div>

      {/* result */}
      <div className="space-y-4">
        {phase === "idle" && (
          <div className="flex h-full min-h-48 flex-col items-center justify-center rounded-3xl border border-dashed border-line-strong bg-surface p-6 text-center">
            <Icon name="shield" size={30} strokeWidth={1.5} className="text-faint" />
            <p className="mt-3 max-w-60 text-sm text-muted">{t("housing.scamSubtitle")}</p>
          </div>
        )}

        {phase === "loading" && (
          <div className="flex h-full min-h-48 items-center justify-center rounded-3xl border border-line bg-surface p-6">
            <p className="flex items-center gap-2 text-sm text-muted">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
              {t("housing.scamChecking")}
            </p>
          </div>
        )}

        {phase === "error" && (
          <div className="rounded-3xl border border-danger/30 bg-danger-soft p-6 text-sm text-danger">
            {t("housing.scamError")}
            <Button variant="secondary" size="sm" className="mt-3" onClick={() => setPhase("idle")}>
              {t("common.retry")}
            </Button>
          </div>
        )}

        {phase === "done" && result && (
          <>
            <div className={`flex items-center gap-3 rounded-3xl border p-5 shadow-[var(--shadow-card)] ${RISK_STYLE[result.risk].ring}`}>
              <Icon name={RISK_STYLE[result.risk].icon} size={22} strokeWidth={2.2} className={RISK_STYLE[result.risk].text} />
              <div>
                <p className={`text-lg font-extrabold ${RISK_STYLE[result.risk].text}`}>
                  {riskKey ? t(`housing.${riskKey}`) : ""}
                </p>
                <p className="text-xs text-muted">
                  {result.findings.length} {t("housing.scamFindings").toLowerCase()}
                </p>
              </div>
            </div>

            {result.findings.length === 0 ? (
              <p className="rounded-2xl border border-success/25 bg-success-soft p-4 text-sm text-success">
                {t("housing.scamNone")}
              </p>
            ) : (
              <ul className="space-y-2">
                {result.findings.map((finding) => (
                  <li
                    key={finding.id}
                    className="flex items-start gap-3 rounded-2xl border border-line bg-surface p-3.5 text-sm"
                  >
                    <span
                      className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
                        RISK_STYLE[finding.severity].ring
                      }`}
                    >
                      <Icon
                        name={finding.severity === "low" ? "alert" : "alert"}
                        size={13}
                        strokeWidth={2.2}
                      />
                    </span>
                    <span className="text-ink-soft">{finding.message}</span>
                  </li>
                ))}
              </ul>
            )}

            {result.ai_summary && (
              <div className="rounded-2xl border border-ai/25 bg-ai-soft p-4">
                <p className="mb-1.5 inline-flex items-center gap-1.5 text-xs font-bold text-ai-deep">
                  <Icon name="spark" size={12} strokeWidth={2} /> KI-Analyse
                </p>
                <p className="whitespace-pre-wrap text-sm leading-6 text-ink">{result.ai_summary}</p>
                <p className="mt-2 text-[11px] text-muted">{t("housing.scamAiNote")}</p>
              </div>
            )}

            <p className="rounded-2xl bg-surface-2 p-4 text-xs leading-5 text-muted">
              {t("housing.scamHint")}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
