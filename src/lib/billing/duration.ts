/**
 * Subscription period math — the ONLY place where a (start, duration) pair
 * turns into an end timestamp. The SQL mirror lives in
 * migration 20261120000000 (`subscription_period_end`); tests assert the two
 * agree.
 *
 * Semantics (locked design decision):
 *   - `fixed_hours` / `fixed_days` : plain addition to the start instant
 *     (trial = exactly 72 h, premium_10d = exactly 10 days).
 *   - `calendar_month`             : N CALENDAR months, NOT N days.
 *       * the end day equals the start day, clamped down to the last day of
 *         the target month (Jan 31 + 1 month -> Feb 28/29, Mar 31 -> Apr 30);
 *       * the start time of day is preserved (Mar 15 08:30Z -> Apr 15 08:30Z);
 *       * the end timestamp is EXCLUSIVE (access ends AT the timestamp,
 *         i.e. `end > now` is the active check — same as the legacy
 *         `subscription_period_valid` convention).
 *   - `none`                       : no bounded period (legacy rows) -> null.
 */

import type { PlanDuration } from "./commercial-plans";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The start date advanced by `n` calendar months, with the day clamped
 *  DOWN to the target month's last day when it does not exist (same rule as
 *  `date + make_interval(months => n)` in the SQL mirror). */
function addCalendarMonthsClamped(ms: number, months: number): number {
  const d = new Date(ms);
  const startDay = d.getUTCDate();
  const targetFirst = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1),
  );
  const targetLastDay = Date.UTC(
    targetFirst.getUTCFullYear(),
    targetFirst.getUTCMonth() + 1,
    0,
  );
  const clampedDay = Math.min(startDay, new Date(targetLastDay).getUTCDate());
  return Date.UTC(targetFirst.getUTCFullYear(), targetFirst.getUTCMonth(), clampedDay);
}

/**
 * Compute the (exclusive) end of a subscription period.
 * Returns null for unbounded (`none`) durations.
 */
export function computePeriodEnd(startMs: number, duration: PlanDuration): number | null {
  switch (duration.kind) {
    case "fixed_hours":
      return startMs + duration.hours * HOUR_MS;
    case "fixed_days":
      return startMs + duration.days * DAY_MS;
    case "calendar_month": {
      const monthAnchor = addCalendarMonthsClamped(startMs, duration.months);
      // Preserve the time of day from the start instant.
      const start = new Date(startMs);
      const dayMs =
        startMs -
        Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
      return monthAnchor + dayMs;
    }
    case "none":
      return null;
  }
}

/** Wall-clock length of a computed period in whole days (for display/tests).
 *  Returns null when the period is unbounded. */
export function periodDays(startMs: number, duration: PlanDuration): number | null {
  const end = computePeriodEnd(startMs, duration);
  if (end === null) return null;
  return (end - startMs) / DAY_MS;
}
