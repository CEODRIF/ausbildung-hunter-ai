"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import { Button, Modal, Textarea } from "@/components/ui";

/**
 * Community Phase 5 — the report dialog.
 *
 * Exactly the 9 backend reasons (the server rejects anything else); the
 * reporter is ALWAYS the session user (the API never reads a client id),
 * duplicate reports are turned into a 409 by the partial unique index,
 * self-reports by the server-side authorship check, and the rate limit
 * (5/min) by the route. The dialog only translates the typed errors into
 * localized copy — it grants itself no privilege.
 */

export const REPORT_REASON_IDS = [
  "spam",
  "harassment",
  "hate",
  "scam",
  "misinformation",
  "sexual_content",
  "illegal_content",
  "impersonation",
  "other",
] as const;

export type ReportReasonId = (typeof REPORT_REASON_IDS)[number];
export type ReportTargetType = "message" | "question" | "answer" | "profile";

/** i18n key per reason (community.reportReason{Spam|Harassment|…}). */
const REASON_KEY: Record<ReportReasonId, string> = {
  spam: "community.reportReasonSpam",
  harassment: "community.reportReasonHarassment",
  hate: "community.reportReasonHate",
  scam: "community.reportReasonScam",
  misinformation: "community.reportReasonMisinformation",
  sexual_content: "community.reportReasonSexual",
  illegal_content: "community.reportReasonIllegal",
  impersonation: "community.reportReasonImpersonation",
  other: "community.reportReasonOther",
};

export interface ReportDialogProps {
  open: boolean;
  target: { type: ReportTargetType; id: string };
  onClose: () => void;
}

export function ReportDialog({ open, target, onClose }: ReportDialogProps) {
  const { t } = useI18n();
  const [reason, setReason] = useState<ReportReasonId | null>(null);
  const [details, setDetails] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Reset on every open (a previous submission must not leak in) —
  // React's documented "adjust state when props change" render-time
  // pattern (synchronous, no effect loop, no first-render skip).
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setReason(null);
      setDetails("");
      setError(null);
      setSuccess(false);
      setSubmitting(false);
    }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/community/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target_type: target.type,
          target_id: target.id,
          reason,
          details: details.trim() || null,
        }),
      });
      if (res.status === 201) {
        setSuccess(true);
        return;
      }
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      const code = data?.error ?? "";
      setError(
        code === "already_reported"
          ? t("community.reportDuplicate")
          : code === "self_report"
            ? t("community.reportSelfError")
            : code === "target_not_found"
              ? t("community.reportNotFound")
              : t("community.reportError"),
      );
    } catch {
      setError(t("community.reportError"));
    } finally {
      setSubmitting(false);
    }
  };

  const close = () => {
    if (submitting) return; // never swallow a mid-flight report
    onClose();
  };

  return (
    <Modal open={open} onClose={close} title={t("community.reportTitle")}>
      {success ? (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <p className="text-sm font-bold text-success">{t("community.reportSuccess")}</p>
          <p className="max-w-sm text-xs text-muted">{t("community.reportSuccessHint")}</p>
          <Button variant="secondary" onClick={close}>
            {t("community.cancel")}
          </Button>
        </div>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <p className="text-sm text-muted">{t("community.reportSubtitle")}</p>

          <fieldset>
            <legend className="mb-2 block text-xs font-semibold text-ink">
              {t("community.reportReasonLabel")}
            </legend>
            <div className="flex flex-col gap-1.5" role="radiogroup">
              {REPORT_REASON_IDS.map((id) => (
                <label
                  key={id}
                  className={`flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2 text-sm transition-colors ${
                    reason === id
                      ? "border-accent bg-accent-soft/40 text-ink"
                      : "border-line bg-surface text-muted hover:bg-surface-2"
                  }`}
                >
                  <input
                    type="radio"
                    name="report-reason"
                    value={id}
                    checked={reason === id}
                    onChange={() => setReason(id)}
                    className="accent-accent"
                  />
                  {t(REASON_KEY[id] as "community.reportReasonSpam")}
                </label>
              ))}
            </div>
          </fieldset>

          <Textarea
            label={t("community.reportDetailsLabel")}
            placeholder={t("community.reportDetailsPlaceholder")}
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            maxLength={1000}
            rows={3}
          />

          {error && (
            <p role="alert" className="text-xs font-semibold text-danger">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={close} disabled={submitting}>
              {t("community.cancel")}
            </Button>
            <Button type="submit" disabled={!reason || submitting}>
              {submitting ? t("community.reportSubmitting") : t("community.reportSubmit")}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
