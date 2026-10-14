import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Praktikum — server-action goal validation (executed, not contract).
 *
 * The campaign engine is spied so these tests prove the GOAL PIPELINE:
 * every supported application type reaches createCampaign unchanged, and
 * anything else is rejected BEFORE any campaign work happens.
 */

const createCampaign = vi.fn(async (input: {
  goal: string;
  scheduling?: { utcIso: string; timeZone: string; usageDate: string };
}) => ({
  campaignId: "campaign-1",
  goal: input.goal,
}));
const processCampaignBatch = vi.fn(async () => ({
  processed: 0,
  status: "queued",
}));
const redirect = vi.fn(() => undefined);

vi.mock("@/lib/email-campaigns", () => ({
  createCampaign,
  processCampaignBatch,
}));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/auth", () => ({
  getCurrentUserAndProfile: async () => ({
    user: { id: "user-1", email: "u@example.test" },
    profile: { id: "user-1", account_status: "active" },
  }),
}));

const { sendApplications } = await import(
  "@/app/applications/new/send-action"
);
const { scheduleApplications } = await import(
  "@/app/applications/new/schedule-action"
);

function sendForm(goal: string): FormData {
  const formData = new FormData();
  formData.set("draftId", "draft-1");
  formData.set("senderAccountId", "account-1");
  formData.set("goal", goal);
  formData.set(
    "recipients",
    JSON.stringify([{ email: "bewerbung@carrier.de", status: "valid" }]),
  );
  return formData;
}

/** A wall clock that is guaranteed to be in the future, in UTC (no DST). */
function futureUtcForm(goal: string): FormData {
  const target = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  const formData = new FormData();
  formData.set("draftId", "draft-1");
  formData.set("senderAccountId", "account-1");
  formData.set("goal", goal);
  formData.set(
    "recipients",
    JSON.stringify([{ email: "bewerbung@carrier.de", status: "valid" }]),
  );
  formData.set("scheduleYear", String(target.getUTCFullYear()));
  formData.set("scheduleMonth", String(target.getUTCMonth() + 1));
  formData.set("scheduleDay", String(target.getUTCDate()));
  formData.set("scheduleHour", String(target.getUTCHours()));
  formData.set("scheduleMinute", String(target.getUTCMinutes()));
  formData.set("scheduleTimezone", "UTC");
  formData.set("dstResolution", "");
  return formData;
}

beforeEach(() => {
  createCampaign.mockClear();
  processCampaignBatch.mockClear();
  redirect.mockClear();
});

describe("sendApplications goal validation", () => {
  it.each(["ausbildung", "arbeit", "praktikum"])(
    "accepts goal=%s and hands it to the campaign engine",
    async (goal) => {
      await sendApplications(sendForm(goal));
      expect(createCampaign).toHaveBeenCalledTimes(1);
      expect(createCampaign.mock.calls[0][0].goal).toBe(goal);
      expect(redirect).toHaveBeenCalledWith("/applications/campaign/campaign-1");
    },
  );

  it("rejects an unknown goal before any campaign work", async () => {
    await expect(sendApplications(sendForm("xyz"))).rejects.toThrow(
      "Invalid application goal.",
    );
    expect(createCampaign).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe("scheduleApplications goal validation", () => {
  it.each(["ausbildung", "arbeit", "praktikum"])(
    "accepts goal=%s with a future schedule and passes it through",
    async (goal) => {
      await scheduleApplications(futureUtcForm(goal));
      expect(createCampaign).toHaveBeenCalledTimes(1);
      const input = createCampaign.mock.calls[0][0];
      expect(input.goal).toBe(goal);
      // Scheduling metadata stays intact (existing behaviour).
      expect(input.scheduling?.timeZone).toBe("UTC");
      expect(typeof input.scheduling?.utcIso).toBe("string");
      expect(redirect).toHaveBeenCalledWith(
        "/applications/campaign/campaign-1?scheduled=1",
      );
    },
  );

  it("rejects an unknown goal before any campaign work", async () => {
    await expect(scheduleApplications(futureUtcForm("praktikums"))).rejects.toThrow(
      "Invalid application goal.",
    );
    expect(createCampaign).not.toHaveBeenCalled();
  });
});
