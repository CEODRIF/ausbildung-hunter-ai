import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Email sending trigger (Phase 20) — the reason nothing was being sent.
 *
 * Root cause proved by the trace: `sendApplications` created the campaign and
 * its queued `email_messages` rows and then redirected. The only consumers of
 * that queue were (a) the manual "Process next batch" button and (b) the
 * internal worker endpoints, which need `x-email-worker-secret` and are called
 * by nothing in the repo (no cron, no scheduler) — so messages stayed
 * `queued` forever.
 *
 * These tests cover the fix at the exact seam:
 *  1. the send action drains a bounded, idempotent first batch,
 *  2. a drain failure never blocks the redirect (the campaign still exists),
 *  3. the campaign monitor triggers the same bounded drain,
 *  4. opening a campaign runs the deterministic stale recovery,
 *  5. the Applications page renders real counters only (and no account tools).
 */

const createCampaign = vi.fn();
const processCampaignBatch = vi.fn();
const getCurrentUserAndProfile = vi.fn();
const redirect = vi.fn((url: string) => {
  throw Object.assign(new Error("NEXT_REDIRECT"), {
    digest: `NEXT_REDIRECT;replace;${url};307;`,
  });
});

vi.mock("@/lib/email-campaigns", () => ({
  createCampaign,
  processCampaignBatch,
  cancelCampaign: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ getCurrentUserAndProfile }));
vi.mock("next/navigation", () => ({ redirect }));

const { sendApplications } = await import(
  "@/app/applications/new/send-action"
);

const USER = { id: "user-1", email: "u@example.test" };

function formData(overrides: Record<string, string> = {}) {
  const data = new FormData();
  data.set("draftId", "draft-1");
  data.set("senderAccountId", "account-1");
  data.set("goal", "ausbildung");
  data.set(
    "recipients",
    JSON.stringify([{ email: "firma@example.de", companyName: "Firma GmbH" }]),
  );
  for (const [key, value] of Object.entries(overrides)) data.set(key, value);
  return data;
}

beforeEach(() => {
  createCampaign.mockReset();
  processCampaignBatch.mockReset();
  getCurrentUserAndProfile.mockReset();
  redirect.mockClear();
  getCurrentUserAndProfile.mockResolvedValue({
    user: USER,
    profile: { account_status: "active" },
  });
  createCampaign.mockResolvedValue({ campaignId: "campaign-9" });
  processCampaignBatch.mockResolvedValue({ processed: 5, status: "completed" });
});

describe("send action drains the queue it just created", () => {
  it("kicks a bounded batch right after createCampaign, before redirecting", async () => {
    await expect(sendApplications(formData())).rejects.toThrow("NEXT_REDIRECT");

    expect(createCampaign).toHaveBeenCalledTimes(1);
    expect(createCampaign.mock.calls[0][0]).toMatchObject({
      draftId: "draft-1",
      senderAccountId: "account-1",
      goal: "ausbildung",
      recipientEmails: [{ email: "firma@example.de", companyName: "Firma GmbH" }],
    });
    // THE fix: the queue is consumed in the same request…
    expect(processCampaignBatch).toHaveBeenCalledWith("user-1", "campaign-9", 5);
    // …and the batch runner is bounded (never an unbounded loop).
    const batchSize = processCampaignBatch.mock.calls[0][2] as number;
    expect(batchSize).toBeGreaterThan(0);
    expect(batchSize).toBeLessThanOrEqual(5);
    // The user lands on the campaign page either way.
    expect(redirect).toHaveBeenCalledWith("/applications/campaign/campaign-9");
    // Order matters: drain first, redirect last.
    expect(processCampaignBatch.mock.invocationCallOrder[0]).toBeLessThan(
      redirect.mock.invocationCallOrder[0],
    );
  });

  it("a failing drain never blocks the redirect (campaign already exists)", async () => {
    processCampaignBatch.mockRejectedValue(new Error("Gmail exploded"));
    await expect(sendApplications(formData())).rejects.toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith("/applications/campaign/campaign-9");
  });

  it("rejects a malformed recipient payload before creating anything", async () => {
    await expect(
      sendApplications(formData({ recipients: "{not json" })),
    ).rejects.toThrow("Invalid recipient list.");
    expect(createCampaign).not.toHaveBeenCalled();
    expect(processCampaignBatch).not.toHaveBeenCalled();
  });

  it("requires a session", async () => {
    getCurrentUserAndProfile.mockResolvedValue({ user: null, profile: null });
    await expect(sendApplications(formData())).rejects.toThrow("NEXT_REDIRECT");
    expect(createCampaign).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith("/login");
  });
});

describe("campaign monitor keeps draining (real numbers, no fake progress)", () => {
  const ACTIONS = readFileSync(
    "src/app/applications/campaign/[id]/actions.ts",
    "utf8",
  );
  const MONITOR = readFileSync(
    "src/app/applications/campaign/[id]/campaign-monitor.tsx",
    "utf8",
  );

  it("exposes a bounded drain action using the same engine", () => {
    expect(ACTIONS).toContain("export async function drainCampaign(");
    expect(ACTIONS).toContain("processCampaignBatch(user.id, campaignId, 5)");
    // No second sending implementation.
    expect(ACTIONS).not.toContain("createEmailProvider");
    expect(ACTIONS).not.toContain("gmail");
  });

  it("the monitor calls the drain on every tick and reloads real state", () => {
    expect(MONITOR).toContain("drainCampaign(campaignId)");
    expect(MONITOR).toContain("setInterval(tick, 10000)");
    expect(MONITOR).toContain("window.location.reload()");
    expect(MONITOR).toContain("Sending the next batch…");
    // No invented progress values anywhere.
    expect(MONITOR).not.toMatch(/progress|percent|%/);
  });
});

describe("opening a campaign runs deterministic recovery", () => {
  const PAGE = readFileSync(
    "src/app/applications/campaign/[id]/page.tsx",
    "utf8",
  );

  it("calls recoverStaleCampaigns and renders the recovered status", () => {
    expect(PAGE).toContain("recoverStaleCampaigns(user.id, id)");
    expect(PAGE).toContain("recovery.status");
    // Terminal detection must use the recovered status, not the stale one.
    expect(PAGE).toContain('].includes(campaignState.status)');
    // The loading-state fix from the composer is untouched.
  });

  it("keeps the send-applications loading state intact", () => {
    const composer = readFileSync(
      "src/components/application-composer.tsx",
      "utf8",
    );
    expect(composer).toContain("Sending applications… Please keep this page open.");
    expect(composer).toContain('{isSending ? "Sending…" : "Continue"}');
  });
});

describe("Applications page: real data, no account management", () => {
  const PAGE = readFileSync("src/app/applications/page.tsx", "utf8");
  const LOADER = readFileSync("src/lib/dashboard.ts", "utf8");

  it("maps the engine's live counters (no invented numbers)", () => {
    for (const column of [
      "total_recipients",
      "queued_count",
      "sending_count",
      "sent_count",
      "failed_count",
      "cancelled_count",
    ])
      expect(LOADER).toContain(column);
    expect(PAGE).toContain("item.total_recipients");
    expect(PAGE).toContain("item.sent_count");
    expect(PAGE).toContain("item.failed_count");
    expect(PAGE).toContain("item.sender_email");
  });

  it("derives the overview stats from real campaign statuses", () => {
    expect(PAGE).toContain('item.campaign_status === "queued"');
    expect(PAGE).toContain('item.campaign_status === "sending"');
    expect(PAGE).toContain('item.campaign_status === "completed"');
    expect(PAGE).toContain('item.campaign_status === "partially_failed"');
    expect(PAGE).toContain("!item.campaign_id");
    expect(PAGE).toContain("Cancelled");
  });

  it("keeps account management out of Applications", () => {
    for (const forbidden of [
      "Disconnect",
      "Reconnect",
      "Connect Gmail",
      "Connect Outlook",
      "ACTIVE CAMPAIGN",
      "Connected accounts",
    ])
      expect(PAGE).not.toContain(forbidden);
    // …while the sender is still visible per application.
    expect(PAGE).toContain("Sender:");
  });

  it("renders a table on desktop and cards on mobile", () => {
    expect(PAGE).toContain("hidden overflow-x-auto lg:block");
    expect(PAGE).toContain("lg:hidden");
    for (const column of [
      "Application",
      "Type",
      "Sender",
      "Recipients",
      "Status",
      "Sent",
      "Failed",
      "Created",
      "Actions",
    ])
      expect(PAGE).toContain(`>${column}<`);
  });
});
