import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Opportunity } from "@/lib/opportunities/types";

/**
 * Draft-free application workflow (Drafts feature removal).
 *
 * Runs the REAL createCampaign / processCampaignBatch / listUserCampaigns
 * and the real staging-attachment + opportunity-prefill actions against an
 * in-memory store that simulates the POST-migration schema (migration
 * 20261110000000_campaign_owned_content.sql). The `H.migrated` flag can
 * simulate the PRE-migration database (the code-first deploy window), where
 * every legacy draft-based path must keep working untouched.
 *
 * Pins:
 *   - the campaign OWNS subject/body/goal, draft_id is NULL, and the normal
 *     workflow never creates (or even queries) an application_drafts row,
 *   - the worker renders from the campaign row (no draft read) with
 *     per-recipient personalization intact,
 *   - listUserCampaigns is campaigns-only (no draft-only rows; title/goal
 *     from the owned columns),
 *   - staged attachments live under the user's staging/ prefix with ZERO
 *     database rows; discard is prefix-scoped,
 *   - opportunity prefill resolves with ZERO database writes,
 *   - pre-migration fallback: probe false → the worker still renders from
 *     the draft (the legacy path stays alive),
 *   - probe behaviour: missing columns/table → false, clean reads → true,
 *     cached per process, reset hook re-evaluates.
 */

type Row = Record<string, unknown>;

const USER = { id: "user-1", email: "u@example.test" };
const USAGE = {
  date: "2026-10-02",
  emails_sent: 0,
  emails_reserved: 0,
  daily_limit: 100,
  remaining: 100,
};

const H = vi.hoisted(() => ({
  store: {} as Record<string, Row[]>,
  /** Post-migration schema by default (the world this feature targets). */
  migrated: true,
  rpcLog: [] as Array<{ name: string; args: Record<string, unknown> }>,
  fromCalls: [] as string[],
  sendEmails: [] as Row[],
  providerAttachments: [] as Row[][],
  uploadCalls: [] as Array<{ path: string; file: File }>,
  removedPaths: [] as string[],
  sendError: null as null | { code: string; message: string; temporary: boolean },
  insertFailTable: null as string | null,
}));

vi.mock("@/lib/supabase/admin", () => {
  let insertSeq = 0;
  function makeChain(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    let countMode = false;
    let deleteMode = false;
    let selectColumns = "";
    const all = () =>
      (H.store[table] ?? []).filter((row) => filters.every((f) => f(row)));
    // Pre-migration simulation: the owned content columns and the
    // attachments table only exist after 20261110000000 — querying them
    // fails exactly like PostgREST would, so the cached probe resolves to
    // the legacy (draft-based) world.
    const schemaError = (): { message: string } | null => {
      if (H.migrated) return null;
      if (table === "email_campaign_attachments")
        return {
          message:
            'relation "public.email_campaign_attachments" does not exist',
        };
      if (
        table === "email_campaigns" &&
        /subject|body_html|goal/.test(selectColumns)
      )
        return { message: 'column "subject" does not exist' };
      return null;
    };
    const runDelete = () => {
      const matched = all();
      const list = H.store[table] ?? [];
      for (let i = list.length - 1; i >= 0; i -= 1)
        if (matched.includes(list[i])) list.splice(i, 1);
      return { data: matched, error: null };
    };
    const chain: Record<string | symbol, unknown> = new Proxy({}, {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        switch (prop) {
          case "select":
            return (
              columns: string,
              opts?: { count?: string; head?: boolean },
            ) => {
              selectColumns = String(columns ?? "");
              countMode = Boolean(opts?.count);
              return chain;
            };
          case "eq":
            return (column: string, value: unknown) => {
              filters.push((row) => row[column] === value);
              return chain;
            };
          case "in":
            return (column: string, values: unknown[]) => {
              filters.push((row) => values.includes(row[column]));
              return chain;
            };
          case "lt":
            return (column: string, value: unknown) => {
              filters.push((row) => String(row[column] ?? "") < String(value));
              return chain;
            };
          case "order":
          case "limit":
            return () => chain;
          case "single":
            return async () => {
              const err = schemaError();
              if (err) return { data: null, error: err };
              const matched = all();
              return matched[0]
                ? { data: matched[0], error: null }
                : { data: null, error: { message: "PGRST116: no rows" } };
            };
          case "maybeSingle":
            return async () => {
              const err = schemaError();
              if (err) return { data: null, error: err };
              return { data: all()[0] ?? null, error: null };
            };
          case "insert":
            return (payload: Row | Row[]) => {
              const fail = H.insertFailTable === table;
              const rows = (
                Array.isArray(payload) ? payload : [payload]
              )
                .filter(() => !fail)
                .map((row) =>
                  row.id ? row : { ...row, id: `gen-${table}-${++insertSeq}` },
                );
              if (!fail) (H.store[table] ??= []).push(...rows);
              const result: Record<string | symbol, unknown> = {
                select: () => ({
                  single: async () =>
                    fail
                      ? { data: null, error: { message: "insert failed" } }
                      : { data: rows[0] ?? null, error: null },
                }),
              };
              result.then = (onFulfilled?: unknown, onRejected?: unknown) =>
                Promise.resolve(
                  fail
                    ? { data: null, error: { message: "insert failed" } }
                    : { data: rows, error: null },
                ).then(onFulfilled as never, onRejected as never);
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
                  : (() => {
                      const err = schemaError();
                      return err
                        ? { data: null, error: err }
                        : { data: all(), error: null };
                    })();
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
  const rpcImpl = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: null }> => {
    H.rpcLog.push({ name, args });
    switch (name) {
      case "reserve_sender_slot":
        return { data: { reserved: true, wait_ms: 0 }, error: null };
      case "get_sender_slot_wait_ms":
        return { data: 0, error: null };
      case "claim_next_email_message": {
        const campaign = (H.store["email_campaigns"] ?? []).find(
          (c) =>
            c.id === args.target_campaign_id && c.user_id === args.target_user_id,
        );
        if (
          !campaign ||
          !["queued", "sending"].includes(String(campaign.status))
        )
          return { data: null, error: null };
        const now = new Date();
        const message = (H.store["email_messages"] ?? []).find(
          (m) =>
            m.campaign_id === campaign.id &&
            m.user_id === args.target_user_id &&
            m.status === "queued" &&
            (m.next_attempt_at == null ||
              new Date(String(m.next_attempt_at)) <= now),
        );
        if (!message) return { data: null, error: null };
        message.status = "sending";
        message.attempt_count = Number(message.attempt_count ?? 0) + 1;
        campaign.status = "sending";
        return { data: message, error: null };
      }
      case "finalize_email_message": {
        const m = (H.store["email_messages"] ?? []).find(
          (x) => x.id === args.target_message_id,
        );
        if (!m || m.status !== "sending")
          return { data: false, error: null };
        if (args.succeeded) {
          m.status = "sent";
          m.provider_message_id = args.provider_id;
          m.sent_at = new Date().toISOString();
          m.error_code = null;
          m.error_message = null;
        } else {
          m.status = "failed";
          m.error_code = args.failure_code;
          m.error_message = args.failure_message;
        }
        const c = (H.store["email_campaigns"] ?? []).find(
          (x) => x.id === m.campaign_id,
        );
        if (c) {
          c.sending_count = 0;
          if (args.succeeded) c.sent_count = Number(c.sent_count ?? 0) + 1;
          else c.failed_count = Number(c.failed_count ?? 0) + 1;
          const remaining = (H.store["email_messages"] ?? []).filter(
            (x) =>
              x.campaign_id === m.campaign_id &&
              ["queued", "sending"].includes(String(x.status)),
          ).length;
          if (remaining === 0 && String(c.status) !== "cancelled") {
            c.status =
              Number(c.failed_count ?? 0) === 0
                ? "completed"
                : Number(c.sent_count ?? 0) === 0
                  ? "failed"
                  : "partially_failed";
            c.completed_at = new Date().toISOString();
          }
        }
        return { data: true, error: null };
      }
      case "retry_email_message": {
        const m = (H.store["email_messages"] ?? []).find(
          (x) => x.id === args.target_message_id,
        );
        if (!m || m.status !== "sending")
          return { data: false, error: null };
        m.status = "queued";
        // The real RPC backs off 60 s — a re-queued message is NOT
        // claimable again in the same batch.
        m.next_attempt_at = new Date(Date.now() + 60_000).toISOString();
        m.error_code = args.retry_code;
        m.error_message = args.retry_message;
        return { data: true, error: null };
      }
      case "reserve_email_capacity":
      case "reserve_email_capacity_on":
      case "get_daily_usage_snapshot":
        return { data: USAGE, error: null };
      default:
        return { data: null, error: null };
    }
  };
  return {
    createAdminClient: () => ({
      from: (table: string) => {
        H.fromCalls.push(table);
        return makeChain(table);
      },
      rpc: (name: string, args?: Record<string, unknown>) =>
        rpcImpl(name, args ?? {}),
      storage: {
        from: () => ({
          upload: async (path: string, file: File) => {
            H.uploadCalls.push({ path, file });
            return { error: null };
          },
          remove: async (paths: string[]) => {
            H.removedPaths.push(...paths);
          },
        }),
      },
    }),
  };
});

vi.mock("@/lib/email-providers", () => ({
  createEmailProvider: async (
    _userId: string,
    _accountId: string,
    attachments: Row[] = [],
  ) => {
    H.providerAttachments.push(attachments.map((a) => ({ ...a })));
    return {
      sendEmail: (input: Row) => {
        H.sendEmails.push({ ...input });
        if (H.sendError) {
          const error = new Error(H.sendError.message) as Error & {
            code?: string;
            temporary?: boolean;
          };
          error.code = H.sendError.code;
          error.temporary = H.sendError.temporary;
          return Promise.reject(error);
        }
        return Promise.resolve({
          providerMessageId: `pm-${H.sendEmails.length}`,
        });
      },
    };
  },
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUserAndProfile: async () => ({
    user: USER,
    profile: { id: USER.id, account_status: "active" },
  }),
}));

// Keep the REAL sanitizer / htmlToText / validateRecipientList / staging
// path helpers (the feature relies on them); only the ownership guards are
// stubbed.
vi.mock("@/lib/application-drafts", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/application-drafts")
  >();
  return {
    ...actual,
    assertDraftOwnership: async (_userId: string, draftId: string) => ({
      id: draftId,
      user_id: USER.id,
    }),
    assertSenderOwnership: async () => ({}),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/opportunities/search", () => ({
  resolveOpportunityCached: vi.fn(),
  searchOpportunities: vi.fn(),
}));

const { createCampaign, processCampaignBatch, listUserCampaigns } =
  await import("@/lib/email-campaigns");
const {
  hasCampaignOwnedContent,
  resetCampaignOwnedContentProbe,
  resetContactNameProbe,
} = await import("@/lib/contact-name-support");
const { resolveOpportunityPrefill } = await import("@/lib/opportunity-prefill");
const { resolveOpportunityCached } = await import("@/lib/opportunities/search");
const { stageAttachment, discardStagedAttachment } = await import(
  "@/app/applications/new/actions"
);

function resetWorld() {
  H.store = {};
  H.migrated = true;
  H.rpcLog = [];
  H.fromCalls = [];
  H.sendEmails = [];
  H.providerAttachments = [];
  H.uploadCalls = [];
  H.removedPaths = [];
  H.sendError = null;
  H.insertFailTable = null;
  vi.mocked(resolveOpportunityCached).mockReset();
  resetCampaignOwnedContentProbe();
  resetContactNameProbe();
}

beforeEach(resetWorld);

// ---------------------------------------------------------------------------
// 1. The migration probe
// ---------------------------------------------------------------------------

describe("hasCampaignOwnedContent (migration probe)", () => {
  it("resolves false on a pre-migration database (missing columns / table)", async () => {
    H.migrated = false;
    expect(await hasCampaignOwnedContent()).toBe(false);
  });

  it("resolves true only after a clean read of BOTH objects", async () => {
    H.migrated = true;
    expect(await hasCampaignOwnedContent()).toBe(true);
  });

  it("caches per process; the reset hook re-evaluates a changed schema", async () => {
    H.migrated = true;
    expect(await hasCampaignOwnedContent()).toBe(true);
    H.migrated = false;
    expect(await hasCampaignOwnedContent()).toBe(true); // cached result
    resetCampaignOwnedContentProbe();
    expect(await hasCampaignOwnedContent()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. createCampaign — the owned (draft-free) path
// ---------------------------------------------------------------------------

describe("createCampaign (owned path, post-migration)", () => {
  const validInput = {
    senderAccountId: "account-1",
    goal: "ausbildung" as const,
    subject: "Bewerbung bei {{company_name}}",
    bodyHtml:
      "<p>{{greeting}}</p><p>Ich möchte gerne bei {{company_name}} arbeiten.</p>",
    recipients: [
      { email: "bewerbung@carrier.de", companyName: null },
      { email: "info@bosch.de", companyName: null, contactName: "Herr Mustermann" },
      { email: "not-an-email" },
    ],
    attachments: [
      {
        storage_path: "user-1/staging/abc-cv.pdf",
        filename: "cv.pdf",
        mime_type: "application/pdf",
        size_bytes: 1024,
      },
      // Hostile metadata is dropped field-by-field, never an error:
      {
        storage_path: "../escape.pdf",
        filename: "x.pdf",
        mime_type: "application/pdf",
        size_bytes: 1,
      },
    ],
  };

  it("stores content on the campaign (draft_id NULL) and creates NO draft row", async () => {
    const result = await createCampaign(validInput);

    // No application_drafts row exists — and the flow never QUERIED the
    // draft content/attachment tables (the draft is not the content source
    // anymore; the only draft-table read left is the contact_name
    // CAPABILITY probe, which reads no content).
    expect(H.store["application_drafts"]).toBeUndefined();
    expect(H.fromCalls).not.toContain("application_drafts");
    expect(H.fromCalls).not.toContain("application_draft_attachments");

    const campaign = H.store["email_campaigns"][0];
    expect(campaign.id).toBe(result.campaignId);
    expect(campaign.draft_id).toBeNull();
    expect(campaign.subject).toBe("Bewerbung bei {{company_name}}");
    expect(String(campaign.body_html)).toContain("{{company_name}}");
    expect(campaign.goal).toBe("ausbildung");
    expect(campaign.status).toBe("queued");
    expect(campaign.total_recipients).toBe(2); // invalid recipient dropped

    const messages = H.store["email_messages"];
    expect(messages).toHaveLength(2);
    expect(
      messages.map((m) => m.recipient_email).sort(),
    ).toEqual(["bewerbung@carrier.de", "info@bosch.de"]);
    const bosch = messages.find((m) => m.recipient_email === "info@bosch.de");
    const carrier = messages.find(
      (m) => m.recipient_email === "bewerbung@carrier.de",
    );
    // Each message carries the subject template + its OWN personalization
    // data (the worker's only data source).
    expect(messages.every((m) => m.subject === "Bewerbung bei {{company_name}}")).toBe(true);
    expect(bosch?.contact_name).toBe("Herr Mustermann");
    expect(carrier?.contact_name).toBeNull();

    // Only the well-formed attachment is persisted — the campaign OWNS it
    // (this is what keeps the storage object referenced for the janitor).
    const attachments = H.store["email_campaign_attachments"];
    expect(attachments).toHaveLength(1);
    expect(attachments[0].campaign_id).toBe(result.campaignId);
    expect(attachments[0].storage_path).toBe("user-1/staging/abc-cv.pdf");
    expect(attachments[0].filename).toBe("cv.pdf");
  });

  it("refuses to create a campaign without a subject, body or valid recipient", async () => {
    await expect(
      createCampaign({
        senderAccountId: "account-1",
        goal: "ausbildung",
        subject: "",
        bodyHtml: "",
        recipients: [{ email: "not-an-email" }],
      }),
    ).rejects.toThrow(
      "Add a subject, message, and at least one valid recipient before sending.",
    );
    expect(H.store["email_campaigns"]).toBeUndefined();
    expect(H.store["email_messages"]).toBeUndefined();
    // The guard runs BEFORE the capacity reservation.
    expect(H.rpcLog).not.toContainEqual(
      expect.objectContaining({ name: "reserve_email_capacity" }),
    );
  });

  it("releases capacity and removes the campaign when message insertion fails", async () => {
    H.insertFailTable = "email_messages";
    await expect(
      createCampaign({
        senderAccountId: "account-1",
        goal: "ausbildung",
        subject: "Bewerbung",
        bodyHtml: "<p>{{greeting}}</p>",
        recipients: [{ email: "jobs@test-ag.de" }],
      }),
    ).rejects.toThrow("Unable to queue campaign messages.");
    // Nothing half-created survives: the campaign row was rolled back and
    // the reserved capacity was returned to the user's quota.
    expect(H.store["email_campaigns"]).toHaveLength(0);
    expect(H.store["email_messages"]).toBeUndefined();
    expect(H.rpcLog).toContainEqual({
      name: "release_email_capacity",
      args: {
        target_user_id: USER.id,
        reservation_date: "2026-10-02",
        released: 1,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// 3. processCampaignBatch — rendering from the campaign (no draft)
// ---------------------------------------------------------------------------

function seedOwnedCampaign(overrides: Row = {}) {
  const row: Row = {
    id: "campaign-1",
    user_id: USER.id,
    draft_id: null,
    email_account_id: "account-1",
    usage_date: "2026-10-02",
    status: "queued",
    total_recipients: 2,
    queued_count: 2,
    sending_count: 0,
    sent_count: 0,
    failed_count: 0,
    cancelled_count: 0,
    reserved_count: 2,
    created_at: "2026-10-01T10:00:00Z",
    started_at: null,
    completed_at: null,
    scheduled_at: null,
    timezone: null,
    subject: "Bewerbung bei {{company_name}}",
    body_html:
      "<p>{{greeting}}</p><p>Ich möchte gerne bei {{company_name}} arbeiten.</p>",
    goal: "ausbildung",
    ...overrides,
  };
  (H.store["email_campaigns"] ??= []).push(row);
  return row;
}

function seedOwnedMessage(index: number, overrides: Row = {}) {
  const row: Row = {
    id: `m-${index + 1}`,
    campaign_id: "campaign-1",
    user_id: USER.id,
    recipient_email: index === 0 ? "bewerbung@carrier.de" : "info@bosch.de",
    company_name: null,
    contact_name: index === 0 ? null : "Herr Mustermann",
    subject: "Bewerbung bei {{company_name}}",
    status: "queued",
    attempt_count: 0,
    next_attempt_at: null,
    created_at: `2026-10-01T10:00:0${index}Z`,
    updated_at: "2026-10-01T10:00:00Z",
    ...overrides,
  };
  (H.store["email_messages"] ??= []).push(row);
  return row;
}

describe("processCampaignBatch (owned content)", () => {
  it("renders every recipient from the campaign template — NO draft exists, none is read", async () => {
    seedOwnedCampaign();
    seedOwnedMessage(0);
    seedOwnedMessage(1);
    (H.store["email_campaign_attachments"] ??= []).push({
      id: "a-1",
      campaign_id: "campaign-1",
      user_id: USER.id,
      storage_path: "user-1/staging/abc-cv.pdf",
      filename: "cv.pdf",
      mime_type: "application/pdf",
      size_bytes: 1024,
    });
    // Deliberately NO application_drafts row anywhere: a code path that
    // still expected a draft would throw "Draft not found." here.

    const result = await processCampaignBatch(USER.id, "campaign-1", 5);

    expect(result.processed).toBe(2);
    expect(H.sendEmails).toHaveLength(2);
    expect(H.store["application_drafts"]).toBeUndefined();
    // The worker never touched the draft tables.
    expect(H.fromCalls).not.toContain("application_drafts");
    expect(H.fromCalls).not.toContain("application_draft_attachments");

    const [carrier, bosch] = H.sendEmails;
    // Per-recipient personalization from the campaign-owned template.
    expect(carrier.to).toBe("bewerbung@carrier.de");
    expect(bosch.to).toBe("info@bosch.de");
    expect(carrier.subject).toBe("Bewerbung bei Carrier");
    expect(bosch.subject).toBe("Bewerbung bei Bosch");
    expect(String(carrier.html)).toContain("Sehr geehrte Damen und Herren,");
    expect(String(bosch.html)).toContain("Sehr geehrter Herr Mustermann,");
    // No cross-recipient leakage, no unresolved token reaches the provider.
    expect(`${carrier.subject} ${carrier.html} ${carrier.text}`).not.toContain("Bosch");
    expect(`${bosch.subject} ${bosch.html} ${bosch.text}`).not.toContain("Carrier");
    for (const sent of H.sendEmails)
      expect(
        `${sent.subject} ${sent.html} ${sent.text}`,
      ).not.toMatch(/\{\{\s*(company_name|contact_name|greeting)\s*\}\}/);

    // The campaign's OWNED attachment reaches the provider factory.
    expect(H.providerAttachments[0]).toEqual([
      {
        filename: "cv.pdf",
        mimeType: "application/pdf",
        storagePath: "user-1/staging/abc-cv.pdf",
      },
    ]);

    // Both messages finalized as sent through the existing mechanism.
    for (const id of ["m-1", "m-2"]) {
      const row = H.store["email_messages"].find((r) => r.id === id);
      expect(row?.status).toBe("sent");
      expect(row?.provider_message_id).toBeTruthy();
    }
    expect(H.store["email_campaigns"][0].status).toBe("completed");
  });

  it("fails loudly when a draft-free campaign has no content", async () => {
    seedOwnedCampaign({ body_html: "", subject: "Bewerbung" });
    seedOwnedMessage(0);
    await expect(
      processCampaignBatch(USER.id, "campaign-1", 5),
    ).rejects.toThrow("Campaign content is missing.");
    expect(H.sendEmails).toHaveLength(0);
  });

  it("keeps the existing temporary-error retry behaviour (owned content)", async () => {
    seedOwnedCampaign();
    seedOwnedMessage(0);
    H.sendError = {
      code: "provider_rate_limited",
      message: "Rate limited.",
      temporary: true,
    };
    await processCampaignBatch(USER.id, "campaign-1", 5);
    expect(H.sendEmails).toHaveLength(1);
    expect(
      H.rpcLog.filter((entry) => entry.name === "retry_email_message"),
    ).toHaveLength(1);
    expect(H.store["email_messages"][0].status).toBe("queued");
  });
});

// ---------------------------------------------------------------------------
// 4. Pre-migration fallback (probe false → legacy draft world)
// ---------------------------------------------------------------------------

describe("pre-migration fallback (code deployed, migration pending)", () => {
  it("the worker still renders from the draft", async () => {
    H.migrated = false;
    (H.store["email_campaigns"] ??= []).push({
      id: "campaign-1",
      user_id: USER.id,
      draft_id: "draft-1",
      email_account_id: "account-1",
      usage_date: "2026-10-02",
      status: "queued",
      total_recipients: 1,
      queued_count: 1,
      sending_count: 0,
      sent_count: 0,
      failed_count: 0,
      cancelled_count: 0,
      reserved_count: 1,
      created_at: "2026-10-01T10:00:00Z",
      started_at: null,
      completed_at: null,
      scheduled_at: null,
      timezone: null,
      // NO subject / body_html / goal — the columns do not exist pre-migration.
    });
    (H.store["application_drafts"] ??= []).push({
      id: "draft-1",
      user_id: USER.id,
      goal: "ausbildung",
      sender_email_account_id: "account-1",
      subject: "Bewerbung bei {{company_name}}",
      body_html:
        "<p>{{greeting}}</p><p>Ich möchte gerne bei {{company_name}} arbeiten.</p>",
      body_text: "{{greeting}} Ich möchte gerne bei {{company_name}} arbeiten.",
      created_at: "2026-10-01T09:00:00Z",
      updated_at: "2026-10-01T09:00:00Z",
    });
    (H.store["email_messages"] ??= []).push({
      id: "m-1",
      campaign_id: "campaign-1",
      user_id: USER.id,
      recipient_email: "info@bosch.de",
      company_name: null,
      contact_name: "Herr Mustermann",
      subject: "Bewerbung bei {{company_name}}",
      status: "queued",
      attempt_count: 0,
      next_attempt_at: null,
      created_at: "2026-10-01T10:00:00Z",
      updated_at: "2026-10-01T10:00:00Z",
    });

    const result = await processCampaignBatch(USER.id, "campaign-1", 5);

    expect(result.processed).toBe(1);
    expect(H.sendEmails).toHaveLength(1);
    expect(H.sendEmails[0].subject).toBe("Bewerbung bei Bosch");
    expect(String(H.sendEmails[0].html)).toContain(
      "Sehr geehrter Herr Mustermann,",
    );
    // The legacy path IS draft-driven (the draft read happens exactly where
    // it always did).
    expect(H.fromCalls).toContain("application_drafts");
  });

  it("the probe reads fail cleanly → the legacy world is detected, not an error", async () => {
    H.migrated = false;
    expect(await hasCampaignOwnedContent()).toBe(false);
    // No exception leaked from the probe itself.
  });
});

// ---------------------------------------------------------------------------
// 5. listUserCampaigns — the dashboard list (campaigns only, post-migration)
// ---------------------------------------------------------------------------

describe("listUserCampaigns (owned world)", () => {
  it("lists campaigns only: no draft-only rows, title/goal from the owned columns", async () => {
    (H.store["email_accounts"] ??= []).push({
      id: "account-1",
      user_id: USER.id,
      email_address: "sender1@example.com",
    });
    // A draft-free campaign (draft_id NULL) …
    (H.store["email_campaigns"] ??= []).push({
      id: "campaign-A",
      user_id: USER.id,
      draft_id: null,
      email_account_id: "account-1",
      status: "completed",
      total_recipients: 5,
      sent_count: 5,
      failed_count: 0,
      created_at: "2026-10-02T10:00:00Z",
      scheduled_at: null,
      timezone: null,
      subject: "Bewerbung A",
      goal: "ausbildung",
    });
    // … and a backfilled legacy campaign (empty owned subject → the draft
    // is still consulted as a read-only fallback for title/goal).
    (H.store["email_campaigns"] ??= []).push({
      id: "campaign-B",
      user_id: USER.id,
      draft_id: "draft-legacy",
      email_account_id: "account-1",
      status: "failed",
      total_recipients: 3,
      sent_count: 1,
      failed_count: 2,
      created_at: "2026-10-03T10:00:00Z",
      scheduled_at: null,
      timezone: null,
      subject: "",
      goal: "",
    });
    (H.store["application_drafts"] ??= []).push(
      {
        id: "draft-legacy",
        user_id: USER.id,
        goal: "arbeit",
        subject: "Bewerbung legacy",
        opportunity_title: null,
        opportunity_company: "Legacy GmbH",
        sender_email_account_id: "account-1",
        created_at: "2026-10-01T09:00:00Z",
      },
      // A draft WITHOUT any campaign must NOT appear as a row: the Drafts
      // feature is gone from the dashboard.
      {
        id: "draft-only",
        user_id: USER.id,
        goal: "ausbildung",
        subject: "Nicht gesendet",
        opportunity_title: null,
        opportunity_company: null,
        sender_email_account_id: "account-1",
        created_at: "2026-10-04T09:00:00Z",
      },
    );

    const items = await listUserCampaigns(USER.id);

    expect(items.map((item) => item.id)).toEqual([
      "campaign-B",
      "campaign-A",
    ]);
    expect(items.every((item) => item.kind === "campaign")).toBe(true);

    const a = items.find((item) => item.id === "campaign-A");
    expect(a?.title).toBe("Bewerbung A"); // owned subject
    expect(a?.goal).toBe("ausbildung"); // owned goal
    expect(a?.status).toBe("completed");
    expect(a?.sent_count).toBe(5);
    expect(a?.failed_count).toBe(0);
    expect(a?.sender_email).toBe("sender1@example.com");

    const b = items.find((item) => item.id === "campaign-B");
    expect(b?.title).toBe("Bewerbung legacy"); // empty owned subject → draft fallback
    expect(b?.goal).toBe("arbeit"); // empty owned goal → draft fallback
    expect(b?.status).toBe("failed");
    expect(b?.sent_count).toBe(1);
    expect(b?.failed_count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 6. Staged attachments (no DB rows until send)
// ---------------------------------------------------------------------------

describe("staged attachments (draft-free composer)", () => {
  it("stageAttachment uploads under the user's staging prefix and writes ZERO db rows", async () => {
    const fd = new FormData();
    fd.set(
      "file",
      new File([new Uint8Array([1, 2, 3])], "Lebenslauf 2026.pdf", {
        type: "application/pdf",
      }),
    );
    const meta = await stageAttachment(fd);

    expect(H.uploadCalls).toHaveLength(1);
    expect(H.uploadCalls[0].path).toMatch(new RegExp(`^${USER.id}/staging/`));
    expect(H.uploadCalls[0].path).toContain("Lebenslauf_2026.pdf");
    expect(meta.storage_path).toBe(H.uploadCalls[0].path);
    expect(meta.filename).toBe("Lebenslauf 2026.pdf");
    expect(meta.mime_type).toBe("application/pdf");
    expect(meta.size_bytes).toBe(3);
    // The composer still creates NO record of any kind. The only database
    // access is the READ-ONLY plan-cap lookup (subscriptions) that the
    // billing meter added to the upload path — it writes nothing (see the
    // H.store assertion below) and degrades to the 10 MB ceiling when the
    // lookup fails.
    expect(H.fromCalls).toEqual(["subscriptions"]);
    expect(Object.keys(H.store)).toEqual([]);
  });

  it("stageAttachment rejects unsupported types and oversized files", async () => {
    const badType = new FormData();
    badType.set(
      "file",
      new File([new Uint8Array([1])], "a.exe", {
        type: "application/x-msdownload",
      }),
    );
    await expect(stageAttachment(badType)).rejects.toThrow(
      "This file type is not supported.",
    );
    const tooBig = new FormData();
    tooBig.set(
      "file",
      new File([new Uint8Array(11 * 1024 * 1024)], "big.pdf", {
        type: "application/pdf",
      }),
    );
    await expect(stageAttachment(tooBig)).rejects.toThrow(
      "Attachments must be 10 MB or smaller.",
    );
    expect(H.uploadCalls).toHaveLength(0);
  });

  it("discardStagedAttachment removes only this user's staging objects", async () => {
    const own = "user-1/staging/abc-cv.pdf";
    const fdOwn = new FormData();
    fdOwn.set("storagePath", own);
    await discardStagedAttachment(fdOwn);
    expect(H.removedPaths).toContain(own);

    // A foreign user's staging object can never be targeted …
    const fdForeign = new FormData();
    fdForeign.set("storagePath", "user-2/staging/y-cv.pdf");
    await expect(discardStagedAttachment(fdForeign)).rejects.toThrow(
      "Attachment not found.",
    );
    // … and a non-staging path (a legacy draft attachment) never either.
    const fdDraft = new FormData();
    fdDraft.set("storagePath", `${USER.id}/draft-1/cv.pdf`);
    await expect(discardStagedAttachment(fdDraft)).rejects.toThrow(
      "Attachment not found.",
    );
    expect(H.removedPaths).toEqual([own]);
  });
});

// ---------------------------------------------------------------------------
// 7. Opportunity prefill (in-memory only, zero DB writes)
// ---------------------------------------------------------------------------

describe("resolveOpportunityPrefill (draft-free prefill)", () => {
  function makeOpportunity() {
    // Only the documented fields that buildOpportunityPrefill reads — the
    // module under test is mocked at the resolveOpportunityCached boundary.
    return {
      id: "arbeitsagentur:TEST-1",
      external_id: "TEST-1",
      provider: "arbeitsagentur",
      title: "Mechatroniker (m/w/d)",
      goal: "arbeit",
      profession: "Mechatroniker",
      company_name: "Test AG",
      location: "Berlin",
      source_url: "https://www.arbeitsagentur.de/test",
      contact: { email: "bewerbung@test-ag.de" },
    } as unknown as Opportunity;
  }

  it("resolves a valid key into a prefill payload WITHOUT touching the database", async () => {
    vi.mocked(resolveOpportunityCached).mockResolvedValue(makeOpportunity());
    const outcome = await resolveOpportunityPrefill("arbeitsagentur:TEST-1");

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.prefill.goal).toBe("arbeit");
      expect(outcome.prefill.subject).toBe(
        "Bewerbung als Mechatroniker (Referenz TEST-1)",
      );
      expect(String(outcome.prefill.bodyHtml)).toContain(
        "hiermit bewerbe ich mich um die Stelle als Mechatroniker bei Test AG in Berlin",
      );
      expect(outcome.prefill.recipient?.email).toBe("bewerbung@test-ag.de");
      expect(outcome.context.detailHref).toContain("/opportunities/");
    }
    // The composer initial state is server-derived but persisted NOWHERE.
    expect(H.fromCalls).toEqual([]);
    expect(H.rpcLog).toEqual([]);
  });

  it("an invalid key or an unavailable source never writes anything", async () => {
    expect(await resolveOpportunityPrefill("nonsense")).toEqual({
      ok: false,
      error: "invalid_key",
    });
    vi.mocked(resolveOpportunityCached).mockRejectedValue(
      new Error("provider down"),
    );
    expect(await resolveOpportunityPrefill("arbeitsagentur:TEST-1")).toEqual({
      ok: false,
      error: "unavailable",
    });
    expect(H.fromCalls).toEqual([]);
    expect(H.rpcLog).toEqual([]);
    expect(vi.mocked(resolveOpportunityCached)).not.toHaveBeenCalledWith(
      "nonsense",
    );
  });
});

// ---------------------------------------------------------------------------
// 8. Page & composer contracts (source of truth for the draft-free UI)
// ---------------------------------------------------------------------------

describe("draft-free UI contracts", () => {
  const NEW_PAGE = readFileSync("src/app/applications/new/page.tsx", "utf8");
  const LIST_PAGE = readFileSync("src/app/applications/page.tsx", "utf8");
  const COMPOSER = readFileSync(
    "src/components/application-send-composer.tsx",
    "utf8",
  );
  const SEND_ACTION = readFileSync(
    "src/app/applications/new/send-action.ts",
    "utf8",
  );
  const SCHEDULE_ACTION = readFileSync(
    "src/app/applications/new/schedule-action.ts",
    "utf8",
  );

  it("the new-application page renders the stateless composer post-migration without touching a draft row", () => {
    expect(NEW_PAGE).toContain("hasCampaignOwnedContent()");
    expect(NEW_PAGE).toContain("<ApplicationSendComposer");
    expect(NEW_PAGE).toContain("resolveOpportunityPrefill(");
    // The owned branch must not create, resume or save a draft in any way.
    const ownedBranch = NEW_PAGE.slice(
      NEW_PAGE.indexOf("if (owned) {"),
      NEW_PAGE.indexOf("LEGACY (pre-migration)"),
    );
    expect(ownedBranch).not.toContain("createBlankDraft");
    expect(ownedBranch).not.toContain("loadOwnedDraft");
    expect(ownedBranch).not.toContain("saveDraft");
    expect(ownedBranch).not.toContain("applyOpportunityPrefill");
    // The legacy branch is kept for the code-first deploy window.
    expect(NEW_PAGE).toContain("<ApplicationComposer");
  });

  it("the dashboard keeps the Drafts card only in the legacy (pre-migration) shape", () => {
    expect(LIST_PAGE).toContain("hasCampaignOwnedContent()");
    const cards = LIST_PAGE.slice(
      LIST_PAGE.indexOf("const statCards"),
      LIST_PAGE.indexOf("const STAT_TONES"),
    );
    // Exactly one Drafts card, and it sits in the legacy branch (after the
    // ternary) — the owned branch shows Total/Sending/Sent/Failed only.
    expect((cards.match(/"Drafts"/g) ?? []).length).toBe(1);
    expect(cards.indexOf('"Drafts"')).toBeGreaterThan(
      cards.lastIndexOf(": ["),
    );
    for (const label of ["Total", "Sending", "Sent", "Failed"])
      expect((cards.match(new RegExp(`"${label}"`, "g")) ?? []).length).toBe(2);
  });

  it("the stateless composer never creates, saves or resumes a draft", () => {
    for (const forbidden of [
      "saveDraft",
      "discardDraft",
      "createBlankDraft",
      "loadOwnedDraft",
      "draftId",
    ])
      expect(COMPOSER, `composer must not reference ${forbidden}`).not.toContain(
        forbidden,
      );
    expect(COMPOSER).toContain("stageAttachment(");
    expect(COMPOSER).toContain("discardStagedAttachment(");
    expect(COMPOSER).toContain("sendApplications");
    expect(COMPOSER).toContain("scheduleApplications");
  });

  it("the send/schedule server actions carry the full owned payload (or the legacy draft id)", () => {
    expect(SEND_ACTION).toContain("hasCampaignOwnedContent()");
    expect(SEND_ACTION).toContain("bodyHtml");
    expect(SEND_ACTION).toContain("attachments");
    expect(SCHEDULE_ACTION).toContain("hasCampaignOwnedContent()");
    expect(SCHEDULE_ACTION).toContain("wallClockToUtc");
  });

  it("the migration is additive: it never drops the draft schema or deletes draft data", () => {
    const sql = readFileSync(
      "supabase/migrations/20261110000000_campaign_owned_content.sql",
      "utf8",
    );
    expect(sql).toContain("add column if not exists subject");
    expect(sql).toContain("add column if not exists body_html");
    expect(sql).toContain("add column if not exists goal");
    expect(sql).toContain("drop not null");
    expect(sql).toContain("create table if not exists public.email_campaign_attachments");
    // No destructive DDL, no draft deletion.
    expect(sql).not.toMatch(/drop table|truncate|delete from/i);
  });
});
