"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/icon";
import { Button, Input, Textarea } from "@/components/ui";
import { formatEur } from "@/lib/housing/affordability";
import type { HousingListing } from "@/lib/housing/types";

interface Props {
  listing: HousingListing;
}

type Phase = "form" | "loading" | "done" | "error";

/**
 * Bewerbungs-Assistent — prepares a professional landlord message for a
 * specific listing and persists it via /api/housing/application. The listing is
 * fixed (passed in); only the applicant's OWN details are entered.
 */
export function ApplicationAssistant({ listing }: Props) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>("form");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [occupation, setOccupation] = useState("");
  const [moveInDate, setMoveInDate] = useState("");
  const [note, setNote] = useState("");
  const [draft, setDraft] = useState<string | null>(null);
  const [aiAssisted, setAiAssisted] = useState(false);
  const [copied, setCopied] = useState(false);

  const canSubmit = firstName.trim() !== "" && lastName.trim() !== "";

  async function generate() {
    if (!canSubmit) return;
    setPhase("loading");
    try {
      const res = await fetch("/api/housing/application", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: listing.provider,
          sourceId: listing.source_id,
          context: {
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            occupation: occupation.trim() || null,
            moveInDate: moveInDate || null,
            note: note.trim() || null,
          },
        }),
      });
      const data = (await res.json()) as { ai_assisted?: boolean; application?: { message_draft: string | null } };
      if (!res.ok || !data.application?.message_draft) {
        setPhase("error");
        return;
      }
      setDraft(data.application.message_draft);
      setAiAssisted(Boolean(data.ai_assisted));
      setPhase("done");
    } catch {
      setPhase("error");
    }
  }

  async function copy() {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable — ignore */
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-2xl bg-surface-2 p-3 text-sm">
        <Icon name="home" size={16} strokeWidth={1.8} className="mt-0.5 text-accent" />
        <div className="min-w-0">
          <p className="truncate font-semibold text-ink">{listing.title}</p>
          <p className="text-xs text-muted">
            {[listing.city, listing.postal_code].filter(Boolean).join(", ")}
            {listing.rent_warm_eur != null && ` · ${formatEur(listing.rent_warm_eur)} ${t("housing.warm")}`}
          </p>
        </div>
      </div>

      {phase === "form" && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input
              label={t("housing.appFirstName")}
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              required
            />
            <Input
              label={t("housing.appLastName")}
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              required
            />
            <Input
              label={t("housing.appOccupation")}
              value={occupation}
              onChange={(e) => setOccupation(e.target.value)}
            />
            <Input
              label={t("housing.appMoveIn")}
              type="date"
              value={moveInDate}
              onChange={(e) => setMoveInDate(e.target.value)}
            />
          </div>
          <Textarea
            label={t("housing.appNote")}
            placeholder={t("housing.appNotePlaceholder")}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <Button onClick={() => void generate()} disabled={!canSubmit} className="w-full">
            <Icon name="spark" size={16} strokeWidth={1.8} />
            {t("housing.appGenerate")}
          </Button>
        </>
      )}

      {phase === "loading" && (
        <p className="flex items-center gap-2 text-sm text-muted">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
          {t("housing.appGenerating")}
        </p>
      )}

      {phase === "error" && (
        <div className="rounded-2xl border border-danger/30 bg-danger-soft p-4 text-sm text-danger">
          {t("housing.appError")}
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => setPhase("form")}>
            {t("common.retry")}
          </Button>
        </div>
      )}

      {phase === "done" && draft && (
        <>
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold text-ink-soft">{t("housing.appDraft")}</span>
              {aiAssisted && (
                <span className="inline-flex items-center gap-1 rounded-full bg-ai-soft px-2 py-0.5 text-[11px] font-bold text-ai-deep">
                  <Icon name="spark" size={11} strokeWidth={2} />
                  {t("housing.appAi")}
                </span>
              )}
            </div>
            <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-2xl border border-line bg-surface-2 p-4 text-sm leading-6 text-ink">
              {draft}
            </pre>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => void copy()} className="flex-1">
              <Icon name={copied ? "check" : "download"} size={16} strokeWidth={1.8} />
              {copied ? t("housing.appCopied") : t("housing.appCopy")}
            </Button>
            <Button variant="ghost" onClick={() => setPhase("form")}>
              {t("common.close")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
