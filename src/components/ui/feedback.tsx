import type { ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, Inbox, RefreshCw } from "lucide-react";

/**
 * Status + state primitives. Pure (no hooks) — pass translated strings in.
 * Status tones are deliberately subtle (soft background + tinted text, no
 * neon).
 */

export type StatusTone =
  | "active"
  | "running"
  | "success"
  | "skipped"
  | "restricted"
  | "unverified"
  | "blocked"
  | "neutral";

const PILL_TONES: Record<StatusTone, string> = {
  active: "bg-success-soft text-success",
  running: "bg-accent-soft text-accent",
  success: "bg-success-soft text-success",
  skipped: "bg-surface-2 text-muted",
  restricted: "bg-surface-2 text-muted",
  unverified: "bg-warning-soft text-warning",
  blocked: "bg-danger-soft text-danger",
  neutral: "bg-surface-2 text-muted",
};

const PILL_DOTS: Record<StatusTone, string> = {
  active: "bg-success",
  running: "bg-accent",
  success: "bg-success",
  skipped: "bg-faint",
  restricted: "bg-faint",
  unverified: "bg-warning",
  blocked: "bg-danger",
  neutral: "bg-faint",
};

/** Small pill: status dot + label. `animate` pulses the dot while running. */
export function StatusPill({
  tone,
  label,
  className = "",
}: {
  tone: StatusTone;
  label: string;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap ${PILL_TONES[tone]} ${className}`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${PILL_DOTS[tone]} ${
          tone === "running" ? "animate-pulse" : ""
        }`}
      />
      {label}
    </span>
  );
}

/** Skeleton block (shimmer) — the loading contract for every page. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`shimmer rounded-xl ${className}`} />;
}

/** Empty state: soft illustration + title + body + CTA. */
export function EmptyState({
  title,
  body,
  ctaLabel,
  ctaHref,
  ctaIcon,
  illustration,
  className = "",
}: {
  title: string;
  body?: string;
  ctaLabel?: string;
  ctaHref?: string;
  ctaIcon?: ReactNode;
  illustration?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col items-center rounded-3xl border border-dashed border-line-strong bg-surface/60 px-6 py-14 text-center ${className}`}
    >
      <div className="relative mb-6 flex h-20 w-20 items-center justify-center rounded-[28px] bg-accent-soft text-accent">
        {illustration ?? <Inbox size={34} strokeWidth={1.6} />}
      </div>
      <h3 className="text-lg font-bold text-ink">{title}</h3>
      {body && <p className="mt-2 max-w-sm text-sm leading-6 text-muted">{body}</p>}
      {ctaLabel && ctaHref && (
        <Link
          href={ctaHref}
          className="btn-neon mt-6 inline-flex h-12 items-center gap-2 rounded-2xl px-6 text-sm font-bold text-white"
        >
          {ctaLabel}
          <ArrowRight size={16} className="rtl:rotate-180" />
        </Link>
      )}
      {ctaIcon}
    </div>
  );
}

/** Error state: friendly, no stack traces. Retry + secondary action. */
export function ErrorState({
  title,
  reason,
  onRetry,
  retryLabel,
  secondaryLabel,
  secondaryHref,
  className = "",
}: {
  title: string;
  reason?: string;
  onRetry?: () => void;
  retryLabel?: string;
  secondaryLabel?: string;
  secondaryHref?: string;
  className?: string;
}) {
  return (
    <div role="alert" className={`rounded-3xl border border-danger/25 bg-danger-soft/60 p-6 sm:p-8 ${className}`}>
      <div className="flex items-start gap-4">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-danger/15 text-danger">
          <AlertTriangle size={20} strokeWidth={1.8} />
        </span>
        <div className="min-w-0">
          <h3 className="text-base font-bold text-ink">{title}</h3>
          {reason && <p className="mt-1.5 text-sm leading-6 text-muted">{reason}</p>}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {onRetry && retryLabel && (
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex h-11 items-center gap-2 rounded-xl border border-line-strong bg-surface px-4 text-sm font-semibold text-ink transition-colors hover:bg-surface-2"
              >
                <RefreshCw size={15} />
                {retryLabel}
              </button>
            )}
            {secondaryLabel && secondaryHref && (
              <Link
                href={secondaryHref}
                className="inline-flex h-11 items-center gap-2 rounded-xl px-3 text-sm font-semibold text-accent hover:underline"
              >
                {secondaryLabel}
                <ArrowRight size={14} className="rtl:rotate-180" />
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
