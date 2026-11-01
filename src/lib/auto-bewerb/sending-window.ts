/**
 * AUTO BEWERB — the exact daily SENDING WINDOW (Germany).
 *
 * Background/automatic batch STARTS are only permitted while the window is
 * open. This is the single source of truth for the window definition on the
 * Node side; the SAME window is mirrored server-side in Postgres (see the
 * migration `auto_bewerb_sending_window.sql` → `auto_bewerb_sending_window_open()`),
 * which is the authoritative gate for the cron path. The two MUST stay in sync.
 *
 *  - Window: 07:30 → 10:30, EVERY day. Start is inclusive (07:30:00).
 *    The end is inclusive at MINUTE granularity: the 10:30 minute (10:30:00–
 *    10:30:59) is still inside, so a campaign scheduled for exactly 10:30
 *    starts on the 10:30 tick; NOTHING starts at 10:31 or later.
 *  - Timezone: IANA `Europe/Berlin` — NEVER a hardcoded UTC offset.
 *  - Daylight saving is respected automatically: the wall-clock window is
 *    evaluated in the IANA zone via `Intl`, so 07:30–10:30 Berlin always maps
 *    to the correct UTC instant across the CET↔CEST transitions (the 3-hour
 *    duration is preserved in local time, which is what the spec asks for).
 *
 * SAFE BATCH-BOUNDARY POLICY (enforced by the callers, defined here):
 *  - The window gates BATCH START (scheduled/waiting → sending) only.
 *  - A batch that was ALREADY started (status 'sending') before the window
 *    closed is allowed to DRAIN to completion — its queued attempts keep being
 *    dispatched (the attempt-claim path is intentionally NOT window-gated).
 *    We never interrupt an in-flight batch or an individual provider send.
 *  - Batches that are due but NOT yet started simply stay queued in Supabase
 *    and start at the next eligible window.
 */
import { utcToLocalParts, wallClockToUtc } from "@/lib/schedule-time";

export const AUTO_BEWERB_SENDING_WINDOW = {
  /** IANA timezone — never a fixed UTC offset. */
  timeZone: "Europe/Berlin",
  startHour: 7,
  startMinute: 30,
  endHour: 10,
  endMinute: 30,
} as const;

/** Minute-of-day for the window start (07:30 → 450). */
const WINDOW_START_MIN = AUTO_BEWERB_SENDING_WINDOW.startHour * 60 + AUTO_BEWERB_SENDING_WINDOW.startMinute;
/** Minute-of-day for the window end (10:30 → 630), INCLUSIVE at minute
 *  granularity — the 10:30 minute may still start a batch (a campaign
 *  scheduled for exactly 10:30 starts on the 10:30 tick); 10:31 is closed. */
const WINDOW_END_MIN = AUTO_BEWERB_SENDING_WINDOW.endHour * 60 + AUTO_BEWERB_SENDING_WINDOW.endMinute;

/** The single source of truth for the window's minute-of-day range.
 *  Start (07:30) inclusive, end (10:30) INCLUSIVE at minute granularity — the
 *  10:30 minute may still start a batch (a campaign scheduled for exactly
 *  10:30 starts on the 10:30 tick); 10:31 and later are closed. */
function minuteOpen(m: number): boolean {
  return m >= WINDOW_START_MIN && m <= WINDOW_END_MIN;
}

/** Pure, timezone-independent boundary check on a Berlin wall-clock
 *  (hour, minute). This is the exact rule the scheduling form and the
 *  boundary tests assert: 07:29 ✗, 07:30 ✓, 08:00 ✓, 09:00 ✓, 10:00 ✓,
 *  10:30 ✓, 10:31 ✗, 11:00 ✗, 20:00 ✗. */
export function isWithinSendingWindow(hour: number, minute: number): boolean {
  return minuteOpen(hour * 60 + minute);
}

export interface SendingWindowState {
  /** True iff the instant falls in 07:30:00–10:30:59 local Berlin time. */
  open: boolean;
  /** The local wall-clock hour (0–23) at the instant. */
  hour: number;
  /** The local wall-clock minute (0–59) at the instant. */
  minute: number;
  /** The IANA zone the decision was made in. */
  timeZone: string;
  /** Human label, e.g. "07:30–10:30 Europe/Berlin". */
  label: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function windowLabel(timeZone: string = AUTO_BEWERB_SENDING_WINDOW.timeZone): string {
  const w = AUTO_BEWERB_SENDING_WINDOW;
  return `${pad2(w.startHour)}:${pad2(w.startMinute)}–${pad2(w.endHour)}:${pad2(w.endMinute)} ${timeZone}`;
}

/** The local wall-clock (hour, minute) of an instant in an IANA zone. */
function localHourMinute(instantMs: number, timeZone: string): { hour: number; minute: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(new Date(instantMs));
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    const minute = Number(parts.find((p) => p.type === "minute")?.value);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return { hour, minute };
  } catch {
    return null;
  }
}

/**
 * The window state at an instant (DST-aware via IANA `Intl`).
 * Pure and deterministic — the same instant always yields the same answer,
 * which is what makes the 07:29/07:30/10:29/10:30/10:31 + transition tests
 * meaningful.
 */
export function sendingWindowState(instantMs: number, timeZone: string = AUTO_BEWERB_SENDING_WINDOW.timeZone): SendingWindowState {
  const hm = localHourMinute(instantMs, timeZone);
  if (!hm) {
    // Unknown zone: fail CLOSED (window not open) — never start outside the
    // known window because of a timezone resolution error.
    return { open: false, hour: 0, minute: 0, timeZone, label: windowLabel(timeZone) };
  }
  const m = hm.hour * 60 + hm.minute;
  return {
    open: minuteOpen(m),
    hour: hm.hour,
    minute: hm.minute,
    timeZone,
    label: windowLabel(timeZone),
  };
}

/** Convenience: is the sending window open at `nowMs` (default: wall clock now)? */
export function isSendingWindowOpen(nowMs: number = Date.now(), timeZone: string = AUTO_BEWERB_SENDING_WINDOW.timeZone): boolean {
  return sendingWindowState(nowMs, timeZone).open;
}

/**
 * Server-side validation of a requested campaign start instant: true iff the
 * instant's Berlin wall-clock lies inside the window (07:30–10:30 inclusive
 * at minute granularity). The check is on the INSTANT (not on the client's
 * stated timezone), so any timezone a caller posts is evaluated honestly in
 * Europe/Berlin. Fails CLOSED on an unresolvable instant/zone.
 */
export function isCampaignTimeInWindow(utcMs: number): boolean {
  if (!Number.isFinite(utcMs)) return false;
  const parts = utcToLocalParts(new Date(utcMs).toISOString(), AUTO_BEWERB_SENDING_WINDOW.timeZone);
  if (!parts) return false;
  return minuteOpen(parts.hour * 60 + parts.minute);
}

/**
 * The next moment the window OPENS at/after `instantMs`, as a UTC ms value.
 * Returns null when the window is currently open (nothing to wait for) or when
 * it cannot be computed (defensive; the UI falls back to a generic "next
 * window" message). 07:30 Berlin is far from the 02:00–03:00 DST transition,
 * so it is always a unique, existing local time — wallClockToUtc succeeds.
 */
export function nextWindowStartMs(instantMs: number, timeZone: string = AUTO_BEWERB_SENDING_WINDOW.timeZone): number | null {
  if (sendingWindowState(instantMs, timeZone).open) return null;
  const today = utcToLocalParts(new Date(instantMs).toISOString(), timeZone);
  if (!today) return null;
  for (let offsetDays = 0; offsetDays <= 1; offsetDays++) {
    // Date.UTC rolls month overflow correctly (e.g. day 31 + 1 → next month).
    const d = new Date(Date.UTC(today.year, today.month - 1, today.day + offsetDays));
    const candidate = wallClockToUtc(
      {
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        day: d.getUTCDate(),
        hour: AUTO_BEWERB_SENDING_WINDOW.startHour,
        minute: AUTO_BEWERB_SENDING_WINDOW.startMinute,
      },
      timeZone,
    );
    if (candidate.ok && candidate.utcMs > instantMs) return candidate.utcMs;
  }
  return null;
}
