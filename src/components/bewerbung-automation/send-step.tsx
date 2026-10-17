"use client";

/**
 * Step 5 — explicit confirmation + safe send + live progress.
 *
 * Delivery happens ONLY here and ONLY after the user confirms the final
 * dialog (recipient count, sending mailbox, attachments policy). The server
 * then re-verifies identity, ownership, sender health, content, and quota
 * before queueing anything (startBewSend). While the campaign drains, the
 * view is polled (client.tsx) and the actual per-message outcome is shown —
 * a message is "sent" only because the provider answered success.
 */
import { useMemo, useState } from "react";
import { bewStartSend } from "@/app/bewerbung-automation/actions";
import { useI18n } from "@/lib/i18n";
import {
  BEW_PLATFORM_DAILY_CAP,
  computeSendPlan,
} from "@/lib/bewerbung-automation";
import { Button, Card } from "@/components/ui";
import { Icon } from "@/components/icon";
import { StatusPill } from "@/components/ui/feedback";
import {
  appSendFlags,
  hasRequiredDocuments,
  type BewViewDTO,
} from "./types";

interface Props {
  view: BewViewDTO;
  refresh: () => Promise<void>;
  selectedIds: Set<string>;
  onCancelSend: () => void;
  sending: boolean;
}

export function SendStep({ view, refresh, selectedIds, onCancelSend, sending }: Props) {
  const { t } = useI18n();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const docs = hasRequiredDocuments(view.documents);
  const certCount = view.documents.filter(
    (d) => d.kind === "certificate" || d.kind === "supporting",
  ).length;

  const eligibleSelected = useMemo(
    () =>
      view.applications.filter(
        (a) =>
          selectedIds.has(a.id) &&
          appSendFlags(a).length === 0 &&
          docs.cv &&
          docs.certs,
      ),
    [view.applications, selectedIds, docs.cv, docs.certs],
  );
  const n = eligibleSelected.length;

  const plan = useMemo(
    () =>
      computeSendPlan({
        requested: n,
        remaining: view.usage.remaining,
        platformCap: BEW_PLATFORM_DAILY_CAP,
      }),
    [n, view.usage.remaining],
  );

  async function confirmAndSend() {
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("campaignId", view.campaign.id);
      fd.set("selectedSeqs", JSON.stringify(eligibleSelected.map((a) => a.seq)));
      const result = await bewStartSend(fd);
      setConfirmOpen(false);
      if (!result.ok) {
        setError(result.error ? errCodeMessage(result.error, t) : t("bewauto.err.UNKNOWN"));
      }
      await refresh();
    } catch (e) {
      setError(errMessage(e, t));
    } finally {
      setBusy(false);
    }
  }

  const c = view.campaign;
  const queued = view.applications.filter((a) => a.status === "queued").length;
  const inSending = view.applications.filter((a) => a.status === "sending").length;
  const sent = c.sent_count;
  const failed = view.applications.filter((a) => a.status === "failed").length;
  const attention = view.applications.filter((a) => a.status === "needs_attention").length;

  return (
    <Card className="p-6">
      <div className="mb-5">
        <h2 className="text-lg font-bold text-ink">{t("bewauto.step5Title")}</h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">{t("bewauto.step5Body")}</p>
      </div>

      {/* Pre-send blocker messages */}
      {error && <p role="alert" className="mb-4 text-sm font-medium text-danger">{error}</p>}
      {!view.senderEmail && (
        <div role="alert" className="mb-4 flex items-start gap-2.5 rounded-2xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">
          <Icon name="alert" size={16} className="mt-0.5 shrink-0" />
          <span>{t("bewauto.noSender")}</span>
        </div>
      )}
      {view.senderEmail && !docs.cv && (
        <p role="alert" className="mb-4 text-sm font-medium text-danger">{t("bewauto.flagMissingCv")}</p>
      )}
      {view.senderEmail && docs.cv && !docs.certs && (
        <p role="alert" className="mb-4 text-sm font-medium text-danger">{t("bewauto.flagMissingCerts")}</p>
      )}

      {/* Live progress while draining */}
      {sending && (
        <div className="mb-6 rounded-2xl border border-line bg-surface-2/40 p-4" role="status">
          <p className="mb-3 text-sm font-semibold text-ink-soft">{t("bewauto.progressTitle")}</p>
          <div className="flex flex-wrap gap-2">
            <StatusPill tone="success" label={t("bewauto.stSentCount", { n: sent })} />
            <StatusPill tone="running" label={t("bewauto.stSendingCount", { n: inSending })} />
            <StatusPill tone="neutral" label={t("bewauto.stQueuedCount", { n: queued })} />
            <StatusPill tone="blocked" label={t("bewauto.stFailedCount", { n: failed })} />
            <StatusPill tone="unverified" label={t("bewauto.stAttentionCount", { n: attention })} />
          </div>
          {(queued > 0 || inSending > 0) && (
            <div className="mt-4">
              <Button variant="ghost" size="sm" disabled={busy} className="text-danger hover:text-danger" onClick={onCancelSend}>
                <Icon name="stop" size={14} />
                {t("bewauto.cancelSend")}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Final outcome */}
      {!sending && (sent + failed + attention > 0) && (
        <div className="mb-6 rounded-2xl border border-line bg-surface-2/40 p-4">
          <p className="text-sm font-semibold text-ink-soft">{t("bewauto.resultTitle")}</p>
          <p className="mt-2 text-sm text-ink-soft">
            {t("bewauto.sentSummary", { sent, failed, attention })}
          </p>
          {attention > 0 && (
            <p className="mt-2 text-xs leading-5 text-muted">{t("bewauto.attentionNote")}</p>
          )}
        </div>
      )}

      {/* The explicit send trigger */}
      {!sending && (
        <div className="flex flex-col items-start gap-3 rounded-2xl border border-accent/30 bg-accent-soft/40 p-5">
          <Button
            size="lg"
            disabled={busy || n === 0 || !view.senderEmail || !(docs.cv && docs.certs)}
            onClick={() => setConfirmOpen(true)}
          >
            <Icon name="send" size={18} />
            {t("bewauto.sendButton", { n })}
          </Button>
          {n === 0 && (
            <p className="text-xs text-muted">{t("bewauto.nothingToSend")}</p>
          )}
        </div>
      )}

      {/* Final confirmation dialog */}
      {confirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-label={t("bewauto.confirmTitle")}
          onClick={(e) => {
            if (e.target === e.currentTarget) setConfirmOpen(false);
          }}
        >
          <div className="w-full max-w-lg rounded-t-3xl bg-surface p-6 shadow-2xl sm:rounded-3xl">
            <h3 className="text-lg font-bold text-ink">{t("bewauto.confirmTitle")}</h3>
            <dl className="mt-4 space-y-2.5 text-sm">
              <ConfirmRow label={t("bewauto.confirmRecipients", { n })} />
              <ConfirmRow
                label={
                  view.senderEmail
                    ? t("bewauto.confirmSender", { email: view.senderEmail })
                    : t("bewauto.noSender")
                }
              />
              <ConfirmRow
                label={t("bewauto.confirmAttachments", { n: certCount + 1 })}
              />
              <ConfirmRow
                label={t("bewauto.confirmQuota", {
                  remaining: view.usage.remaining,
                  limit: view.usage.daily_limit || BEW_PLATFORM_DAILY_CAP,
                })}
              />
            </dl>
            {plan.overLimit && (
              <p role="alert" className="mt-4 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2.5 text-xs leading-5 text-danger">
                {t("bewauto.overLimitNote", { batch: plan.batch, total: n, deferred: plan.deferred })}
              </p>
            )}
            <div className="mt-6 flex items-center justify-end gap-3">
              <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(false)}>
                {t("bewauto.confirmCancel")}
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void confirmAndSend()}>
                <Icon name="send" size={15} />
                {t("bewauto.confirmGo")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

function ConfirmRow({ label }: { label: string }) {
  return (
    <div className="flex items-start gap-2">
      <Icon name="check" size={15} className="mt-0.5 shrink-0 text-success" />
      <dd className="text-ink-soft">{label}</dd>
    </div>
  );
}

function errMessage(e: unknown, t: (k: string, v?: Record<string, string | number>) => string): string {
  const code = e instanceof Error ? e.message : "";
  const key = `bewauto.err.${code}`;
  const translated = t(key);
  return translated === key ? t("bewauto.err.UNKNOWN") : translated;
}

function errCodeMessage(code: string, t: (k: string, v?: Record<string, string | number>) => string): string {
  const translated = t(`bewauto.err.${code}`);
  return translated === `bewauto.err.${code}` ? t("bewauto.err.UNKNOWN") : translated;
}
