/**
 * schedule-time — IANA wall-clock ↔ UTC conversion for scheduled sends.
 *
 * DST facts used below (tzdb, 2026):
 *  - Europe/Berlin: spring-forward 29.03.2026 01:00 UTC (02:00→03:00 local);
 *    fall-back 25.10.2026 01:00 UTC (03:00→02:00 local).
 *  - Africa/Casablanca: UTC+1 in November 2026 (Morocco is on winter time).
 *  - America/New_York: EDT (UTC−4) in July, EST (UTC−5) in November.
 */
import { describe, expect, it } from "vitest";
import {
  formatScheduledLocal,
  isSupportedTimezone,
  isValidCalendarDate,
  offsetLabelAt,
  tzOffsetMinutes,
  wallClockToUtc,
  type ScheduleTimeResult,
} from "@/lib/schedule-time";

/** "ok" or the failure reason (narrows the discriminated union). */
const reasonOf = (result: ScheduleTimeResult): string =>
  result.ok ? "ok" : result.reason;

describe("basic wall-clock → UTC conversion", () => {
  it("converts a normal (non-DST) local time, incl. the task's example zone", () => {
    // 25 Nov 2026, 14:35 in Africa/Casablanca (UTC+1) → 13:35 UTC
    const result = wallClockToUtc(
      { year: 2026, month: 11, day: 25, hour: 14, minute: 35 },
      "Africa/Casablanca",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.utcIso).toBe("2026-11-25T13:35:00.000Z");
      expect(result.resolvedAmbiguity).toBeNull();
    }
  });

  it("uses summer/winter offsets correctly for Europe/Berlin", () => {
    const summer = wallClockToUtc(
      { year: 2026, month: 7, day: 15, hour: 14, minute: 35 },
      "Europe/Berlin",
    );
    expect(summer.ok && summer.utcIso).toBe("2026-07-15T12:35:00.000Z"); // CEST +2
    const winter = wallClockToUtc(
      { year: 2026, month: 1, day: 15, hour: 14, minute: 35 },
      "Europe/Berlin",
    );
    expect(winter.ok && winter.utcIso).toBe("2026-01-15T13:35:00.000Z"); // CET +1
  });

  it("handles negative offsets (America/New_York)", () => {
    const july = wallClockToUtc(
      { year: 2026, month: 7, day: 1, hour: 12, minute: 0 },
      "America/New_York",
    );
    expect(july.ok && july.utcIso).toBe("2026-07-01T16:00:00.000Z"); // EDT −4
    const january = wallClockToUtc(
      { year: 2026, month: 1, day: 1, hour: 12, minute: 0 },
      "America/New_York",
    );
    expect(january.ok && january.utcIso).toBe("2026-01-01T17:00:00.000Z"); // EST −5
  });

  it("UTC itself is the identity", () => {
    const result = wallClockToUtc(
      { year: 2026, month: 11, day: 25, hour: 14, minute: 35 },
      "UTC",
    );
    expect(result.ok && result.utcIso).toBe("2026-11-25T14:35:00.000Z");
  });
});

describe("daylight-saving transitions are explicit, never silent", () => {
  it("rejects a NONEXISTENT local time (Berlin spring gap: 29.03.2026 02:30)", () => {
    const result = wallClockToUtc(
      { year: 2026, month: 3, day: 29, hour: 2, minute: 30 },
      "Europe/Berlin",
    );
    expect(result).toEqual({ ok: false, reason: "nonexistent" });
    // 03:30 (just after the gap) is fine:
    const after = wallClockToUtc(
      { year: 2026, month: 3, day: 29, hour: 3, minute: 30 },
      "Europe/Berlin",
    );
    expect(after.ok && after.utcIso).toBe("2026-03-29T01:30:00.000Z");
  });

  it("reports an AMBIGUOUS local time (Berlin fall fold: 25.10.2026 02:30) with both candidates", () => {
    const result = wallClockToUtc(
      { year: 2026, month: 10, day: 25, hour: 2, minute: 30 },
      "Europe/Berlin",
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "ambiguous") {
      // First occurrence: still CEST (+2) → 00:30Z. Second: CET (+1) → 01:30Z.
      expect(result.firstUtcIso).toBe("2026-10-25T00:30:00.000Z");
      expect(result.secondUtcIso).toBe("2026-10-25T01:30:00.000Z");
    } else {
      throw new Error(`Expected ambiguous, got: ${JSON.stringify(result)}`);
    }
  });

  it("only produces an instant for the fold when the user explicitly resolves it", () => {
    const wall = { year: 2026, month: 10, day: 25, hour: 2, minute: 30 };
    const start = wallClockToUtc(wall, "Europe/Berlin", "start");
    expect(start.ok && start.utcIso).toBe("2026-10-25T00:30:00.000Z");
    expect(start.ok && start.resolvedAmbiguity).toBe("start");
    const end = wallClockToUtc(wall, "Europe/Berlin", "end");
    expect(end.ok && end.utcIso).toBe("2026-10-25T01:30:00.000Z");
    expect(end.ok && end.resolvedAmbiguity).toBe("end");
  });

  it("times far from any transition are never ambiguous", () => {
    const result = wallClockToUtc(
      { year: 2026, month: 10, day: 25, hour: 12, minute: 0 },
      "Europe/Berlin",
    );
    expect(result.ok).toBe(true);
  });
});

describe("invalid input", () => {
  const wall = { year: 2026, month: 11, day: 25, hour: 14, minute: 35 };
  it("rejects impossible calendar dates", () => {
    expect(reasonOf(wallClockToUtc({ ...wall, month: 2, day: 30 }, "Europe/Berlin"))).toBe("invalid");
    expect(reasonOf(wallClockToUtc({ ...wall, day: 0 }, "Europe/Berlin"))).toBe("invalid");
    expect(reasonOf(wallClockToUtc({ ...wall, month: 13 }, "Europe/Berlin"))).toBe("invalid");
    expect(reasonOf(wallClockToUtc({ ...wall, year: 1999 }, "Europe/Berlin"))).toBe("invalid");
  });
  it("rejects out-of-range clock values", () => {
    expect(reasonOf(wallClockToUtc({ ...wall, hour: 24 }, "Europe/Berlin"))).toBe("invalid");
    expect(reasonOf(wallClockToUtc({ ...wall, minute: 60 }, "Europe/Berlin"))).toBe("invalid");
    expect(reasonOf(wallClockToUtc({ ...wall, hour: -1 }, "Europe/Berlin"))).toBe("invalid");
  });
  it("rejects unknown timezones (the allow-list is the contract)", () => {
    expect(reasonOf(wallClockToUtc(wall, "Mars/Olympus"))).toBe("invalid");
    expect(isSupportedTimezone("Mars/Olympus")).toBe(false);
    expect(isSupportedTimezone("Africa/Casablanca")).toBe(true);
  });
});

describe("calendar helpers", () => {
  it("isValidCalendarDate covers leap years", () => {
    expect(isValidCalendarDate(2028, 2, 29)).toBe(true);
    expect(isValidCalendarDate(2026, 2, 29)).toBe(false);
    expect(isValidCalendarDate(2026, 12, 31)).toBe(true);
  });
});

describe("display helpers (UTC → local preview)", () => {
  it("formats the stored instant in the campaign's zone, locale-aware", () => {
    const iso = "2026-11-25T13:35:00.000Z";
    expect(formatScheduledLocal(iso, "Africa/Casablanca", "de")).toBe(
      "25.11.2026, 14:35",
    );
    // Same instant in Berlin (UTC+1) → 14:35 as well (round-trip sanity),
    // and in New York (UTC−5) → 08:35.
    // "en" (en-US) formats month-first: 11/25/2026.
    expect(formatScheduledLocal(iso, "Europe/Berlin", "en")).toMatch(
      /11\/25\/2026,\s*14:35/,
    );
    expect(formatScheduledLocal(iso, "America/New_York", "en")).toMatch(
      /11\/25\/2026,\s*08:35/,
    );
  });

  it("offset labels are signed and minute-exact", () => {
    expect(offsetLabelAt("2026-11-25T13:35:00.000Z", "Africa/Casablanca")).toBe(
      "+01:00",
    );
    expect(offsetLabelAt("2026-07-15T12:35:00.000Z", "Europe/Berlin")).toBe(
      "+02:00",
    );
    expect(offsetLabelAt("2026-01-15T17:00:00.000Z", "America/New_York")).toBe(
      "-05:00",
    );
    expect(tzOffsetMinutes(Date.parse("2026-01-01T00:00:00Z"), "UTC")).toBe(0);
  });

  it("round-trip: utc → local parts → utc is stable for unambiguous times", () => {
    const result = wallClockToUtc(
      { year: 2026, month: 12, day: 31, hour: 23, minute: 59 },
      "Europe/Berlin",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const preview = formatScheduledLocal(result.utcIso, "Europe/Berlin", "de");
      expect(preview).toBe("31.12.2026, 23:59");
    }
  });
});
