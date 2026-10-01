import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Multi-campaign management (Phase 22 + 23).
 *
 * The engine keeps campaigns fully independent (each campaign row + its own
 * email_messages rows, every message query scoped by campaign_id AND
 * user_id). This file covers the whole management layer on top of an
 * in-memory store that mirrors the schema's FK behaviour:
 *
 *   - unlimited independent campaigns (fresh id per createCampaign),
 *   - one list row PER campaign (plus unsent drafts), no counter/recipient
 *     mixing between campaigns,
 *   - deleting ONE campaign: ownership scoping, the `sending` guard AND the
 *     in-flight message guard, capacity release, cascade (no orphaned
 *     messages), and "nothing else is touched" (accounts / tokens / credits),
 *   - creating a campaign after deleting another still works,
 *   - the UI wiring: search/filter/sort, confirmation modals (campaign AND
 *     draft), the ?new=1 / ?draft= composer resolution, the campaign page
 *     header.
 */

type Row = Record<string, unknown>;

const store: Record<string, Row[]> = {};
const deletedEqChain: Array<Record<string, unknown>> = [];
const deletedFrom: string[] = [];
let deleteError: { message: string } | null = null;
let insertCounter = 0;

const rpc = vi.fn();

vi.mock("@/lib/supabase/admin", () => {
  function makeChain(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    let countMode = false;
    let deleteMode = false;
    const all = () =>
      (store[table] ?? []).filter((row) => filters.every((f) => f(row)));
    const runDelete = () => {
      const matched = all();
      // A database failure deletes nothing (mirror the real behaviour).
      if (deleteError) return { data: null, error: deleteError };
      const list = store[table] ?? [];
      for (const row of matched) {
        const index = list.indexOf(row);
        if (index >= 0) list.splice(index, 1);
      }
      // Mirror the schema's FK behaviour (what Postgres guarantees):
      //  - email_messages.campaign_id:            ON DELETE CASCADE
      //  - application_draft_recipients/attach:   ON DELETE CASCADE
      //  - email_campaigns.draft_id:              ON DELETE RESTRICT
      if (table === "email_campaigns") {
        const ids = new Set(matched.map((row) => row.id));
        const messages = store["email_messages"] ?? [];
        for (let i = messages.length - 1; i >= 0; i -= 1)
          if (ids.has(messages[i].campaign_id)) messages.splice(i, 1);
      }
      if (table === "application_drafts") {
        const ids = new Set(matched.map((row) => row.id));
        if (
          (store["email_campaigns"] ?? []).some((row) => ids.has(row.draft_id))
        )
          return {
            data: null,
            error: {
              message:
                "foreign key constraint fails: email_campaigns_draft_id_fkey",
            },
          };
        for (const name of [
          "application_draft_recipients",
          "application_draft_attachments",
        ]) {
          const children = store[name] ?? [];
          for (let i = children.length - 1; i >= 0; i -= 1)
            if (ids.has(children[i].draft_id)) children.splice(i, 1);
        }
      }
      return { data: matched, error: deleteError };
    };
    const chain: Record<string | symbol, unknown> = new Proxy({}, {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        switch (prop) {
          case "eq":
            return (column: string, value: string | number) => {
              if (deleteMode) {
                deletedEqChain.push({ table, value });
                deletedFrom.push(table);
              }
              filters.push((row) => row[column] === value);
              return chain;
            };
          case "in":
            return (column: string, values: string[]) => {
              filters.push((row) => values.includes(String(row[column])));
              return chain;
            };
          case "lt":
            return (column: string, value: string) => {
              filters.push((row) => String(row[column] ?? "") < value);
              return chain;
            };
          case "order":
          case "limit":
            return () => chain;
          case "select":
            return (_columns: string, opts?: { count?: string; head?: boolean }) => {
              countMode = Boolean(opts?.count);
              return chain;
            };
          case "single":
            return async () => {
              const matched = all();
              return {
                data: matched[0] ?? null,
                error: matched[0] ? null : { message: "PGRST116: no rows" },
              };
            };
          case "maybeSingle":
            return async () => ({ data: all()[0] ?? null, error: null });
          case "insert":
            return (payload: Row | Row[]) => {
              const rowsToInsert = Array.isArray(payload) ? payload : [payload];
              const stamped = rowsToInsert.map((row) => {
                const withId: Row = row.id
                  ? row
                  : { ...row, id: `row-${++insertCounter}` };
                (store[table] ??= []).push(withId);
                return withId;
              });
              const result: Record<string | symbol, unknown> = {};
              result.select = () => ({
                single: async () => ({ data: stamped[0] ?? null, error: null }),
              });
              result.then = (onFulfilled?: unknown, onRejected?: unknown) =>
                Promise.resolve({ data: stamped, error: null }).then(
                  onFulfilled as never,
                  onRejected as never,
                );
              return result;
            };
          case "delete":
            return () => {
              deleteMode = true;
              return chain;
            };
          case "then":
            return (onFulfilled?: unknown, onRejected?: unknown) => {
              const result = deleteMode
                ? runDelete()
                : countMode
                  ? { data: null, count: all().length, error: null }
                  : { data: all(), error: null };
              return Promise.resolve(result).then(
                onFulfilled as never,
                onRejected as never,
              );
            };
          default:
            return undefined;
        }
      },
    });
    return chain;
  }
  return {
    createAdminClient: () => ({
      rpc: (...args: unknown[]) => rpc(...args),
      from: (table: string) => makeChain(table),
      storage: { from: () => ({ remove: async () => undefined }) },
    }),
  };
});

vi.mock("@/lib/auth", () => ({
  getCurrentUserAndProfile: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Ownership + recipient validation, driven by the same in-memory store so
// the create/delete flows behave like the real database does.
vi.mock("@/lib/application-drafts", () => ({
  assertDraftOwnership: async (userId: string, draftId: string) => {
    const draft = (store["application_drafts"] ?? []).find(
      (row) => row.id === draftId && row.user_id === userId,
    );
    if (!draft) throw new Error("Draft not found.");
    return draft;
  },
  assertSenderOwnership: async (userId: string, accountId: string) => {
    const account = (store["email_accounts"] ?? []).find(
      (row) =>
        row.id === accountId && row.user_id === userId && row.is_active,
    );
    if (!account) throw new Error("Connected sender account not found.");
    return account;
  },
  sanitizeEmailHtml: (html: string) => html,
  htmlToText: (html: string) => html,
  validateRecipientList: (
    recipients: Array<{ email: string; companyName?: string | null }>,
  ) => {
    const seen = new Set<string>();
    return recipients
      .filter((recipient) => recipient.email.trim())
      .map((recipient) => {
        const email = recipient.email.trim().toLowerCase();
        const status = !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
          ? "invalid"
          : seen.has(email)
            ? "duplicate"
            : "valid";
        if (status !== "invalid") seen.add(email);
        return {
          email,
          company_name: recipient.companyName?.trim() || null,
          validation_status: status,
        };
      });
  },
  createStoragePath: (userId: string, draftId: string, filename: string) =>
    `${userId}/${draftId}/${filename}`,
  ALLOWED_ATTACHMENT_TYPES: new Set(["application/pdf"]),
  MAX_ATTACHMENT_SIZE: 10 * 1024 * 1024,
}));

const {
  createCampaign,
  deleteCampaign,
  getCampaign,
  listUserCampaigns,
  CampaignDeleteBlockedError,
} = await import("@/lib/email-campaigns");
const { deleteCampaignAction } = await import("@/app/applications/actions");
const { getCurrentUserAndProfile } = await import("@/lib/auth");
const { revalidatePath } = await import("next/cache");

const USER = { id: "user-1", email: "u@example.test" };
const USAGE = {
  date: "2026-10-02",
  emails_sent: 0,
  emails_reserved: 0,
  daily_limit: 100,
  remaining: 100,
};

function seedCampaign(overrides: Row = {}): Row {
  const row: Row = {
    id: "campaign-A",
    user_id: USER.id,
    draft_id: "draft-A",
    email_account_id: "account-1",
    usage_date: "2026-10-01",
    status: "completed",
    total_recipients: 0,
    queued_count: 0,
    sending_count: 0,
    sent_count: 0,
    failed_count: 0,
    cancelled_count: 0,
    reserved_count: 0,
    created_at: "2026-10-01T10:00:00Z",
    started_at: null,
    completed_at: null,
    ...overrides,
  };
  (store["email_campaigns"] ??= []).push(row);
  return row;
}

function seedMessage(campaignId: string, index: number, overrides: Row = {}) {
  const row: Row = {
    id: `${campaignId}-m${index}`,
    campaign_id: campaignId,
    user_id: USER.id,
    recipient_email: `${campaignId.toLowerCase()}-${index}@example.de`,
    company_name: null,
    subject: "Bewerbung",
    status: "sent",
    attempt_count: 1,
    created_at: `2026-10-01T10:00:0${index % 10}Z`,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
  (store["email_messages"] ??= []).push(row);
  return row;
}

function seedDraft(overrides: Row = {}): Row {
  const row: Row = {
    id: "draft-A",
    user_id: USER.id,
    goal: "ausbildung",
    sender_email_account_id: "account-1",
    subject: "Bewerbung A",
    body_html: "<p>Text</p>",
    body_text: "Text",
    opportunity_key: null,
    opportunity_title: null,
    opportunity_company: null,
    opportunity_source_url: null,
    created_at: "2026-10-01T09:00:00Z",
    updated_at: "2026-10-01T09:00:00Z",
    ...overrides,
  };
  (store["application_drafts"] ??= []).push(row);
  return row;
}

function seedAccount(overrides: Row = {}) {
  const row: Row = {
    id: "account-1",
    user_id: USER.id,
    provider: "gmail",
    email_address: "sender1@example.com",
    is_active: true,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    last_used_at: null,
    ...overrides,
  };
  (store["email_accounts"] ??= []).push(row);
  return row;
}

function seedDraftRecipients(draftId: string, count: number, prefix: string) {
  for (let i = 0; i < count; i += 1)
    (store["application_draft_recipients"] ??= []).push({
      id: `${draftId}-r${i}`,
      draft_id: draftId,
      email: `${prefix}-${i}@example.de`,
      company_name: `Firma ${prefix} ${i}`,
      validation_status: "valid",
      created_at: `2026-10-01T09:00:0${i % 10}Z`,
    });
}

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  deletedEqChain.length = 0;
  deletedFrom.length = 0;
  deleteError = null;
  insertCounter = 0;
  rpc.mockReset();
  rpc.mockResolvedValue({ data: null, error: null });
  vi.mocked(revalidatePath).mockClear();
  vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
    user: USER,
    profile: { account_status: "active" },
  } as never);
});

describe("deleteCampaign (one campaign, nothing else)", () => {
  it.each([
    "draft",
    "queued",
    "completed",
    "partially_failed",
    "failed",
    "cancelled",
  ])("deletes a %s campaign", async (status) => {
    seedCampaign({ status });
    await deleteCampaign(USER.id, "campaign-A");
    // Scoped by BOTH the campaign id and the owner: a forged id cannot
    // delete someone else's campaign.
    expect(deletedEqChain).toEqual([
      { table: "email_campaigns", value: "campaign-A" },
      { table: "email_campaigns", value: USER.id },
    ]);
    expect(store["email_campaigns"]).toHaveLength(0);
  });

  it("refuses a campaign that is currently sending (never corrupts the queue)", async () => {
    seedCampaign({ status: "sending" });
    seedMessage("campaign-A", 0, { status: "sending" });
    const error = await deleteCampaign(USER.id, "campaign-A").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CampaignDeleteBlockedError);
    expect((error as Error).message).toBe(
      "This campaign is currently being sent. Please wait until sending finishes before deleting it.",
    );
    // Nothing was deleted and no capacity was released.
    expect(deletedFrom).toHaveLength(0);
    expect(store["email_campaigns"]).toHaveLength(1);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses when a message is already claimed, even if the row still reads queued", async () => {
    // The worker claimed a message (status `sending` on the message) but the
    // campaign's `sending` flip is not what we trust — the message state is.
    seedCampaign({ status: "queued", started_at: "2026-10-01T10:00:01Z" });
    seedMessage("campaign-A", 0, { status: "sending" });
    const error = await deleteCampaign(USER.id, "campaign-A").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CampaignDeleteBlockedError);
    expect(deletedFrom).toHaveLength(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("releases the capacity held by messages that will never be sent", async () => {
    seedCampaign({ status: "queued", queued_count: 7 });
    for (let i = 0; i < 7; i += 1)
      seedMessage("campaign-A", i, { status: "queued" });
    await deleteCampaign(USER.id, "campaign-A");
    expect(rpc).toHaveBeenCalledWith("release_email_capacity", {
      target_user_id: USER.id,
      reservation_date: "2026-10-01",
      released: 7,
    });
  });

  it("releases nothing when every message is already finalized", async () => {
    seedCampaign({ status: "failed", queued_count: 0 });
    await deleteCampaign(USER.id, "campaign-A");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("deletes the campaign's own messages atomically (no orphans)", async () => {
    seedCampaign();
    const campaignB = seedCampaign({
      id: "campaign-B",
      status: "sending",
      draft_id: "draft-B",
    });
    for (let i = 0; i < 2; i += 1) seedMessage("campaign-A", i);
    for (let i = 0; i < 3; i += 1) seedMessage(String(campaignB.id), i);
    await deleteCampaign(USER.id, "campaign-A");
    // A's messages are gone (schema cascade), B's are untouched.
    expect(store["email_messages"]).toHaveLength(3);
    expect(
      store["email_messages"].every((row) => row.campaign_id === "campaign-B"),
    ).toBe(true);
  });

  it("only ever touches the campaign table (+ its own capacity row)", async () => {
    seedCampaign({ status: "queued", queued_count: 2 });
    await deleteCampaign(USER.id, "campaign-A");
    // No email_accounts, no tokens, no credits, no other campaign.
    expect(new Set(deletedFrom)).toEqual(new Set(["email_campaigns"]));
    expect(
      rpc.mock.calls.every((call) => call[0] === "release_email_capacity"),
    ).toBe(true);
    const LIB = readFileSync("src/lib/email-campaigns.ts", "utf8");
    const fn = LIB.slice(
      LIB.indexOf("export async function deleteCampaign"),
      LIB.indexOf("export async function cancelCampaign"),
    );
    expect(fn).not.toContain("email_accounts");
    expect(fn).not.toContain("search-credits");
    expect(fn).not.toContain("email_token");
  });

  it("reports a missing / foreign campaign instead of deleting blindly", async () => {
    await expect(deleteCampaign(USER.id, "nope")).rejects.toThrow(
      "Campaign not found.",
    );
    expect(deletedFrom).toHaveLength(0);
  });

  it("surfaces a database failure honestly", async () => {
    seedCampaign();
    deleteError = { message: "boom" };
    await expect(deleteCampaign(USER.id, "campaign-A")).rejects.toThrow(
      "Unable to delete campaign.",
    );
    // The row survives — a failed delete is not a half-delete.
    expect(store["email_campaigns"]).toHaveLength(1);
  });
});

describe("deleteCampaignAction (server boundary)", () => {
  it("requires an authenticated, active account", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
      user: null,
      profile: null,
    } as never);
    const result = await deleteCampaignAction("campaign-A");
    expect(result.ok).toBe(false);
    expect(result.message).toBe("Not authorized.");
    expect(deletedFrom).toHaveLength(0);
  });

  it("returns the safety message when the campaign is sending", async () => {
    seedCampaign({ status: "sending" });
    const result = await deleteCampaignAction("campaign-A");
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ blocked: true });
    expect(result.message).toContain("currently being sent");
  });

  it("deletes and revalidates the applications list", async () => {
    seedCampaign();
    const result = await deleteCampaignAction("campaign-A");
    expect(result.ok).toBe(true);
    expect(deletedFrom).toContain("email_campaigns");
    expect(revalidatePath).toHaveBeenCalledWith("/applications");
  });
});

describe("unlimited independent campaigns (create)", () => {
  function seedSendableDraft(draftId: string, count: number, prefix: string) {
    seedDraft({
      id: draftId,
      subject: `Bewerbung ${draftId}`,
      updated_at: `2026-10-0${count}T09:00:00Z`,
    });
    seedDraftRecipients(draftId, count, prefix);
  }

  it("creates Campaign A (5 recipients) and Campaign B (10 recipients) with distinct ids", async () => {
    seedAccount();
    seedSendableDraft("draft-A", 5, "a");
    seedSendableDraft("draft-B", 10, "b");
    rpc.mockResolvedValue({ data: USAGE, error: null });

    const first = await createCampaign({
      draftId: "draft-A",
      senderAccountId: "account-1",
      goal: "ausbildung",
      recipientEmails: [],
    });
    const second = await createCampaign({
      draftId: "draft-B",
      senderAccountId: "account-1",
      goal: "arbeit",
      recipientEmails: [],
    });

    // Two campaigns, two ids — the second never reuses the first.
    expect(first.campaignId).not.toBe(second.campaignId);
    expect(store["email_campaigns"]).toHaveLength(2);
    const [campaignA, campaignB] = store["email_campaigns"];
    expect(campaignA.draft_id).toBe("draft-A");
    expect(campaignB.draft_id).toBe("draft-B");
    // …and the pre-existing draft (and its recipients) is untouched.
    expect(store["application_drafts"]).toHaveLength(2);
    expect(store["application_draft_recipients"]).toHaveLength(15);
  });

  it("keeps recipients and counters fully separated per campaign", async () => {
    seedAccount();
    seedSendableDraft("draft-A", 5, "a");
    seedSendableDraft("draft-B", 10, "b");
    rpc.mockResolvedValue({ data: USAGE, error: null });
    const first = await createCampaign({
      draftId: "draft-A",
      senderAccountId: "account-1",
      goal: "ausbildung",
      recipientEmails: [],
    });
    const second = await createCampaign({
      draftId: "draft-B",
      senderAccountId: "account-1",
      goal: "arbeit",
      recipientEmails: [],
    });

    // No Campaign A message inside Campaign B — and vice versa.
    const messagesA = store["email_messages"].filter(
      (row) => row.campaign_id === first.campaignId,
    );
    const messagesB = store["email_messages"].filter(
      (row) => row.campaign_id === second.campaignId,
    );
    expect(messagesA).toHaveLength(5);
    expect(messagesB).toHaveLength(10);
    expect(
      messagesA.every((row) =>
        String(row.recipient_email).startsWith("a-"),
      ),
    ).toBe(true);
    expect(
      messagesB.every((row) =>
        String(row.recipient_email).startsWith("b-"),
      ),
    ).toBe(true);
    expect(store["email_messages"]).toHaveLength(15);
  });

  it("creating a campaign after deleting another works normally", async () => {
    seedAccount();
    seedSendableDraft("draft-A", 5, "a");
    seedSendableDraft("draft-B", 10, "b");
    rpc.mockResolvedValue({ data: USAGE, error: null });
    const first = await createCampaign({
      draftId: "draft-A",
      senderAccountId: "account-1",
      goal: "ausbildung",
      recipientEmails: [],
    });
    await deleteCampaign(USER.id, first.campaignId);
    expect(store["email_campaigns"]).toHaveLength(0);
    expect(store["email_messages"]).toHaveLength(0);

    const again = await createCampaign({
      draftId: "draft-A",
      senderAccountId: "account-1",
      goal: "ausbildung",
      recipientEmails: [],
    });
    expect(again.campaignId).not.toBe(first.campaignId);
    expect(store["email_campaigns"]).toHaveLength(1);
    expect(store["email_messages"]).toHaveLength(5);
  });
});

describe("campaign detail stays isolated (getCampaign)", () => {
  it("opening Campaign A shows A's data only; opening B shows B's data only", async () => {
    seedAccount();
    seedDraft({ id: "draft-A" });
    seedDraft({ id: "draft-B", subject: "Bewerbung B" });
    seedCampaign({
      id: "campaign-A",
      status: "completed",
      total_recipients: 5,
      sent_count: 5,
    });
    seedCampaign({
      id: "campaign-B",
      draft_id: "draft-B",
      status: "sending",
      total_recipients: 10,
      sent_count: 4,
      failed_count: 2,
      queued_count: 4,
      sending_count: 0,
      started_at: "2026-10-01T10:00:01Z",
    });
    for (let i = 0; i < 5; i += 1) seedMessage("campaign-A", i);
    for (let i = 0; i < 10; i += 1)
      seedMessage("campaign-B", i, {
        status: i < 4 ? "sent" : i < 6 ? "failed" : "queued",
      });
    // A foreign user's row pointing at the same campaign must never leak in.
    seedMessage("campaign-A", 99, {
      id: "campaign-A-m99",
      user_id: "user-2",
    });

    const detailA = await getCampaign(USER.id, "campaign-A");
    expect(detailA.campaign.id).toBe("campaign-A");
    expect(detailA.messages).toHaveLength(5);
    expect(
      detailA.messages.every((message) =>
        message.recipient_email.startsWith("campaign-a-"),
      ),
    ).toBe(true);

    const detailB = await getCampaign(USER.id, "campaign-B");
    expect(detailB.campaign.id).toBe("campaign-B");
    expect(detailB.messages).toHaveLength(10);
    expect(
      detailB.messages.every((message) =>
        message.recipient_email.startsWith("campaign-b-"),
      ),
    ).toBe(true);
    // The detail derives from the campaign's own messages only
    // (4 sent / 2 failed / 4 still queued — none of A's 5).
    expect(
      detailB.messages.filter((message) => message.status === "sent").length,
    ).toBe(4);
    expect(
      detailB.messages.filter((message) => message.status === "failed").length,
    ).toBe(2);
    expect(
      detailB.messages.filter((message) => message.status === "queued").length,
    ).toBe(4);
  });

  it("deleting Campaign A does not delete Campaign B", async () => {
    seedDraft({ id: "draft-A" });
    seedDraft({ id: "draft-B", subject: "Bewerbung B" });
    seedCampaign({ id: "campaign-A" });
    const campaignB = seedCampaign({
      id: "campaign-B",
      draft_id: "draft-B",
      status: "completed",
    });
    for (let i = 0; i < 2; i += 1) seedMessage("campaign-A", i);
    for (let i = 0; i < 3; i += 1) seedMessage(String(campaignB.id), i);

    await deleteCampaign(USER.id, "campaign-A");

    expect(store["email_campaigns"]).toHaveLength(1);
    expect(store["email_campaigns"][0].id).toBe("campaign-B");
    expect(store["email_messages"]).toHaveLength(3);
    expect(
      store["email_messages"].every((row) => row.campaign_id === "campaign-B"),
    ).toBe(true);
    // B's draft and recipients survive — only A's data was removed.
    expect(store["application_drafts"].map((row) => row.id)).toEqual([
      "draft-A",
      "draft-B",
    ]);
  });
});

describe("listUserCampaigns (the Applications list)", () => {
  it("renders one row per campaign, plus each unsent draft", async () => {
    seedAccount();
    seedAccount({
      id: "account-2",
      email_address: "sender2@example.com",
    });
    seedDraft({ id: "draft-A" });
    seedDraft({
      id: "draft-C",
      subject: "",
      goal: "arbeit",
      sender_email_account_id: "account-2",
      opportunity_title: "Stelle C",
      created_at: "2026-10-03T07:00:00Z",
    });
    seedDraft({
      id: "draft-D",
      subject: "Bewerbung D",
      created_at: "2026-10-04T07:00:00Z",
    });
    seedDraftRecipients("draft-D", 2, "d");

    // draft-A was sent TWICE: two independent campaigns, one row each.
    seedCampaign({
      id: "campaign-A",
      status: "completed",
      total_recipients: 5,
      sent_count: 5,
    });
    seedCampaign({
      id: "campaign-B",
      status: "sending",
      total_recipients: 10,
      sent_count: 4,
      failed_count: 2,
      started_at: "2026-10-02T09:00:01Z",
      created_at: "2026-10-02T09:00:00Z",
    });
    seedCampaign({
      id: "campaign-C",
      draft_id: "draft-C",
      email_account_id: "account-2",
      status: "queued",
      total_recipients: 3,
      queued_count: 3,
      created_at: "2026-10-03T08:00:00Z",
    });

    const items = await listUserCampaigns(USER.id);

    expect(items.map((item) => item.id)).toEqual([
      "draft-D",
      "campaign-C",
      "campaign-B",
      "campaign-A",
    ]);

    const [rowD, rowC, rowB, rowA] = items;
    // Draft row: unsent, its own recipient count, Draft status.
    expect(rowD).toMatchObject({
      kind: "draft",
      campaign_id: null,
      draft_id: "draft-D",
      status: "draft",
      title: "Bewerbung D",
      total_recipients: 2,
      sent_count: null,
      failed_count: null,
      sender_email: "sender1@example.com",
    });
    // Campaign rows: per-campaign counters, even for the SAME draft.
    expect(rowA).toMatchObject({
      kind: "campaign",
      id: "campaign-A",
      campaign_id: "campaign-A",
      draft_id: "draft-A",
      status: "completed",
      title: "Bewerbung A",
      goal: "ausbildung",
      total_recipients: 5,
      sent_count: 5,
      failed_count: 0,
      sender_email: "sender1@example.com",
    });
    expect(rowB).toMatchObject({
      kind: "campaign",
      id: "campaign-B",
      status: "sending",
      total_recipients: 10,
      sent_count: 4,
      failed_count: 2,
    });
    // B's counters must not have absorbed A's (or vice versa).
    expect(rowB.sent_count).not.toBe(rowA.sent_count);
    // Title falls back to the opportunity title for empty subjects.
    expect(rowC.title).toBe("Stelle C");
    expect(rowC.goal).toBe("arbeit");
    expect(rowC.sender_email).toBe("sender2@example.com");
  });

  it("returns no draft row for a draft that already has campaigns", async () => {
    seedAccount();
    seedDraft({ id: "draft-A" });
    seedCampaign({ id: "campaign-A" });
    const items = await listUserCampaigns(USER.id);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("campaign");
  });

  it("is scoped to the user (foreign campaigns never appear)", async () => {
    seedAccount();
    seedDraft({ id: "draft-A" });
    seedCampaign({ id: "campaign-A" });
    seedCampaign({ id: "campaign-X", user_id: "user-2", draft_id: "draft-A" });
    const items = await listUserCampaigns(USER.id);
    expect(items.map((item) => item.id)).toEqual(["campaign-A"]);
  });
});

describe("Applications UI: many campaigns, safe delete, no mixing", () => {
  const PAGE = readFileSync("src/app/applications/page.tsx", "utf8");
  const TABLE = readFileSync(
    "src/components/applications-table.tsx",
    "utf8",
  );
  const NEW_PAGE = readFileSync(
    "src/app/applications/new/page.tsx",
    "utf8",
  );
  const CAMPAIGN_PAGE = readFileSync(
    "src/app/applications/campaign/[id]/page.tsx",
    "utf8",
  );

  it("lists every campaign of the user via the campaign-centric loader", () => {
    expect(PAGE).toContain("listUserCampaigns(user.id)");
    expect(PAGE).toContain("<ApplicationsTable items={items} locale={locale} />");
    // …and the table renders one row per list item.
    expect(TABLE).toContain("{rows.map((row) => (");
    // "New application" starts a fresh, independent draft.
    expect(PAGE).toContain("/applications/new?new=1");
  });

  it("the composer opens a specific draft (?draft=) or a fresh one (?new=1)", () => {
    expect(NEW_PAGE).toContain("loadOwnedDraft(data.userId, rawDraft)");
    expect(NEW_PAGE).toContain('params.new === "1"');
    expect(NEW_PAGE).toContain("createBlankDraft(");
    // A ?draft= that no longer exists must not break the composer.
    expect(NEW_PAGE).toContain("if (specific) activeDraft = specific;");
  });

  it("has search, status filter and sort", () => {
    expect(TABLE).toContain("Search campaigns");
    expect(TABLE).toContain("All statuses");
    expect(TABLE).toContain('newestFirst ? "Newest first" : "Oldest first"');
  });

  it("deletes a campaign only after an explicit confirmation dialog", () => {
    expect(TABLE).toContain("Delete campaign?");
    expect(TABLE).toContain("Are you sure you want to delete this campaign?");
    expect(TABLE).toContain("permanently remove this campaign");
    expect(TABLE).toMatch(/setPendingDelete\(null\)[\s\S]{0,400}Cancel/);
    expect(TABLE).toContain('{isDeleting ? "Deleting…" : "Delete campaign"}');
    // The destructive call lives in the modal's confirm handler only.
    const confirm = TABLE.slice(
      TABLE.indexOf("async function confirmDelete"),
      TABLE.indexOf("return (\n    <div>"),
    );
    expect(confirm).toContain("deleteCampaignAction(pendingDelete.campaign_id)");
    // The destructive call exists exactly once, inside that handler.
    expect(TABLE.split("deleteCampaignAction(").length - 1).toBe(1);
  });

  it("deletes a draft only after its own confirmation dialog", () => {
    expect(TABLE).toContain("Delete draft?");
    expect(TABLE).toContain("Are you sure you want to delete this draft?");
    expect(TABLE).toContain('{isDeleting ? "Deleting…" : "Delete draft"}');
    expect(TABLE).toContain("formData.set(\"draftId\", pendingDelete.draft_id)");
    // …and routes it through the existing, ownership-checked discardDraft.
    expect(TABLE.split("discardDraft(").length - 1).toBe(1);
    expect(TABLE).toContain("await discardDraft(formData)");
  });

  it("opens a draft row in the composer and a campaign row in its detail page", () => {
    expect(TABLE).toContain("/applications/campaign/");
    expect(TABLE).toContain("/applications/new?draft=");
  });

  it("keeps account management out of Applications (sender info only)", () => {
    for (const forbidden of [
      "Disconnect",
      "Reconnect",
      "Connect Gmail",
      "OAuth",
    ])
      expect(TABLE).not.toContain(forbidden);
    expect(TABLE).toContain("Sending from:");
  });

  it("the campaign page shows only its own sender, plus a way back", () => {
    expect(CAMPAIGN_PAGE).toContain('href="/applications"');
    expect(CAMPAIGN_PAGE).toContain("Sending from:");
    // The sender is resolved from THIS campaign's account only.
    expect(CAMPAIGN_PAGE).toContain("data.campaign.email_account_id");
  });

  it("shows the empty state with a New application call to action", () => {
    expect(PAGE).toContain("No applications yet.");
    expect(PAGE).toContain(
      "Create your first application campaign to get started.",
    );
    expect(PAGE).toContain("New application");
  });

  it("renders cards on mobile instead of a squeezed table", () => {
    expect(TABLE).toContain("hidden overflow-x-auto lg:block");
    expect(TABLE).toContain("divide-y divide-line lg:hidden");
  });

  it("does not touch the other systems", () => {
    for (const file of [
      "src/app/applications/actions.ts",
      "src/components/applications-table.tsx",
    ])
      expect(readFileSync(file, "utf8")).not.toMatch(
        /search-credits|tavily|gemini|outlook-oauth/i,
      );
  });
});

describe("schema guarantees (source of truth for the delete semantics)", () => {
  it("cascades message deletion and protects drafts in use", () => {
    const schema = readFileSync(
      "supabase/migrations/20260927030000_email_sending_engine.sql",
      "utf8",
    );
    expect(schema).toMatch(
      /campaign_id uuid not null references public\.email_campaigns\(id\) on delete cascade/,
    );
    expect(schema).toMatch(
      /draft_id uuid not null references public\.application_drafts\(id\) on delete restrict/,
    );
  });

  it("the account pointer on campaigns is nullable (SET NULL), never deleted", () => {
    const schema = readFileSync(
      "supabase/migrations/20261004000000_email_account_lifecycle.sql",
      "utf8",
    );
    expect(schema).toMatch(/on delete set null/);
  });

  it("every message query in the engine is scoped by campaign AND user", () => {
    const LIB = readFileSync("src/lib/email-campaigns.ts", "utf8");
    const detail = LIB.slice(LIB.indexOf("export async function getCampaign"));
    expect(detail).toContain('.eq("campaign_id", campaignId)');
    expect(detail).toContain('.eq("user_id", userId)');
  });

  it("creating a campaign always inserts a fresh campaign row", () => {
    const LIB = readFileSync("src/lib/email-campaigns.ts", "utf8");
    const create = LIB.slice(LIB.indexOf("export async function createCampaign"));
    expect(create).toContain('.from("email_campaigns")');
    expect(create).toContain(".insert(");
    // The new id is returned to the caller (never reused from a previous run).
    expect(create).toContain("campaignId");
  });
});
