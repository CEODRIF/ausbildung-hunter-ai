/**
 * Issue 1 — clear completed campaigns from the Review queue after sending.
 *
 * `splitBewReviewApps` is the single source of truth for what the Review step
 * lists. It must remove ONLY confirmed-sent rows from the active queue while
 * preserving failed / unconfirmed (needs_attention) / cancelled / excluded
 * (restorable) rows, and keep the sent rows available as history (never
 * deleting the underlying records).
 */
import { describe, expect, it } from "vitest";

import { splitBewReviewApps } from "@/components/bewerbung-automation/types";

type A = { id: string; status: string; company_name: string };

describe("splitBewReviewApps — the Review queue clears only confirmed sends", () => {
  it("removes confirmed-sent rows from the active queue, keeps them in sent", () => {
    const apps: A[] = [
      { id: "a", status: "sent", company_name: "SentCo" },
      { id: "b", status: "generated", company_name: "GenCo" },
    ];
    const { active, sent } = splitBewReviewApps(apps);
    expect(sent.map((x) => x.id)).toEqual(["a"]);
    expect(active.map((x) => x.id)).toEqual(["b"]);
  });

  it("keeps failed, unconfirmed (needs_attention) and cancelled rows in the active queue", () => {
    const apps: A[] = [
      { id: "f", status: "failed", company_name: "F" },
      { id: "n", status: "needs_attention", company_name: "N" },
      { id: "c", status: "cancelled", company_name: "C" },
    ];
    const { active, sent } = splitBewReviewApps(apps);
    expect(sent).toEqual([]);
    expect(active.map((x) => x.id).sort()).toEqual(["c", "f", "n"]);
  });

  it("keeps excluded (restorable), pending, generating, queued and sending rows", () => {
    const apps: A[] = [
      { id: "e", status: "excluded", company_name: "E" },
      { id: "p", status: "pending", company_name: "P" },
      { id: "g", status: "generating", company_name: "G" },
      { id: "q", status: "queued", company_name: "Q" },
      { id: "s", status: "sending", company_name: "S" },
    ];
    const { active, sent } = splitBewReviewApps(apps);
    expect(sent).toEqual([]);
    expect(active.map((x) => x.id).sort()).toEqual(["e", "g", "p", "q", "s"]);
  });

  it("partial success: removes ONLY the confirmed-sent rows, retaining the rest with their statuses", () => {
    const apps: A[] = [
      { id: "1", status: "sent", company_name: "OK" },
      { id: "2", status: "failed", company_name: "FAIL" },
      { id: "3", status: "sent", company_name: "OK2" },
      { id: "4", status: "needs_attention", company_name: "UNCERTAIN" },
    ];
    const { active, sent } = splitBewReviewApps(apps);
    expect(sent.map((x) => x.id).sort()).toEqual(["1", "3"]);
    expect(active.map((x) => x.id).sort()).toEqual(["2", "4"]);
    // Accurate statuses are preserved for the retained entries.
    expect(active.find((x) => x.id === "2")!.status).toBe("failed");
    expect(active.find((x) => x.id === "4")!.status).toBe("needs_attention");
  });

  it("a fully-sent campaign leaves the active queue empty with all rows in sent", () => {
    const { active, sent } = splitBewReviewApps<A>([
      { id: "1", status: "sent", company_name: "A" },
      { id: "2", status: "sent", company_name: "B" },
    ]);
    expect(active).toEqual([]);
    expect(sent).toHaveLength(2);
  });

  it("does not mutate the input array", () => {
    const apps: A[] = [
      { id: "1", status: "sent", company_name: "A" },
      { id: "2", status: "generated", company_name: "B" },
    ];
    splitBewReviewApps(apps);
    expect(apps).toHaveLength(2);
    expect(apps[0].status).toBe("sent");
  });
});
