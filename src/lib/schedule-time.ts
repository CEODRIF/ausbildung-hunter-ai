/**
 * IANA wall-clock ↔ UTC conversion for scheduled campaign sends.
 *
 * PURE and dependency-free: the SAME function runs in the browser (live
 * preview) and server-side (authoritative validation). The browser clock and
 * the browser preview are NEVER authoritative — the server action re-runs
 * wallClockToUtc() and only the resulting UTC instant is persisted.
 *
 * Daylight-saving correctness (explicit, per the scheduling spec):
 *  - a local time that does not exist (spring-forward gap)  → "nonexistent"
 *  - a local time that occurs twice (fall-back fold)        → "ambiguous",
 *    with BOTH candidate UTC instants; a result is produced only when the
 *    user explicitly resolves it ("start" = first occurrence, "end" = second)
 *  - otherwise a unique UTC instant.
 *
 * Detection algorithm: the offset of the IANA zone is probed at three
 * instants (t0, t0−24h, t0+24h, where t0 = the wall-clock read as UTC).
 * Every distinct probed offset o yields the candidate instant t0−o; a
 * candidate is a real occurrence iff the zone's offset AT that instant is
 * exactly o (fixed point). The number of valid candidates is 0 / 1 / 2+ →
 * nonexistent / unique / ambiguous. No DST window in the modern tzdb
 * changes offset twice within 24h, so the three probes always see every
 * offset that could map onto this wall-clock time.
 */

export type WallClockTime = {
  year: number;
  month: number; // 1–12
  day: number; // 1–31
  hour: number; // 0–23 (24-hour clock)
  minute: number; // 0–59
};

/** Explicit resolution of an ambiguous (fall-back) local time. */
export type DstResolution = "start" | "end";

export type ScheduleTimeResult =
  | {
      ok: true;
      utcMs: number;
      utcIso: string;
      /** True when the wall-clock time occurred twice and the user chose. */
      resolvedAmbiguity: DstResolution | null;
    }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "nonexistent" }
  | {
      ok: false;
      reason: "ambiguous";
      /** First (earlier) occurrence, e.g. still DST in fall-back zones. */
      firstUtcIso: string;
      /** Second (later) occurrence. */
      secondUtcIso: string;
    };

/**
 * The IANA zones the scheduling UI offers. Curated for the product's user
 * base (German applications, MENA + diaspora regions). Unknown ids are
 * rejected server-side — the list is the allow-list.
 */
export const SUPPORTED_TIMEZONES: Array<{ id: string; label: string }> = [
  { id: "Europe/Berlin", label: "Europe/Berlin (Deutschland)" },
  { id: "Europe/Paris", label: "Europe/Paris (France)" },
  { id: "Europe/London", label: "Europe/London (UK)" },
  { id: "Europe/Madrid", label: "Europe/Madrid (España)" },
  { id: "Europe/Rome", label: "Europe/Rome (Italia)" },
  { id: "Europe/Vienna", label: "Europe/Vienna (Österreich)" },
  { id: "Europe/Zurich", label: "Europe/Zurich (Schweiz)" },
  { id: "Europe/Istanbul", label: "Europe/Istanbul (Türkiye)" },
  { id: "Africa/Casablanca", label: "Africa/Casablanca (Maroc)" },
  { id: "Africa/Cairo", label: "Africa/Cairo (مصر)" },
  { id: "Asia/Dubai", label: "Asia/Dubai (الإمارات)" },
  { id: "Asia/Riyadh", label: "Asia/Riyadh (السعودية)" },
  { id: "Asia/Karachi", label: "Asia/Karachi (باكستان)" },
  { id: "Asia/Kolkata", label: "Asia/Kolkata (الهند)" },
  { id: "America/New_York", label: "America/New_York (USA Ost)" },
  { id: "America/Chicago", label: "America/Chicago (USA Mitte)" },
  { id: "America/Los_Angeles", label: "America/Los_Angeles (USA West)" },
  { id: "America/Mexico_City", label: "America/Mexico_City" },
  { id: "America/Sao_Paulo", label: "America/Sao_Paulo (Brasil)" },
  { id: "UTC", label: "UTC" },
];

export function isSupportedTimezone(timeZone: string): boolean {
  return SUPPORTED_TIMEZONES.some((zone) => zone.id === timeZone);
}

export function isValidCalendarDate(
  year: number,
  month: number,
  day: number,
): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day))
    return false;
  if (year < 2000 || year > 2100) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

/**
 * The zone's UTC offset (in minutes) at the given instant, parsed from
 * Intl's `timeZoneName: "longOffset"` ("GMT+01:00", "GMT", "GMT-03:30").
 * Throws on an unknown zone — callers catch and map to "invalid".
 */
export function tzOffsetMinutes(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "longOffset",
  }).formatToParts(new Date(instantMs));
  const label = parts.find((part) => part.type === "timeZoneName")?.value;
  if (!label) throw new Error("Missing offset label");
  if (label === "GMT") return 0;
  const match = /^GMT([+-])(\d{1,2})(?::([0-9]{2}))?$/.exec(label);
  if (!match) throw new Error(`Unparseable offset: ${label}`);
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3] ?? "0"));
}

/**
 * Convert a wall-clock time in an IANA zone to the canonical UTC instant.
 * See the module header for the DST semantics.
 */
export function wallClockToUtc(
  input: WallClockTime,
  timeZone: string,
  resolution: DstResolution | null = null,
): ScheduleTimeResult {
  if (
    !isValidCalendarDate(input.year, input.month, input.day) ||
    !Number.isInteger(input.hour) ||
    input.hour < 0 ||
    input.hour > 23 ||
    !Number.isInteger(input.minute) ||
    input.minute < 0 ||
    input.minute > 59 ||
    !isSupportedTimezone(timeZone)
  )
    return { ok: false, reason: "invalid" };

  // t0: the wall-clock read as if it were UTC (an arbitrary reference).
  const t0 = Date.UTC(
    input.year,
    input.month - 1,
    input.day,
    input.hour,
    input.minute,
  );
  const DAY = 86_400_000;
  let offsets: number[];
  try {
    offsets = [
      tzOffsetMinutes(t0, timeZone),
      tzOffsetMinutes(t0 - DAY, timeZone),
      tzOffsetMinutes(t0 + DAY, timeZone),
    ];
  } catch {
    return { ok: false, reason: "invalid" };
  }

  // Distinct candidate occurrences: for each distinct offset o, the instant
  // t0 − o maps to the wall-clock time IFF the zone's offset at that instant
  // is exactly o (fixed point ⇒ no transition between candidate and wall).
  const seen = new Set<number>();
  const occurrences: number[] = [];
  for (const offset of offsets) {
    if (seen.has(offset)) continue;
    seen.add(offset);
    const candidate = t0 - offset * 60_000;
    let atCandidate: number;
    try {
      atCandidate = tzOffsetMinutes(candidate, timeZone);
    } catch {
      continue;
    }
    if (atCandidate === offset && !occurrences.includes(candidate)) {
      occurrences.push(candidate);
    }
  }

  if (occurrences.length === 0) return { ok: false, reason: "nonexistent" };
  occurrences.sort((a, b) => a - b);

  if (occurrences.length === 1) {
    const utcMs = occurrences[0];
    return {
      ok: true,
      utcMs,
      utcIso: new Date(utcMs).toISOString(),
      resolvedAmbiguity: null,
    };
  }

  // Ambiguous (fall-back fold): the user must choose explicitly.
  if (!resolution) {
    return {
      ok: false,
      reason: "ambiguous",
      firstUtcIso: new Date(occurrences[0]).toISOString(),
      secondUtcIso: new Date(occurrences[1]).toISOString(),
    };
  }
  const utcMs = resolution === "start" ? occurrences[0] : occurrences[1];
  return {
    ok: true,
    utcMs,
    utcIso: new Date(utcMs).toISOString(),
    resolvedAmbiguity: resolution,
  };
}

/**
 * Locale-aware preview of a stored UTC instant in the campaign's IANA zone
 * (e.g. "25.11.2026, 14:35" for de, "11/25/2026, 14:35" for en). Used for
 * the pre-confirm preview and everywhere the schedule is displayed, so the
 * user always sees the local time they chose, in their UI language.
 */
export function formatScheduledLocal(
  utcIso: string,
  timeZone: string,
  locale: string,
): string {
  const parts = new Intl.DateTimeFormat(locale, {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(utcIso));
  return parts;
}

/**
 * The local wall-clock parts of a stored UTC instant in a zone — used to
 * prefill the reschedule form with the campaign's CURRENT scheduled time.
 * (en-CA formats year-first, so parsing the parts is unambiguous.)
 */
export function utcToLocalParts(
  utcIso: string,
  timeZone: string,
): WallClockTime | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(utcIso));
  } catch {
    return null;
  }
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute)
  )
    return null;
  return { year, month, day, hour, minute };
}

/** The zone's offset label at the instant (\"+01:00\"), for display/audit. */
export function offsetLabelAt(utcIso: string, timeZone: string): string {
  const minutes = tzOffsetMinutes(Date.parse(utcIso), timeZone);
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}
