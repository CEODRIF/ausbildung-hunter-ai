"use client";

/**
 * Community Phase 3 — the ONE shared presence representation.
 *
 * Every surface (member list, friends, requests, profile card, DM inbox,
 * DM header) renders presence through this component, fed by the SAME
 * server-computed PresenceState — no component re-derives or re-stylizes.
 *
 * Accessibility: state is never color-only (each state has its own shape)
 * and the wrapper carries a localized aria-label; a `label` renders the
 * state as text next to the dot where the surface allows it.
 */

import { useI18n } from "@/lib/i18n";
import { lastSeenBucket, type PresenceState } from "@/lib/community/presence";

export interface PresenceIndicatorProps {
  state: PresenceState;
  size?: "sm" | "md";
  /** Render the localized state word next to the dot. */
  label?: boolean;
  /** Privacy-mapped last seen (null → no line). Offline never shows one. */
  lastSeenAt?: string | null;
  className?: string;
}

const STATE_LABEL_KEY: Record<PresenceState, string> = {
  online: "community.presence.online",
  away: "community.presence.away",
  dnd: "community.presence.dnd",
  offline: "community.presence.offline",
};

/**
 * The class string for an avatar-OVERLAY dot — the same shapes as the
 * labeled indicator (one representation, two placements). At dot size the
 * DND bar is dropped (too small to read); the filled/hollow shape + the
 * aria-label on the wrapping surface still carry the state (never
 * color-only at the surface level).
 */
export function presenceDotClass(
  state: PresenceState,
  sizeCls: string = "h-2.5 w-2.5",
): string {
  switch (state) {
    case "online":
      return `${sizeCls} rounded-full bg-success`;
    case "away":
      return `${sizeCls} rounded-full border-2 border-warning bg-surface`;
    case "dnd":
      return `relative ${sizeCls} rounded-full bg-danger`;
    default:
      return `${sizeCls} rounded-full border-2 border-faint bg-transparent`;
  }
}

function stateShape(state: PresenceState, sizeCls: string): React.ReactNode {
  if (state === "dnd") {
    // Red circle with a horizontal bar: "present, do not disturb".
    return (
      <span className={presenceDotClass(state, sizeCls)}>
        <span className="absolute left-1/2 top-1/2 h-[2px] w-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-surface" />
      </span>
    );
  }
  return <span className={presenceDotClass(state, sizeCls)} />;
}

export function PresenceIndicator({
  state,
  size = "sm",
  label = false,
  lastSeenAt = null,
  className = "",
}: PresenceIndicatorProps) {
  const { t } = useI18n();
  const sizeCls = size === "sm" ? "h-2 w-2" : "h-2.5 w-2.5";
  const stateText = t(STATE_LABEL_KEY[state]);

  let lastSeenLine: string | null = null;
  if (state !== "offline" || (state === "offline" && lastSeenAt)) {
    const bucket = lastSeenBucket(lastSeenAt);
    if (bucket) {
      lastSeenLine =
        bucket === "recent"
          ? t("community.lastSeen.recent")
          : bucket === "today"
            ? t("community.lastSeen.today")
            : t("community.lastSeen.earlier");
    }
  }

  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1.5 ${className}`}
      aria-label={lastSeenLine ? `${stateText} — ${lastSeenLine}` : stateText}
    >
      <span aria-hidden="true" className="shrink-0">
        {stateShape(state, sizeCls)}
      </span>
      {label && <span className="truncate text-xs text-muted">{stateText}</span>}
      {lastSeenLine && !label && (
        <span className="truncate text-[11px] text-faint">{lastSeenLine}</span>
      )}
    </span>
  );
}

/** The localized "last seen …" line (or null = never shown). */
export function formatLastSeen(
  lastSeenAt: string | null,
  t: (key: string) => string,
): string | null {
  const bucket = lastSeenBucket(lastSeenAt);
  if (!bucket) return null;
  if (bucket === "recent") return t("community.lastSeen.recent");
  if (bucket === "today") return t("community.lastSeen.today");
  return t("community.lastSeen.earlier");
}
