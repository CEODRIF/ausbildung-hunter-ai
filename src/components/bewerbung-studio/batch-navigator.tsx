"use client";

/**
 * AI Bewerbung Studio — batch navigator (the slot list).
 *
 * Desktop: compact left column. Mobile: horizontal snap-scroll strip on top
 * of the single-column editor (no horizontal PAGE overflow — the strip
 * scrolls internally).
 *
 * Shows per slot: company / position / city, current status, completion
 * progress, validation issues (the exact missing requirements), locked
 * state with the exact reason, and the actions (open, remove-after-
 * confirmation, add). The data is the server-computed batch view — never
 * client-guessed.
 */

import { useState } from "react";
import { Icon } from "@/components/icon";
import { useI18n } from "@/lib/i18n";
import type { StudioBatchView, StudioBatchAppView } from "@/lib/studio";
import { STUDIO_BATCH_INITIAL_SLOTS, type StudioCompletionKey } from "@/lib/studio/completion";
import { StatusBadge } from "./studio-ui";

const REQ_KEYS: Record<StudioCompletionKey, string> = {
  ad: "studio.reqAd",
  profile: "studio.reqProfile",
  cv: "studio.reqCv",
  letter: "studio.reqLetter",
  docs: "studio.reqDocs",
  email: "studio.reqEmail",
  quality: "studio.reqQuality",
};

function companyOf(view: StudioBatchAppView): string {
  return view.app.ad_extracted?.company?.trim() || "—";
}
function titleOf(view: StudioBatchAppView): string {
  const e = view.app.ad_extracted;
  return e?.jobTitle?.trim() || e?.occupation?.trim() || "—";
}
function cityOf(view: StudioBatchAppView): string {
  return view.app.ad_extracted?.location?.trim() || "";
}

interface SlotCardProps {
  view: StudioBatchAppView;
  index: number;
  active: boolean;
  compact?: boolean;
  onOpen: () => void;
  onRemove: () => void;
}

function SlotCard({ view, index, active, compact = false, onOpen, onRemove }: SlotCardProps) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const { slot, completion, app } = view;
  const company = companyOf(view);
  const title = titleOf(view);
  const city = cityOf(view);

  const missingLabels = completion.missing.map((k) => t(REQ_KEYS[k]));
  const pct = Math.round(completion.progress * 100);

  return (
    <div
      className={[
        "relative flex flex-col rounded-2xl border bg-surface p-3 text-left transition",
        compact ? "min-w-[210px] max-w-[240px] snap-start" : "w-full",
        active ? "border-primary ring-1 ring-primary/40" : "border-border",
        !slot.unlocked ? "opacity-70" : "",
      ].join(" ")}
    >
      <button
        type="button"
        onClick={onOpen}
        disabled={!slot.unlocked && app.status === "draft" && !completion.complete}
        className="w-full rounded-xl text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        aria-current={active ? "true" : undefined}
      >
        <div className="flex items-start gap-2.5">
          <span
            className={[
              "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold",
              completion.complete
                ? "bg-success/15 text-success"
                : slot.unlocked
                  ? "bg-primary/10 text-primary"
                  : "bg-muted text-muted",
            ].join(" ")}
          >
            {completion.complete ? <Icon name="check" size={12} strokeWidth={3} /> : index + 1}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-semibold">{company}</span>
              <StatusBadge status={app.status} />
            </span>
            <span className="mt-0.5 block truncate text-xs text-muted">
              {title}
              {city ? ` · ${city}` : ""}
            </span>
            {/* completion progress */}
            <span className="mt-2 flex items-center gap-2">
              <span className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                <span
                  className="block h-full rounded-full bg-primary transition-all"
                  style={{ width: `${pct}%` }}
                />
              </span>
              <span className="shrink-0 text-[11px] font-medium text-muted">
                {completion.missing.length === 0 ? t("studio.navComplete") : `${completion.missing.length} ✕`}
              </span>
            </span>
            {/* the exact validation issues / lock reason */}
            {missingLabels.length > 0 ? (
              <span className="mt-1.5 block text-[11px] leading-4 text-warning">
                {slot.unlocked ? (
                  missingLabels.slice(0, 2).join(" · ")
                ) : (
                  <span className="inline-flex items-start gap-1">
                    <Icon name="lock" size={11} className="mt-0.5 shrink-0" />
                    {t("studio.navLockedHint", { missing: missingLabels.slice(0, 2).join(" · ") })}
                  </span>
                )}
              </span>
            ) : null}
          </span>
        </div>
      </button>

      {/* remove — two-step confirmation, no window.confirm */}
      {confirming ? (
        <div className="absolute right-2 top-2 flex items-center gap-1 rounded-xl border border-danger/40 bg-surface px-2 py-1 shadow-sm">
          <span className="text-[11px] font-medium text-danger">{t("studio.navDeleteQ")}</span>
          <button
            type="button"
            onClick={onRemove}
            className="rounded-lg bg-danger px-1.5 py-0.5 text-[11px] font-semibold text-white"
          >
            {t("studio.navDeleteYes")}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="rounded-lg px-1.5 py-0.5 text-[11px] font-medium text-muted hover:text-foreground"
          >
            {t("studio.navDeleteNo")}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          aria-label={t("studio.navDelete")}
          title={t("studio.navDelete")}
          className="absolute right-2 top-2 rounded-lg p-1 text-faint transition hover:bg-danger/10 hover:text-danger"
        >
          <Icon name="trash" size={13} />
        </button>
      )}
    </div>
  );
}

export function BatchNavigator({
  batch,
  activeAppId,
  onOpen,
  onNew,
  onRemove,
  addBusy = false,
}: {
  batch: StudioBatchView;
  activeAppId: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onRemove: (id: string) => void;
  addBusy?: boolean;
}) {
  const { t } = useI18n();
  const { apps, limit, completeCount, canAdd, missingForBlockingApp } = batch;

  const blockingCompany = batch.blockingAppId
    ? apps.find((a) => a.app.id === batch.blockingAppId)
    : undefined;
  const addLabel =
    apps.length >= limit
      ? t("studio.navFull")
      : canAdd
        ? t("studio.navAdd")
        : t("studio.navBlocked", {
            company: blockingCompany ? companyOf(blockingCompany) : "—",
          });
  const blockedMissing =
    canAdd || apps.length >= limit
      ? []
      : missingForBlockingApp.map((k) => t(REQ_KEYS[k]));

  const list = (variant: "column" | "strip") => (
    <div
      className={
        variant === "column"
          ? "flex flex-col gap-2.5"
          : "flex snap-x snap-mandatory gap-2.5 overflow-x-auto pb-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      }
    >
      {apps.map((v, i) => (
        <SlotCard
          key={v.app.id}
          view={v}
          index={i}
          active={v.app.id === activeAppId}
          compact={variant === "strip"}
          onOpen={() => onOpen(v.app.id)}
          onRemove={() => onRemove(v.app.id)}
        />
      ))}
      {/* empty slots: five initial slots, expandable to the limit. The FIRST
          empty slot is the actionable one (add / blocked / full); the rest
          are passive placeholders (sequential unlocking means only the next
          slot can ever be created). */}
      {apps.length < limit ? (
        Array.from({ length: Math.min(limit, Math.max(apps.length, STUDIO_BATCH_INITIAL_SLOTS)) - apps.length }, (_, gi) =>
          gi === 0 ? (
            <button
              key="ghost"
              type="button"
              onClick={canAdd ? onNew : undefined}
              disabled={!canAdd || addBusy}
              className={[
                "flex min-h-[72px] items-center justify-center gap-2 rounded-2xl border border-dashed text-sm font-medium transition",
                variant === "strip" ? "min-w-[180px] shrink-0 snap-start" : "w-full",
                canAdd
                  ? "border-primary/50 text-primary hover:bg-primary/5"
                  : "cursor-not-allowed border-border text-faint",
              ].join(" ")}
            >
              <Icon name="plus" size={15} />
              {addLabel}
            </button>
          ) : (
            <div
              key={`ghost-${gi}`}
              className={[
                "flex min-h-[72px] items-center justify-center rounded-2xl border border-dashed",
                variant === "strip" ? "min-w-[180px] shrink-0 snap-start" : "w-full",
                "border-border/70 text-faint",
              ].join(" ")}
              aria-hidden="true"
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[11px] font-bold">
                {apps.length + gi + 1}
              </span>
            </div>
          ),
        )
      ) : (
        <div
          className={[
            "flex min-h-[72px] items-center justify-center gap-2 rounded-2xl border border-dashed text-sm font-medium",
            variant === "strip" ? "min-w-[180px] shrink-0 snap-start" : "w-full",
            "cursor-not-allowed border-border text-faint",
          ].join(" ")}
        >
          <Icon name="lock" size={14} />
          {t("studio.navFull")}
        </div>
      )}
    </div>
  );

  return (
    <nav aria-label={t("studio.navAria")} className="min-w-0">
      {/* Desktop: left column */}
      <div className="hidden lg:block">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xs font-bold uppercase tracking-[0.12em] text-faint">
            {t("studio.navTitle")} · {apps.length}/{limit}
          </h2>
          {completeCount > 0 ? (
            <span className="text-[11px] font-medium text-success">
              {t("studio.navCompleteCount", { n: completeCount })}
            </span>
          ) : null}
        </div>
        {list("column")}
        {blockedMissing.length > 0 ? (
          <p className="mt-2 text-[11px] leading-4 text-muted">{blockedMissing.join(" · ")}</p>
        ) : null}
      </div>

      {/* Mobile / tablet: top strip */}
      <div className="lg:hidden">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-xs font-bold uppercase tracking-[0.12em] text-faint">
            {t("studio.navTitle")} · {apps.length}/{limit}
          </h2>
        </div>
        {list("strip")}
      </div>
    </nav>
  );
}
