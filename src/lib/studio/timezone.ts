/**
 * AI Bewerbung Studio — scheduling timezone utilities (pure, isomorphic).
 *
 * The user picks a local date/time + IANA timezone. The database stores UTC
 * (`timestamptz`). The conversion must be deterministic and testable:
 * `zonedTimeToUtc` implements the standard "round-trip through the zone's
 * wall clock" algorithm and returns null for impossible instants (e.g. 02:30
 * in a DST-gap hour) — the caller rejects those with a clear error instead
 * of guessing a shifted time.
 */

export function isSupportedTimeZone(tz: string): boolean {
  try {
    if (typeof Intl !== "undefined" && "supportedValuesOf" in Intl) {
      return (Intl.supportedValuesOf("timeZone") as string[]).includes(tz);
    }
  } catch {
    /* fall through */
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Format an instant in the given zone as {date, time, offsetLabel, weekday}. */
export function formatInZone(
  utcMs: number,
  tz: string,
  locale = "de-DE",
): { date: string; time: string; offsetLabel: string; weekday: string } | null {
  try {
    const dtf = new Intl.DateTimeFormat(locale, {
      timeZone: tz,
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZoneName: "shortOffset",
    });
    const parts = dtf.formatToParts(new Date(utcMs));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return {
      weekday: get("weekday"),
      date: `${get("day")}.${get("month")}.${get("year")}`,
      time: `${get("hour")}:${get("minute")}`,
      offsetLabel: get("timeZoneName"),
    };
  } catch {
    return null;
  }
}

/**
 * Convert a wall-clock date+time in `tz` to UTC ms.
 * Returns null when the instant does not exist in that zone (DST gap) or
 * the timezone is invalid — callers must reject, never default.
 */
export function zonedTimeToUtc(
  year: number,
  month: number, // 1-12
  day: number, // 1-31
  hour: number, // 0-23
  minute: number, // 0-59
  tz: string,
): number | null {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (!isSupportedTimeZone(tz)) return null;
  // Impossible calendar dates (e.g. 31 Feb) would otherwise ROLL OVER via
  // Date.UTC and be silently rescheduled to another day — reject them.
  if (new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day) return null;

  const toLocaleParts = (d: Date, zone: string) =>
    d.toLocaleString("en-US", { timeZone: zone });

  // First guess: treat the requested wall clock as UTC.
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (Number.isNaN(guess.getTime())) return null;
  const wallClockString = toLocaleParts(guess, "UTC");

  const zoneOffsetAt = (instant: Date): number =>
    new Date(toLocaleParts(instant, tz)).getTime() -
    new Date(toLocaleParts(instant, "UTC")).getTime();

  // One (then two, to handle offsets that differ across the guess boundary)
  // Newton steps, verified by a strict round trip: the resulting instant,
  // rendered back in the zone, must equal the requested wall clock. A
  // DST-gap time (e.g. 02:30 on a spring-forward day) never round-trips
  // and is rejected with null — the caller shows a clear error instead of
  // silently shifting the send time.
  let utc = new Date(guess.getTime() - zoneOffsetAt(guess));
  for (let i = 0; i < 2; i++) {
    const candidate = new Date(guess.getTime() - zoneOffsetAt(utc));
    if (candidate.getTime() === utc.getTime()) break;
    utc = candidate;
  }
  if (toLocaleParts(utc, tz) !== wallClockString) return null;
  return utc.getTime();
}
