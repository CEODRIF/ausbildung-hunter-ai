import type { FeatureEntitlement } from "@/lib/billing/entitlement-service";

/**
 * ONE shared quota indicator for every quota-consuming surface (P0 quota
 * audit, 2026-10-25): dashboard, billing usage table, /settings/usage,
 * automation, deckblatt, AI chat, scanner, opportunity search, composers,
 * profile.
 *
 * Invariants (all enforced HERE, so the 13 surfaces cannot drift apart):
 *  - GREEN (success token) is the healthy state — used / limit, remaining
 *    and the reset label are always rendered together, server-derived.
 *  - `limit === null`  → "Unlimited" — ONLY because the server said so
 *                        (the entitlement resolver returns null only for
 *                        unmetered features; the UI never decides).
 *  - `limit === 0`     → "Not available" + optional upgrade hint. The
 *                        feature is disabled on this plan (or the plan
 *                        expired) — never rendered as "0 of 0 left".
 *  - `used/remaining === null` → honest unknown state. NULLS ONLY APPEAR
 *                        when a quota read FAILED (lookup_error / meter
 *                        unreadable) — never a fabricated 0, never a
 *                        stale number, never an invented limit.
 *  - `remaining === 0` → limit-reached state (danger tone) with the reset
 *                        label — the only non-green state for a metered,
 *                        available feature.
 *  - `loading`         → neutral placeholder, no numbers at all.
 *
 * The component is PRESENTATIONAL: no hooks, no i18n of its own (all
 * strings arrive pre-resolved via `labels`/`resetLabel`), so it is safe
 * in server components AND client components and renders identically in
 * both. Counts are language-neutral (number + unit + suffix word), which
 * holds in de/en/fr/ar.
 */
export interface QuotaData {
  used: number | null;
  limit: number | null;
  remaining: number | null;
  /**
   * EXPLICIT server confirmation that this feature is unmetered. "Unlimited"
   * is rendered ONLY when this is true — a null `limit` without this flag
   * means the limit is UNKNOWN (e.g. a partial client payload), which
   * renders the neutral unknown state instead.
   */
  unlimited?: boolean;
}

export interface QuotaLabels {
  /** unknown (read failed) */
  unknown: string;
  /** limit === null (server-confirmed unmetered) */
  unlimited: string;
  /** limit === 0 (disabled on this plan / expired) */
  unavailable: string;
  /** suffix after the remaining count, e.g. "übrig" / "left" */
  remaining: string;
  /** remaining === 0 */
  limitReached: string;
}

export interface QuotaIndicatorProps {
  data: QuotaData;
  /** Unit noun shown with the counts ("E-Mails", "MB", "Designs", …). */
  unit: string;
  /** Human reset label ("Resets daily (00:00 UTC)", …) or null/undefined
   *  when there is no reset (item quotas) or it is unknown. */
  resetLabel?: string | null;
  labels: QuotaLabels;
  /** Optional hint rendered next to "Not available" (e.g. "Upgrade"). */
  upgradeHint?: string | null;
  /** True while a quota fetch is in flight — renders a neutral
   *  placeholder with NO numbers (no invented values). */
  loading?: boolean;
  /** "pill" = compact inline badge (default); "bar" = badge + progress
   *  bar + remaining line (cards / table rows). */
  variant?: "pill" | "bar";
  className?: string;
}

/**
 * Resolve the five state labels for the active language. Every surface
 * builds its labels with this ONE helper so the wording (and its 4-language
 * parity) cannot drift between pages.
 */
export function makeQuotaLabels(
  t: (path: string, vars?: Record<string, string | number>) => string,
): QuotaLabels {
  return {
    unknown: t("quota.unknown"),
    unlimited: t("quota.unlimited"),
    unavailable: t("quota.unavailable"),
    remaining: t("quota.remaining"),
    limitReached: t("quota.limitReached"),
  };
}

/** Map a server `FeatureEntitlement` to display data. `lookup_error`
 *  means the subscription or meter read FAILED: the numbers are unknown →
 *  nulls (the component renders the honest unknown state instead of a
 *  fabricated 0-of-X). `unlimited` is set only when the server resolved a
 *  real unmetered entitlement (limit null, reason ok/ok_legacy_unmetered). */
export function quotaDataFromEntitlement(e: FeatureEntitlement): QuotaData {
  if (e.reason === "lookup_error") {
    return { used: null, limit: null, remaining: null };
  }
  return {
    used: e.used,
    limit: e.limit,
    remaining: e.remaining,
    unlimited: e.limit === null,
  };
}

type Tone = "success" | "neutral" | "danger";

const TONE_CLASS: Record<Tone, string> = {
  success: "border-success/40 bg-success-soft text-success",
  neutral: "border-line bg-surface-2 text-muted",
  danger: "border-danger/40 bg-danger/10 text-danger",
};

function resolveState(props: QuotaIndicatorProps): {
  tone: Tone;
  text: string;
  percent: number | null;
} {
  const { data, labels, loading } = props;
  if (loading) return { tone: "neutral", text: "…", percent: null };
  const { used, limit, remaining } = data;
  // "Unlimited" ONLY on explicit server confirmation — never inferred
  // from a missing value.
  if (data.unlimited)
    return { tone: "success", text: labels.unlimited, percent: null };
  if (limit === null)
    return { tone: "neutral", text: labels.unknown, percent: null };
  if (limit === 0)
    return { tone: "neutral", text: labels.unavailable, percent: null };
  if (used === null || remaining === null)
    return { tone: "neutral", text: labels.unknown, percent: null };
  if (remaining <= 0)
    return {
      tone: "danger",
      // The exhausted state MUST name when capacity comes back — a dead-end
      // "limit reached" without the reset period is a fabricated dead end.
      text: props.resetLabel
        ? `${labels.limitReached} · ${props.resetLabel}`
        : labels.limitReached,
      percent: 100,
    };
  const text =
    `${used}/${limit} ${props.unit} · ${remaining} ${labels.remaining}` +
    (props.resetLabel ? ` · ${props.resetLabel}` : "");
  const percent =
    limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : null;
  return { tone: "success", text, percent };
}

export function QuotaIndicator(props: QuotaIndicatorProps) {
  const { tone, text, percent } = resolveState(props);
  const cls = props.variant ?? "pill";

  if (cls === "pill") {
    return (
      <span
        role="status"
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${TONE_CLASS[tone]} ${props.className ?? ""}`}
      >
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-current"
        />
        <span className="whitespace-nowrap">{text}</span>
        {tone === "neutral" && props.data.limit === 0 && props.upgradeHint ? (
          <span className="whitespace-nowrap text-[11px] font-bold text-accent">
            {props.upgradeHint}
          </span>
        ) : null}
      </span>
    );
  }

  // bar variant
  return (
    <div className={props.className}>
      <div className="flex items-center justify-between gap-3">
        <span
          role="status"
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${TONE_CLASS[tone]}`}
        >
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-current"
          />
          <span className="whitespace-nowrap">{text}</span>
        </span>
        {tone === "neutral" && props.data.limit === 0 && props.upgradeHint ? (
          <span className="text-[11px] font-bold text-accent">
            {props.upgradeHint}
          </span>
        ) : null}
      </div>
      {percent !== null && (
        <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-surface-2">
          <div
            className={`h-full rounded-full ${
              tone === "danger" ? "bg-danger" : "bg-success"
            }`}
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
    </div>
  );
}
