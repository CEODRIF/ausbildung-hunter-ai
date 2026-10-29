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

      {/* remove — small × at the top-right (per approved reference),
          two-step confirmation naming the EXACT application, no
          window.confirm. It is a sibling of the open-button (not nested),
          so clicking it can never trigger card navigation. */}
      {confirming ? (
        <div className="absolute right-2 top-2 flex items-center gap-1 rounded-xl border border-danger/40 bg-surface px-2 py-1 shadow-sm">
          <span className="max-w-[130px] truncate text-[11px] font-medium text-danger" title={company}>
            {t("studio.navDeleteQ", { company })}
          </span>
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
          aria-label={`${t("studio.navDelete")}: ${company}`}
          title={`${t("studio.navDelete")}: ${company}`}
          className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-lg border border-danger/40 text-danger/70 transition hover:bg-danger/10 hover:text-danger focus:outline-none focus-visible:ring-2 focus-visible:ring-danger/50"
        >
          <Icon name="x" size={13} strokeWidth={2.5} />
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
  const { apps, limit, canAdd } = batch;

  const isFull = apps.length >= limit;
  // Add-button state (server-computed, never client-guessed):
  //  - full → disabled + "Maximum 10 applications reached"
  //  - otherwise → enabled (creation is CAP-gated, NOT completion-gated —
  //    the sequential unlock rule is communicated on the locked cards and
  //    ghost slots, per the approved reference design)
  const addDisabled = isFull || !canAdd || addBusy;

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
        {/* placeholder slots: five initial slots, expandable to the limit.
           They are REAL BUTTONS (clicking one starts the same add flow as
           the "+ Add application" button — never a silent no-op). Placeholders
           are never counted in the n/limit label above (apps.length is the
           number of persisted applications only). The lock hint per the
           approved reference: the next slot names the company to finish
           first; deeper slots name the sequential rule. */}
        {apps.length < limit
          ? Array.from(
              { length: Math.min(limit, Math.max(apps.length, STUDIO_BATCH_INITIAL_SLOTS)) - apps.length },
              (_, gi) => {
                const isFirst = gi === 0;
                const prev = apps.length > 0 ? apps[apps.length - 1] : null;
                const prevIncomplete = prev ? !prev.completion.complete : false;
                const addable = isFirst && !prevIncomplete;
                const label = isFirst && prevIncomplete && prev
                  ? t("studio.navBlocked", { company: companyOf(prev) })
                  : addable
                    ? t("studio.navAdd")
                    : t("studio.navGhostLocked");
                return (
                  <button
                    key={`slot-${gi + 1}`}
                    type="button"
                    onClick={onNew}
                    aria-label={`${t("studio.navAddApplication")}: ${label}`}
                    title={label}
                    className={[
                      "flex min-h-[72px] items-center gap-2 rounded-2xl border border-dashed transition",
                      variant === "strip" ? "min-w-[180px] shrink-0 snap-start" : "w-full",
                      "border-border/70 bg-surface/50 px-3 text-left hover:border-primary/50 hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
                    ].join(" ")}
                  >
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-bold text-faint">
                      {apps.length + gi + 1}
                    </span>
                    <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] leading-4 text-faint">
                      {addable ? (
                        <Icon name="plus" size={11} strokeWidth={2.5} className="shrink-0" />
                      ) : (
                        <Icon name="lock" size={11} className="shrink-0" />
                      )}
                      <span className="min-w-0 truncate">{label}</span>
                    </span>
                  </button>
                );
              },
            )
          : null}
     </div>
   );

  const addRow = () => (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h2 className="min-w-0 flex-1 truncate text-xs font-bold uppercase tracking-[0.12em] text-faint">
        {t("studio.navTitle")} · {apps.length}/{limit}
      </h2>
      <button
        type="button"
        onClick={onNew}
        disabled={addDisabled}
        className={[
          "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
          addDisabled
            ? "cursor-not-allowed border border-border bg-surface text-faint"
            : "bg-primary text-primary-foreground hover:opacity-90",
        ].join(" ")}
      >
        <Icon name="plus" size={13} strokeWidth={3} />
        {t("studio.navAddApplication")}
      </button>
    </div>
  );

  // State line under the Add button: only the cap message. The sequential
  // rule is communicated on the locked cards + ghost slots (per reference).
  const stateHint = isFull ? t("studio.navMaxReached") : null;

  return (
    <nav aria-label={t("studio.navAria")} className="min-w-0">
      {/* Desktop: left column */}
      <div className="hidden lg:block">
        {addRow()}
        {stateHint ? <p className="mb-2 text-[11px] leading-4 text-muted">{stateHint}</p> : null}
        {list("column")}
      </div>

      {/* Mobile / tablet: top strip */}
      <div className="lg:hidden">
        {addRow()}
        {stateHint ? <p className="mb-2 text-[11px] leading-4 text-muted">{stateHint}</p> : null}
        {list("strip")}
      </div>
    </nav>
  );
}
