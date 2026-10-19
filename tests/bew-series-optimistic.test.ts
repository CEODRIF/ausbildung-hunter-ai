/**
 * Bewerbung Automation — "+ New series" instant-open regression suite.
 *
 * Requirements pinned here:
 *   1. The new series interface opens at CLICK time, before any network:
 *      `buildPendingView` builds the view locally. Its shape mirrors EXACTLY
 *      what the server returns right after creation (count empty pending rows
 *      seq 1..n, zeroed counters, no documents, the current usage) — nothing
 *      is faked, and the placeholder ids can never collide with real row ids.
 *   2. On confirmation the drafts typed into the placeholder rows are remapped
 *      onto the real row ids by seed seq (`remapPendingDrafts`): 1:1, orphans
 *      dropped, same-reference no-op when there is nothing to remap.
 *   3. Static contract on client.tsx: the pending-view swap is synchronous
 *      and happens BEFORE `await bewCreateCampaignView(...)`; a ref guard
 *      prevents duplicate creation; on failure the previous view is restored
 *      (only while the pending view is still on screen); the OLD two-action
 *      creation sequence (create + follow-up view action) is no longer
 *      imported or used.
 */
import { describe, expect, it } from "vitest";

import {
  PENDING_APP_ID_PREFIX,
  PENDING_CAMPAIGN_ID,
  buildPendingView,
  isPendingAppId,
  isPendingCampaignId,
  pendingAppSeq,
  remapPendingDrafts,
} from "@/components/bewerbung-automation/pending-series";
import type { Drafts } from "@/components/bewerbung-automation/row-state";
import type { BewViewDTO } from "@/components/bewerbung-automation/types";

function previousView(): BewViewDTO {
  return {
    campaign: {
      id: "camp-old",
      user_id: "user-1",
      email_account_id: "acct-1",
      purpose: "ausbildung",
      status: "draft",
      requested_count: 2,
      valid_count: 1,
      total_count: 2,
      generated_count: 0,
      sent_count: 0,
      failed_count: 0,
      excluded_count: 0,
      usage_date: "2026-10-18",
      created_at: "2026-10-18T08:00:00.000Z",
      started_at: null,
      completed_at: null,
    },
    applications: [],
    documents: [],
    usage: { remaining: 9, daily_limit: 50 },
    senderEmail: "sender@gmail.com",
  };
}

/* ------------------------------------------------------------------ *
 * A. buildPendingView — the local instant view
 * ------------------------------------------------------------------ */

describe("buildPendingView", () => {
  it("mirrors the server view of a fresh campaign: count rows seq 1..n, all pending + empty", () => {
    const v = buildPendingView(previousView(), 4, "arbeit");
    expect(v.campaign.id).toBe(PENDING_CAMPAIGN_ID);
    expect(v.campaign.user_id).toBe("user-1"); // carried over
    expect(v.campaign.purpose).toBe("arbeit");
    expect(v.campaign.status).toBe("draft");
    expect(v.campaign.email_account_id).toBeNull();
    expect(v.campaign.requested_count).toBe(4);
    // Zeroed counters — identical to a just-created campaign.
    expect(v.campaign.valid_count).toBe(0);
    expect(v.campaign.total_count).toBe(0);
    expect(v.campaign.generated_count).toBe(0);
    expect(v.campaign.sent_count).toBe(0);
    expect(v.campaign.failed_count).toBe(0);
    expect(v.campaign.excluded_count).toBe(0);
    // The requested number of empty PENDING rows, in seed order.
    expect(v.applications).toHaveLength(4);
    v.applications.forEach((a, i) => {
      expect(a.id).toBe(`${PENDING_APP_ID_PREFIX}${i + 1}`);
      expect(a.seq).toBe(i + 1);
      expect(a.status).toBe("pending");
      expect(a.company_name).toBe("");
      expect(a.company_email).toBe("");
      expect(a.contact_name).toBeNull();
      expect(a.company_address).toBeNull();
      expect(a.subject).toBe("");
      expect(a.body_html).toBe("");
      expect(a.body_text).toBe("");
    });
    expect(v.documents).toEqual([]);
    // Creating a series reserves NO quota — the current usage is carried
    // over (the confirmed view carries the same value back).
    expect(v.usage).toEqual({ remaining: 9, daily_limit: 50 });
    // The confirmed view will resolve the default sender; pending has none.
    expect(v.senderEmail).toBeNull();
  });

  it("first series (no previous view): zero usage, empty owner", () => {
    const v = buildPendingView(null, 2, "ausbildung");
    expect(v.usage).toEqual({ remaining: 0, daily_limit: 0 });
    expect(v.campaign.user_id).toBe("");
    expect(v.applications).toHaveLength(2);
    expect(v.documents).toEqual([]);
  });

  it("placeholder ids are unique and stable for a given count", () => {
    const a = buildPendingView(previousView(), 3, "ausbildung");
    const b = buildPendingView(previousView(), 3, "ausbildung");
    const ids = a.applications.map((x) => x.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual([
      `${PENDING_APP_ID_PREFIX}1`,
      `${PENDING_APP_ID_PREFIX}2`,
      `${PENDING_APP_ID_PREFIX}3`,
    ]);
    // Rebuilding the pending view is id-stable (drafts survive re-renders).
    expect(b.applications.map((x) => x.id)).toEqual(ids);
    for (const id of ids) {
      expect(isPendingAppId(id)).toBe(true);
      expect(isPendingCampaignId(id)).toBe(false);
    }
  });
});

describe("pending id helpers", () => {
  it("isPendingCampaignId / isPendingAppId / pendingAppSeq", () => {
    expect(isPendingCampaignId(PENDING_CAMPAIGN_ID)).toBe(true);
    expect(isPendingCampaignId("camp-1")).toBe(false);
    expect(isPendingAppId(`${PENDING_APP_ID_PREFIX}7`)).toBe(true);
    expect(isPendingAppId("app-7")).toBe(false);
    expect(pendingAppSeq(`${PENDING_APP_ID_PREFIX}7`)).toBe(7);
    expect(pendingAppSeq("app-7")).toBeNull();
    expect(pendingAppSeq(`${PENDING_APP_ID_PREFIX}x`)).toBeNull();
    expect(pendingAppSeq(`${PENDING_APP_ID_PREFIX}0`)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * B. remapPendingDrafts — placeholder -> confirmed row ids (by seed seq)
 * ------------------------------------------------------------------ */

describe("remapPendingDrafts", () => {
  const rec = (name: string) => ({
    companyName: name,
    companyEmail: `${name.toLowerCase().replace(/[^a-z]/g, "")}@x.de`,
    contactName: "",
    companyAddress: "",
    positionTitle: "",
    positionBrief: "",
    employerFacts: "",
  });
  const confirmed = [
    { id: "app-1", seq: 1 },
    { id: "app-2", seq: 2 },
    { id: "app-3", seq: 3 },
  ];

  it("maps each placeholder draft to the confirmed row with the SAME seq", () => {
    const drafts: Drafts = {
      [`${PENDING_APP_ID_PREFIX}1`]: rec("A"),
      [`${PENDING_APP_ID_PREFIX}3`]: rec("C"),
    };
    const next = remapPendingDrafts(drafts, confirmed);
    expect(next["app-1"]).toEqual(rec("A"));
    expect(next["app-3"]).toEqual(rec("C"));
    // The placeholder keys are gone — nothing lingers under a dead id.
    expect(Object.keys(next).sort()).toEqual(["app-1", "app-3"]);
    // The input is not mutated.
    expect(drafts[`${PENDING_APP_ID_PREFIX}1`]).toEqual(rec("A"));
  });

  it("drops orphan placeholders (no seq match) and leaves other drafts intact", () => {
    const drafts: Drafts = {
      [`${PENDING_APP_ID_PREFIX}7`]: rec("Orphan"),
      "app-9": rec("OtherRow"),
    };
    const next = remapPendingDrafts(drafts, confirmed);
    expect(next["app-9"]).toEqual(rec("OtherRow"));
    expect(Object.keys(next)).toEqual(["app-9"]);
  });

  it("is a same-reference no-op when there are no placeholder drafts", () => {
    const drafts: Drafts = { "app-9": rec("X") };
    expect(remapPendingDrafts(drafts, confirmed)).toBe(drafts);
    const empty: Drafts = {};
    expect(remapPendingDrafts(empty, confirmed)).toBe(empty);
  });
});

/* ------------------------------------------------------------------ *
 * C. client.tsx wiring (static contract): NO series creation on this page
 * ------------------------------------------------------------------
 *
 * The "New series" action was removed from the Application Automation page
 * entirely (no header button, no three-dot/overflow menu, no setup form):
 * the page works on the CURRENT series only, and a load never creates or
 * switches series. The pending-series helpers (A/B) remain unit-tested as
 * the engine-level mechanism; the step keeps its defensive guards, which
 * the client now feeds with inert constants.
 */

describe("client wiring (static contract): series creation is gone from the page", () => {
  it("client.tsx imports no creation action and has no creation logic or menu", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(process.cwd(), "src/components/bewerbung-automation/client.tsx"),
      "utf8",
    );
    // No creation entry point in any form — the previous instant-open
    // orchestration (pending view + create+view action) is not referenced.
    expect(src).not.toContain("startNewSeries");
    expect(src).not.toContain("bewCreateCampaignView");
    // Word-boundary match, so `bewCreateCampaignView` does not count.
    expect(src).not.toMatch(/\bbewCreateCampaign\b/);
    expect(src).not.toContain("buildPendingView");
    expect(src).not.toContain("bew-series-menu");
    expect(src).not.toContain("seriesMenuAria");
    expect(src).not.toContain("newSeriesCreating");
    expect(src).not.toContain("setupStart");
    // The no-series state is a neutral notice (no controls).
    expect(src).toContain("noSeriesTitle");
    expect(src).toContain("noSeriesBody");
    // The step receives the inert guard constants + the row-patch callback.
    expect(src).toContain("creatingSeries={false}");
    expect(src).toContain("seriesConfirmation={null}");
    expect(src).toContain("patchApplication={patchApplication}");
  });
});
