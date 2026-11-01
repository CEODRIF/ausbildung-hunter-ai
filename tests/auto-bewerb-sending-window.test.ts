/**
 * AUTO BEWERB — exact daily sending window (Europe/Berlin, 07:30–10:30).
 *
 * Pure, DST-aware window logic (src/lib/auto-bewerb/sending-window.ts).
 * The window is defined in IANA wall-clock time, so every assertion below
 * pins a specific UTC instant and the expected open/closed answer — which is
 * what makes the daylight-saving transitions testable deterministically.
 *
 * 2026 German DST transitions (last Sunday of March / October):
 *   - Spring-forward: 2026-03-29 at 01:00 UTC  (CET UTC+1 → CEST UTC+2)
 *   - Fall-back:      2026-10-25 at 02:00 UTC  (CEST UTC+2 → CET UTC+1)
 * 07:30 Berlin is far from the 02:00–03:00 transition, so it is always a
 * unique, existing local time (never ambiguous / nonexistent).
 */
import { describe, expect, it } from "vitest";
import {
  AUTO_BEWERB_SENDING_WINDOW,
  formatWindowTime,
  isCampaignTimeInWindow,
  isSendingWindowOpen,
  isWithinSendingWindow,
  nextWindowStartMs,
  sendingWindowState,
} from "@/lib/auto-bewerb/sending-window";

const at = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h, mi, 0);
const atS = (y: number, mo: number, d: number, h: number, mi: number, s: number) => Date.UTC(y, mo - 1, d, h, mi, s);

describe("window definition", () => {
  it("uses IANA Europe/Berlin (never a fixed offset), 07:30–10:30", () => {
    expect(AUTO_BEWERB_SENDING_WINDOW.timeZone).toBe("Europe/Berlin");
    expect(AUTO_BEWERB_SENDING_WINDOW.startHour * 60 + AUTO_BEWERB_SENDING_WINDOW.startMinute).toBe(7 * 60 + 30);
    expect(AUTO_BEWERB_SENDING_WINDOW.endHour * 60 + AUTO_BEWERB_SENDING_WINDOW.endMinute).toBe(10 * 60 + 30);
  });
});

describe("winter day (CET, UTC+1) — 2026-01-15", () => {
  // 07:29/07:30 Berlin = 06:29/06:30 UTC; 10:29/10:30/10:31 Berlin = 09:29/09:30/09:31 UTC.
  it("07:29 → closed", () => expect(isSendingWindowOpen(at(2026, 1, 15, 6, 29))).toBe(false));
  it("07:30 → open (start inclusive)", () => expect(isSendingWindowOpen(at(2026, 1, 15, 6, 30))).toBe(true));
  it("10:29 → open", () => expect(isSendingWindowOpen(at(2026, 1, 15, 9, 29))).toBe(true));
  it("10:30 → open (end inclusive: a campaign scheduled for exactly 10:30 starts on the 10:30 tick)", () =>
    expect(isSendingWindowOpen(at(2026, 1, 15, 9, 30))).toBe(true));
  it("the whole 10:30 minute is open (10:30:59), 10:31:00 is closed", () => {
    expect(isSendingWindowOpen(atS(2026, 1, 15, 9, 30, 59))).toBe(true);
    expect(isSendingWindowOpen(at(2026, 1, 15, 9, 31))).toBe(false);
  });
});

describe("summer day (CEST, UTC+2) — 2026-07-15", () => {
  // 07:29/07:30 Berlin = 05:29/05:30 UTC; 10:29/10:30/10:31 Berlin = 08:29/08:30/08:31 UTC.
  it("07:29 → closed", () => expect(isSendingWindowOpen(at(2026, 7, 15, 5, 29))).toBe(false));
  it("07:30 → open (start inclusive)", () => expect(isSendingWindowOpen(at(2026, 7, 15, 5, 30))).toBe(true));
  it("10:29 → open", () => expect(isSendingWindowOpen(at(2026, 7, 15, 8, 29))).toBe(true));
  it("10:30 → open (end inclusive)", () => expect(isSendingWindowOpen(at(2026, 7, 15, 8, 30))).toBe(true));
  it("10:31 → closed", () => expect(isSendingWindowOpen(at(2026, 7, 15, 8, 31))).toBe(false));
});

describe("spring-forward transition 2026-03-29 (CET→CEST at 01:00 UTC)", () => {
  // After 01:00 UTC Berlin is CEST (UTC+2): 07:30 Berlin = 05:30 UTC.
  it("07:29 Berlin (05:29 UTC) → closed", () => expect(isSendingWindowOpen(at(2026, 3, 29, 5, 29))).toBe(false));
  it("07:30 Berlin (05:30 UTC) → open", () => expect(isSendingWindowOpen(at(2026, 3, 29, 5, 30))).toBe(true));
  it("10:29 Berlin (08:29 UTC) → open", () => expect(isSendingWindowOpen(at(2026, 3, 29, 8, 29))).toBe(true));
  it("10:30 Berlin (08:30 UTC) → open (end inclusive)", () => expect(isSendingWindowOpen(at(2026, 3, 29, 8, 30))).toBe(true));
  it("10:31 Berlin (08:31 UTC) → closed", () => expect(isSendingWindowOpen(at(2026, 3, 29, 8, 31))).toBe(false));
});

describe("fall-back transition 2026-10-25 (CEST→CET at 02:00 UTC)", () => {
  // After 02:00 UTC Berlin is CET (UTC+1): 07:30 Berlin = 06:30 UTC.
  it("07:29 Berlin (06:29 UTC) → closed", () => expect(isSendingWindowOpen(at(2026, 10, 25, 6, 29))).toBe(false));
  it("07:30 Berlin (06:30 UTC) → open", () => expect(isSendingWindowOpen(at(2026, 10, 25, 6, 30))).toBe(true));
  it("10:29 Berlin (09:29 UTC) → open", () => expect(isSendingWindowOpen(at(2026, 10, 25, 9, 29))).toBe(true));
  it("10:30 Berlin (09:30 UTC) → open (end inclusive)", () => expect(isSendingWindowOpen(at(2026, 10, 25, 9, 30))).toBe(true));
  it("10:31 Berlin (09:31 UTC) → closed", () => expect(isSendingWindowOpen(at(2026, 10, 25, 9, 31))).toBe(false));
});

describe("isWithinSendingWindow — the scheduling validation matrix (Berlin wall-clock)", () => {
  it("accepts every valid start time", () => {
    expect(isWithinSendingWindow(7, 30)).toBe(true);
    expect(isWithinSendingWindow(8, 0)).toBe(true);
    expect(isWithinSendingWindow(9, 0)).toBe(true);
    expect(isWithinSendingWindow(10, 0)).toBe(true);
    expect(isWithinSendingWindow(10, 30)).toBe(true);
  });
  it("rejects every out-of-window time", () => {
    expect(isWithinSendingWindow(7, 29)).toBe(false);
    expect(isWithinSendingWindow(10, 31)).toBe(false);
    expect(isWithinSendingWindow(11, 0)).toBe(false);
    expect(isWithinSendingWindow(20, 0)).toBe(false);
  });
});

describe("isCampaignTimeInWindow — server validation of a requested start instant", () => {
  // Winter (CET, UTC+1): 08:00 Berlin = 07:00 UTC; 10:30 Berlin = 09:30 UTC.
  it("accepts instants whose Berlin wall-clock is in-window (winter)", () => {
    expect(isCampaignTimeInWindow(at(2026, 1, 15, 7, 0))).toBe(true); // 08:00 Berlin
    expect(isCampaignTimeInWindow(at(2026, 1, 15, 9, 30))).toBe(true); // 10:30 Berlin
  });
  it("rejects instants outside the window (winter)", () => {
    expect(isCampaignTimeInWindow(at(2026, 1, 15, 6, 29))).toBe(false); // 07:29 Berlin
    expect(isCampaignTimeInWindow(at(2026, 1, 15, 9, 31))).toBe(false); // 10:31 Berlin
    expect(isCampaignTimeInWindow(at(2026, 1, 15, 20, 0))).toBe(false); // 20:00 Berlin
  });
  // Summer (CEST, UTC+2): 09:00 Berlin = 07:00 UTC — the SAME UTC instant as
  // 08:00 Berlin in winter, correctly evaluated in Berlin wall-clock time.
  it("evaluates the instant in Europe/Berlin, not a fixed offset (summer)", () => {
    expect(isCampaignTimeInWindow(at(2026, 7, 15, 7, 0))).toBe(true); // 09:00 Berlin
    expect(isCampaignTimeInWindow(at(2026, 7, 15, 8, 31))).toBe(false); // 10:31 Berlin
  });
  it("fails closed on non-finite instants", () => {
    expect(isCampaignTimeInWindow(NaN)).toBe(false);
    expect(isCampaignTimeInWindow(Infinity)).toBe(false);
  });
});

describe("window state shape + duration", () => {
  it("reports the local wall-clock time and the boundary", () => {
    const s = sendingWindowState(at(2026, 1, 15, 6, 45)); // 07:45 Berlin
    expect(s).toMatchObject({ open: true, hour: 7, minute: 45, timeZone: "Europe/Berlin" });
    // 07:30 open, 10:30 open (end inclusive), 10:31 closed.
    expect(isSendingWindowOpen(at(2026, 1, 15, 6, 30))).toBe(true);
    expect(isSendingWindowOpen(at(2026, 1, 15, 9, 30))).toBe(true);
    expect(isSendingWindowOpen(at(2026, 1, 15, 9, 31))).toBe(false);
  });

  it("fails closed for an unknown timezone", () => {
    expect(sendingWindowState(at(2026, 1, 15, 6, 30), "Mars/Olympus").open).toBe(false);
  });
});

describe("nextWindowStartMs", () => {
  it("returns null while the window is open", () => {
    expect(nextWindowStartMs(at(2026, 1, 15, 7, 0))).toBeNull(); // 08:00 Berlin, open
  });

  it("before the window (same day) → today's 07:30 Berlin", () => {
    // 06:00 Berlin = 05:00 UTC → next start 07:30 Berlin = 06:30 UTC (same day).
    expect(nextWindowStartMs(at(2026, 1, 15, 5, 0))).toBe(at(2026, 1, 15, 6, 30));
  });

  it("after the window (same day) → tomorrow's 07:30 Berlin", () => {
    // 11:00 Berlin = 10:00 UTC → next start next day 07:30 Berlin = 06:30 UTC.
    expect(nextWindowStartMs(at(2026, 1, 15, 10, 0))).toBe(at(2026, 1, 16, 6, 30));
  });

  it("next-day transition, winter: 1 Nov 11:00 Berlin → 2 Nov 07:30 Berlin (the reported display case)", () => {
    // 2026-11-01T10:00Z = 11:00 Berlin (CET, window closed) → next start is
    // 2026-11-02T06:30Z, which IS 2 Nov 07:30 Germany time (CET).
    expect(nextWindowStartMs(at(2026, 11, 1, 10, 0))).toBe(at(2026, 11, 2, 6, 30));
  });

  it("before the window (same day), summer CEST → today's 07:30 Berlin = 05:30 UTC", () => {
    // 06:00 Berlin = 04:00 UTC (CEST) → next start 07:30 Berlin = 05:30 UTC.
    expect(nextWindowStartMs(at(2026, 7, 15, 4, 0))).toBe(at(2026, 7, 15, 5, 30));
  });

  it("next-day transition, summer CEST: 15 Jul 11:00 Berlin → 16 Jul 07:30 Berlin (05:30 UTC)", () => {
    expect(nextWindowStartMs(at(2026, 7, 15, 9, 0))).toBe(at(2026, 7, 16, 5, 30));
  });

  it("returns null while the window is open (summer)", () => {
    // 08:00 Berlin = 06:00 UTC (CEST) → open.
    expect(nextWindowStartMs(at(2026, 7, 15, 6, 0))).toBeNull();
  });
});

describe("formatWindowTime — window timestamps display in Europe/Berlin (DST-aware)", () => {
  // The scheduler stores correct UTC instants; the DISPLAY must render them
  // in Germany local time — never UTC, never the browser's zone.
  it("CET (winter): 2 Nov 06:30 UTC renders as 07:30, not 06:30", () => {
    const ms = at(2026, 11, 2, 6, 30); // = 2 Nov 07:30 Berlin (CET)
    expect(formatWindowTime(ms, "en-GB")).toContain("07:30");
    expect(formatWindowTime(ms, "en-GB")).not.toContain("06:30");
    // Negative control: the same instant formatted in UTC shows 06:30 —
    // proving the zone argument is what makes the display correct.
    const utc = new Date(ms).toLocaleString("en-GB", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" });
    expect(utc).toContain("06:30");
  });

  it("CEST (summer): 2 Jul 05:30 UTC renders as 07:30, not 05:30", () => {
    const ms = at(2026, 7, 2, 5, 30); // = 2 Jul 07:30 Berlin (CEST)
    expect(formatWindowTime(ms, "en-GB")).toContain("07:30");
    expect(formatWindowTime(ms, "en-GB")).not.toContain("05:30");
  });

  it("is locale-aware (de-DE renders the same 07:30 wall-clock time)", () => {
    const ms = at(2026, 11, 2, 6, 30);
    expect(formatWindowTime(ms, "de-DE")).toContain("07:30");
  });

  it("handles the next-day transition instants for both CET and CEST", () => {
    expect(formatWindowTime(nextWindowStartMs(at(2026, 11, 1, 10, 0))!, "en-GB")).toContain("07:30"); // winter
    expect(formatWindowTime(nextWindowStartMs(at(2026, 7, 15, 9, 0))!, "en-GB")).toContain("07:30"); // summer
  });
});
