/**
 * schedule-time — IANA wall-clock ↔ UTC conversion for scheduled sends.
 *
 * DST facts used below (tzdb, 2026):
 *  - Europe/Berlin: spring-forward 29.03.2026 01:00 UTC (02:00→03:00 local);
 *    fall-back 25.10.2026 01:00 UTC (03:00→02:00 local).
 *  - Africa/Casablanca: UTC+0 in November 2026. Morocco's 2018 rule
 *    (+1 year-round except Ramadan) ended during 2026 (last +1 stretch ran
 *    into late summer); tzdb now projects Morocco back to UTC+0, so
 *    November 2026 is the plain +0 offset. (Older tzdata bundled in some
 *    2026 Node builds still shows +1 here — Node ≥ 22.23.3 / current
 *    browsers are +0, which is the value asserted below.)
 *  - America/New_York: EDT (UTC−4) in July, EST (UTC−5) in November.
 */
import { describe, expect, it } from "vitest";
import {
  formatScheduledLocal,
  isSupportedTimezone,
  isValidCalendarDate,
  offsetLabelAt,
  probeTzdb,
  tzOffsetMinutes,
  wallClockToUtc,
  utcToLocalParts,
  type ScheduleTimeResult,
} from "@/lib/schedule-time";

/** "ok" or the failure reason (narrows the discriminated union). */
const reasonOf = (result: ScheduleTimeResult): string =>
  result.ok ? "ok" : result.reason;

describe("basic wall-clock → UTC conversion", () => {
  it("converts a normal (non-DST) local time, incl. the task's example zone", () => {
    // 25 Nov 2026, 14:35 in Africa/Casablanca (UTC+0 since the 2026 rule
    // change — Morocco reverted to plain WET) → 14:35 UTC
    const result = wallClockToUtc(
      { year: 2026, month: 11, day: 25, hour: 14, minute: 35 },
      "Africa/Casablanca",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.utcIso).toBe("2026-11-25T14:35:00.000Z");
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
      "25.11.2026, 13:35",
    );
    // Same instant in Berlin (UTC+1) → 14:35 (round-trip sanity),
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
    // Morocco is on plain UTC+0 in November 2026 (2026 tzdb rule change).
    expect(offsetLabelAt("2026-11-25T13:35:00.000Z", "Africa/Casablanca")).toBe(
      "+00:00",
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

// ─────────────────────────────────────────────────────────────────────────
// tzdata consistency — the 2026-10-11 Casablanca incident (UI showed +01:00,
// current tzdb says +00:00) and the invariants that keep the preview
// (display) and the UTC conversion in agreement on ANY runtime tzdb.
// ─────────────────────────────────────────────────────────────────────────

/** The "+HH:MM" offset label implied by the conversion itself:
 *  offset = wall-clock − UTC (the inverse of the utc − wall delta). */
function labelFromDelta(
  utcMs: number,
  wall: { year: number; month: number; day: number; hour: number; minute: number },
): string {
  const deltaMin = Math.round(
    (Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) - utcMs) /
      60000,
  );
  const sign = deltaMin < 0 ? "-" : "+";
  const abs = Math.abs(deltaMin);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(
    abs % 60,
  ).padStart(2, "0")}`;
}

describe("tzdata consistency (Morocco 2026 rule change + display/conversion parity)", () => {
  it("the reported case: Africa/Casablanca on 2026-10-11 is UTC+0", () => {
    // Morocco's 2018 rule (+1 except Ramadan) ended during 2026 — its last
    // +1 stretch ran into late summer; current tzdb projects +0 from then
    // on. Runtimes with OLDER tzdata (e.g. Node <= 22.23.2) still report
    // +01:00 here; the /api/health tzdb probe exposes that divergence.
    expect(
      offsetLabelAt("2026-10-11T00:20:00.000Z", "Africa/Casablanca"),
    ).toBe("+00:00");
    const result = wallClockToUtc(
      { year: 2026, month: 10, day: 11, hour: 0, minute: 20 },
      "Africa/Casablanca",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.utcIso).toBe("2026-10-11T00:20:00.000Z");
      // Exactly the preview string the UI renders (en locale):
      expect(formatScheduledLocal(result.utcIso, "Africa/Casablanca", "en")).toBe(
        "10/11/2026, 00:20",
      );
    }
  });

  it("pins the Morocco rule change in both directions", () => {
    // Version-independent pins (old AND current tzdb agree):
    expect(offsetLabelAt("2025-11-25T23:20:00.000Z", "Africa/Casablanca")).toBe(
      "+01:00",
    ); // old rule still in force
    expect(offsetLabelAt("2026-08-25T12:00:00.000Z", "Africa/Casablanca")).toBe(
      "+01:00",
    ); // last +1 stretch
    // Current-tzdb pins (CI runs Node 22.23.3 / current tzdata):
    expect(offsetLabelAt("2026-10-11T00:20:00.000Z", "Africa/Casablanca")).toBe(
      "+00:00",
    );
    expect(offsetLabelAt("2027-03-10T12:00:00.000Z", "Africa/Casablanca")).toBe(
      "+00:00",
    );
  });

  it("preview and conversion always agree: round-trip + displayed offset == conversion delta (any tzdb version)", () => {
    const cases: Array<{
      wall: { year: number; month: number; day: number; hour: number; minute: number };
      zone: string;
    }> = [
      { wall: { year: 2026, month: 1, day: 15, hour: 10, minute: 0 }, zone: "Europe/Berlin" },
      { wall: { year: 2026, month: 7, day: 1, hour: 10, minute: 0 }, zone: "Europe/Berlin" },
      { wall: { year: 2026, month: 1, day: 15, hour: 10, minute: 0 }, zone: "America/New_York" },
      { wall: { year: 2026, month: 7, day: 1, hour: 10, minute: 0 }, zone: "America/New_York" },
      { wall: { year: 2025, month: 11, day: 25, hour: 10, minute: 0 }, zone: "Africa/Casablanca" },
      { wall: { year: 2026, month: 10, day: 11, hour: 0, minute: 20 }, zone: "Africa/Casablanca" },
      { wall: { year: 2027, month: 3, day: 10, hour: 10, minute: 0 }, zone: "Africa/Casablanca" },
    ];
    for (const { wall, zone } of cases) {
      const result = wallClockToUtc(wall, zone);
      expect(result.ok, `${zone} ${wall.year}-${wall.month}-${wall.day}`).toBe(true);
      if (!result.ok) continue;
      // 1) The stored instant renders back to the entered wall-clock time.
      expect(utcToLocalParts(result.utcIso, zone)).toEqual(wall);
      // 2) The offset the UI displays equals the conversion's own delta —
      //    display can never diverge from conversion, on any tzdb version.
      expect(offsetLabelAt(result.utcIso, zone)).toBe(labelFromDelta(result.utcMs, wall));
    }
  });

  it("America/New_York 2026: spring gap does not exist, fall fold is ambiguous", () => {
    // US DST 2026: starts Sun 08.03.2026 07:00 UTC (02:00→03:00 local),
    // ends Sun 01.11.2026 06:00 UTC (02:00→01:00 local).
    expect(
      reasonOf(
        wallClockToUtc(
          { year: 2026, month: 3, day: 8, hour: 2, minute: 30 },
          "America/New_York",
        ),
      ),
    ).toBe("nonexistent");
    expect(
      reasonOf(
        wallClockToUtc(
          { year: 2026, month: 11, day: 1, hour: 1, minute: 30 },
          "America/New_York",
        ),
      ),
    ).toBe("ambiguous");
    const fold = wallClockToUtc(
      { year: 2026, month: 11, day: 1, hour: 1, minute: 30 },
      "America/New_York",
    );
    expect(fold.ok).toBe(false);
    if (!fold.ok && fold.reason === "ambiguous") {
      expect(fold.firstUtcIso).toBe("2026-11-01T05:30:00.000Z"); // EDT (-4)
      expect(fold.secondUtcIso).toBe("2026-11-01T06:30:00.000Z"); // EST (-5)
      // Explicit resolution picks the exact instant (parity with Berlin).
      expect(
        wallClockToUtc(
          { year: 2026, month: 11, day: 1, hour: 1, minute: 30 },
          "America/New_York",
          "end",
        ),
      ).toMatchObject({ ok: true, utcIso: "2026-11-01T06:30:00.000Z", resolvedAmbiguity: "end" });
    }
  });

  it("the tzdb probe exposes a stale runtime (current tzdb ⇒ all probes current)", () => {
    const probes = probeTzdb();
    expect(probes.map((p) => p.name)).toEqual([
      "casablanca-2026-10",
      "berlin-2026-11",
    ]);
    // Berlin is a stable control: every tzdb since 1996 says +01:00 —
    // a mismatch here means Intl itself is broken, not the tzdata.
    const berlin = probes.find((p) => p.name === "berlin-2026-11");
    expect(berlin?.offset).toBe("+01:00");
    expect(berlin?.current).toBe(true);
    // Casablanca is the rule-change sentinel (current tzdb ⇒ +00:00).
    const casablanca = probes.find((p) => p.name === "casablanca-2026-10");
    expect(casablanca?.offset).toBe("+00:00");
    expect(casablanca?.current).toBe(true);
  });
});
