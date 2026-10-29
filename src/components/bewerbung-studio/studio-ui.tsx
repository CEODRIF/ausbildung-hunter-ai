"use client";

/**
 * AI Bewerbung Studio — shared UI primitives.
 *
 * Small, dependency-light building blocks used by the panels: step
 * indicator, section card, status badge, info/warning notes, labelled
 * field, busy button. They follow the app's existing Card/Button/Input
 * language (src/components/ui.tsx) and the i18n `studio.*` keys.
 */

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/icon";
import { Button } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import type { StudioAppStatus } from "@/lib/studio/schema";

// ---------------------------------------------------------------------------
// Step indicator
// ---------------------------------------------------------------------------

export type StudioStep =
  | "analysis"
  | "profile"
  | "cv"
  | "letter"
  | "docs"
  | "quality"
  | "email"
  | "send";

export const STUDIO_STEPS: StudioStep[] = [
  "analysis",
  "profile",
  "cv",
  "letter",
  "docs",
  "quality",
  "email",
  "send",
];

const STEP_KEYS: Record<StudioStep, string> = {
  analysis: "studio.stepAnalysis",
  profile: "studio.stepProfile",
  cv: "studio.stepCv",
  letter: "studio.stepLetter",
  docs: "studio.stepDocuments",
  quality: "studio.stepQuality",
  email: "studio.stepEmail",
  send: "studio.stepSend",
};

export function StepIndicator({
  current,
  done,
  onGo,
}: {
  current: StudioStep;
  /** Steps whose core content exists (checkmark affordance). */
  done: Record<StudioStep, boolean>;
  onGo: (step: StudioStep) => void;
}) {
  const { t } = useI18n();
  return (
    <nav aria-label={t("studio.stepsAria")} className="mb-6">
      <ol className="flex gap-1 overflow-x-auto pb-1">
        {STUDIO_STEPS.map((step, i) => {
          const isCurrent = step === current;
          const isDone = done[step];
          return (
            <li key={step} className="shrink-0">
              <button
                type="button"
                onClick={() => onGo(step)}
                aria-current={isCurrent ? "step" : undefined}
                className={[
                  "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                  isCurrent
                    ? "border-primary bg-primary text-primary-foreground"
                    : isDone
                      ? "border-primary/30 bg-primary/10 text-primary"
                      : "border-border bg-surface text-muted hover:text-foreground",
                ].join(" ")}
              >
                <span
                  className={[
                    "flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold",
                    isCurrent
                      ? "bg-primary-foreground/25 text-primary-foreground"
                      : isDone
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted",
                  ].join(" ")}
                >
                  {isDone && !isCurrent ? <Icon name="check" size={10} strokeWidth={3} /> : i + 1}
                </span>
                {t(STEP_KEYS[step])}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Section card
// ---------------------------------------------------------------------------

export function SectionCard({
  title,
  subtitle,
  children,
  actions,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm sm:p-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          {subtitle ? <p className="mt-1 text-sm leading-6 text-muted">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

const STATUS_KEY: Record<StudioAppStatus, string> = {
  draft: "studio.statusDraft",
  ready: "studio.statusReady",
  scheduled: "studio.statusScheduled",
  sending: "studio.statusSending",
  sent: "studio.statusSent",
  failed: "studio.statusFailed",
  cancelled: "studio.statusCancelled",
};

export function StatusBadge({ status }: { status: StudioAppStatus }) {
  const { t } = useI18n();
  const tone: Record<StudioAppStatus, string> = {
    draft: "bg-muted text-muted",
    ready: "bg-primary/10 text-primary",
    scheduled: "bg-warning/10 text-warning",
    sending: "bg-warning/10 text-warning",
    sent: "bg-success/10 text-success",
    failed: "bg-danger/10 text-danger",
    cancelled: "bg-muted text-muted",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${tone[status]}`}
    >
      {t(STATUS_KEY[status])}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Notes (info / warning / danger)
// ---------------------------------------------------------------------------

export function Note({
  kind = "info",
  children,
}: {
  kind?: "info" | "warning" | "danger";
  children: React.ReactNode;
}) {
  const tone = {
    info: "border-border bg-surface-2 text-muted",
    warning: "border-warning/30 bg-warning/10 text-foreground",
    danger: "border-danger/30 bg-danger/10 text-danger",
  }[kind];
  return (
    <div
      role={kind === "danger" ? "alert" : "note"}
      className={`rounded-xl border p-3 text-sm leading-6 ${tone}`}
    >
      {kind === "info" ? (
        <span className="mr-2 inline-flex align-middle text-muted">
          <Icon name="help" size={14} />
        </span>
      ) : (
        <span className="mr-2 inline-flex align-middle">
          <Icon name="alert" size={14} />
        </span>
      )}
      <span>{children}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Labelled field
// ---------------------------------------------------------------------------

export function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Busy button (disabled while an async op runs)
// ---------------------------------------------------------------------------

export function BusyButton({
  busy,
  children,
  ...rest
}: React.ComponentProps<typeof Button> & { busy?: boolean }) {
  return (
    <Button disabled={busy || rest.disabled} {...rest}>
      {busy ? (
        <span className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
          {children}
        </span>
      ) : (
        children
      )}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Print root (portal onto <body>, hidden on screen)
// ---------------------------------------------------------------------------

/**
 * Mounts `children` into a <body> portal that only exists in print media
 * (see .studio-print-root in globals.css). WHICH sheet the print CSS shows
 * is decided by the body class (usePrintClass): "cv" reuses the existing
 * .cv-sheet sizing, "letter" renders the DIN 5008 .studio-letter-sheet.
 */
export function StudioPrintRoot({ children }: { children: React.ReactNode }) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="studio-print-root" aria-hidden="true">
      {children}
    </div>,
    document.body,
  );
}

/**
 * Adds the matching body class for printing while `enabled` (i.e. while the
 * panel is the ACTIVE step — only one print root may claim the page) and
 * removes it after print.
 */
export function usePrintClass(kind: "cv" | "letter", enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const cls = `studio-print-${kind}`;
    document.body.classList.add(cls);
    const clear = () => document.body.classList.remove(cls);
    window.addEventListener("afterprint", clear);
    return () => {
      clear();
      window.removeEventListener("afterprint", clear);
    };
  }, [kind, enabled]);
}
