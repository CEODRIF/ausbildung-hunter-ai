"use client";

/**
 * Step 3 — generate one distinct German Anschreiben per valid company.
 *
 * The engine is deliberately BOUNDED (≤5 letters per server call) so a
 * 100-company campaign never holds a request open for minutes. The client
 * therefore loops the server action until the engine reports `remaining === 0`
 * (or the AI daily quota parks the run). Retrying after partial failures uses
 * `onlyFailed` — the engine claims `failed` rows only, so already-generated
 * letters are never duplicated.
 */
import { memo, useState } from "react";
import { bewGenerateLetters } from "@/app/bewerbung-automation/actions";
import { useI18n } from "@/lib/i18n";
import { BEW_MAX_COUNT } from "@/lib/bewerbung-automation";
import { Button, Card } from "@/components/ui";
import { Icon } from "@/components/icon";
import { StatusPill } from "@/components/ui/feedback";
import type { BewViewDTO } from "./types";

interface Props {
  view: BewViewDTO;
  refresh: () => Promise<unknown>;
}

export const GenerateStep = memo(function GenerateStep({ view, refresh }: Props) {
  const { t } = useI18n();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const open = view.applications.filter(
    (a) => a.status !== "excluded" && a.status !== "cancelled",
  );
  const pending = open.filter((a) => a.status === "pending").length;
  const failed = open.filter((a) => a.status === "failed").length;
  const generated = open.filter(
    (a) =>
      a.status === "generated" ||
      a.status === "queued" ||
      a.status === "sending" ||
      a.status === "sent" ||
      a.status === "needs_attention",
  ).length;
  const total = open.length;
  const allDone = total > 0 && pending === 0 && failed === 0;

  async function runGeneration(onlyFailed: boolean) {
    setRunning(true);
    setError(null);
    setNotice(null);
    try {
      let guard = 0;
      // Bounded loop: each server call processes ≤5 letters (BEW_MAX_BATCH).
      // The engine's `remaining` is the authoritative stop signal.
      while (guard < Math.ceil(BEW_MAX_COUNT / 5) + 1) {
        guard += 1;
        const fd = new FormData();
        fd.set("campaignId", view.campaign.id);
        fd.set("onlyFailed", onlyFailed ? "1" : "0");
        const result = await bewGenerateLetters(fd);
        await refresh();
        setProgress({ done: total - result.remaining, total });
        if (result.aiQuotaHit) {
          setNotice(t("bewauto.aiQuota"));
          break;
        }
        if (result.remaining === 0) break;
        // Defensive: a batch that claimed nothing must not loop forever.
        if (result.generated === 0 && result.failed === 0) break;
      }
    } catch (e) {
      setError(errMessage(e, t));
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  return (
    <Card className="p-6">
      <div className="mb-5">
        <h2 className="text-lg font-bold text-ink">{t("bewauto.step3Title")}</h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">{t("bewauto.step3Body")}</p>
        <p className="mt-2 max-w-2xl text-xs leading-5 text-faint">{t("bewauto.genPrivacyNote")}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <StatusPill tone="neutral" label={t("bewauto.genTotal", { n: total })} />
        <StatusPill tone="success" label={t("bewauto.genGenerated", { n: generated })} />
        <StatusPill tone={pending > 0 ? "unverified" : "neutral"} label={t("bewauto.genPending", { n: pending })} />
        <StatusPill tone={failed > 0 ? "blocked" : "neutral"} label={t("bewauto.genFailed", { n: failed })} />
      </div>

      {progress && (
        <div className="mt-4" role="status">
          <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full bg-accent transition-all"
              style={{ width: `${Math.round((progress.done / Math.max(progress.total, 1)) * 100)}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-muted">
            {t("bewauto.genWorking", { done: progress.done, total: progress.total })}
          </p>
        </div>
      )}

      {error && <p role="alert" className="mt-4 text-sm font-medium text-danger">{error}</p>}
      {notice && !error && <p role="status" className="mt-4 text-sm font-medium text-success">{notice}</p>}

      <div className="mt-6 flex flex-wrap gap-3">
        <Button
          size="lg"
          disabled={running || (pending === 0 && generated === 0)}
          onClick={() => void runGeneration(false)}
        >
          <Icon name="spark" size={18} />
          {allDone ? t("bewauto.genRerun") : t("bewauto.genStart")}
        </Button>
        {failed > 0 && (
          <Button
            variant="secondary"
            size="lg"
            disabled={running}
            onClick={() => void runGeneration(true)}
          >
            <Icon name="reply" size={16} />
            {t("bewauto.genRetryFailed", { n: failed })}
          </Button>
        )}
      </div>
    </Card>
  );
});

function errMessage(e: unknown, t: (k: string, v?: Record<string, string | number>) => string): string {
  const code = e instanceof Error ? e.message : "";
  const key = `bewauto.err.${code}`;
  const translated = t(key);
  return translated === key ? t("bewauto.err.UNKNOWN") : translated;
}
