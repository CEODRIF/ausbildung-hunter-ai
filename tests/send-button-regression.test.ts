import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * REGRESSION — "Send applications" button stopped working after the
 * personalization feature.
 *
 * ROOT CAUSE (evidence-verified): the feature made four server paths
 * (page load, draft autosave, campaign creation, the sending worker)
 * HARD-depend on the new `contact_name` column. This repository applies
 * Supabase migrations MANUALLY (no CI step), so code deployed before the
 * migration is applied hits PostgREST errors (PGRST204 / 42703) on every
 * contact_name query:
 *
 *   page load   → recipients select errors → draft shown with ZERO
 *               recipients → button disabled (no valid recipients)
 *   autosave    → insert with contact_name errors → saveDraft throws →
 *               saveState "error" → button disabled, "Save failed" only
 *   send        → createCampaign reads recipients → [] → throws
 *               "No valid recipients found."
 *   worker      → message select errors → every message fails
 *
 * The fix: a cached capability probe + conditional column handling, so
 * the send path works with AND without the migration (graceful
 * degradation: contact personalization unavailable, company + generic
 * greeting personalization still active).
 *
 * These tests emulate the missing column at the query layer (faithful
 * PostgREST error shape) and pin the post-fix behavior in both DB states.
 */

type Row = Record<string, unknown>;

const USER_ID = "user-1";
const ACC = "account-1";
const USAGE = {
  date: "2026-10-02",
  emails_sent: 0,
  emails_reserved: 0,
  daily_limit: 100,
  remaining: 100,
};

const H = vi.hoisted(() => {
  const state: {
    store: Record<string, Row[]>;
    probeLog: Array<{ table: string; cols: string }>;
    missingContactColumn: boolean;
    sendEmails: Row[];
    sendError: null | {
      code: string;
      message: string;
      temporary: boolean;
    };
    makeChain: (table: string) => unknown;
    makeRpc: (
      name: string,
      args: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: null }>;
  } = {
    store: {},
    probeLog: [],
    missingContactColumn: false,
    sendEmails: [],
    sendError: null,
    makeChain: () => {
      throw new Error("not initialized");
    },
    makeRpc: async () => {
      throw new Error("not initialized");
    },
  };

  const COLUMNS_WITH_COLUMN = new Set([
    "application_draft_recipients",
    "email_messages",
  ]);
  const missingColumnError = (table: string) => ({
    code: "PGRST204",
    message: `Could not find column 'contact_name' in the relation 'public.${table}'`,
  });
  const columnMissing = (table: string, cols: string | null) =>
    state.missingContactColumn &&
    COLUMNS_WITH_COLUMN.has(table) &&
    cols !== null &&
    cols.split(",").map((c) => c.trim()).includes("contact_name");

  let insertSeq = 0;

  function makeChain(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    let selectCols: string | null = null;
    let deleteMode = false;
    const all = () =>
      (state.store[table] ?? []).filter((row) => filters.every((f) => f(row)));
    // Faithful PostgREST projection: only selected columns come back.
    const project = (row: Row): Row =>
      selectCols === null || selectCols.includes("*")
        ? row
        : Object.fromEntries(
            Object.entries(row).filter(([k]) =>
              selectCols!.split(",").map((c) => c.trim()).includes(k),
            ),
          );
    const chain: Record<string | symbol, unknown> = new Proxy({}, {
      get(_t, prop) {
        if (typeof prop !== "string") return undefined;
        switch (prop) {
          case "select":
            return (cols: string) => {
              selectCols = cols;
              state.probeLog.push({ table, cols });
              return chain;
            };
          case "eq":
            return (c: string, v: unknown) => {
              filters.push((row) => row[c] === v);
              return chain;
            };
          case "in":
            return (c: string, vals: unknown[]) => {
              filters.push((row) => vals.includes(row[c]));
              return chain;
            };
          case "lt":
            return (c: string, v: unknown) => {
              filters.push((row) => String(row[c] ?? "") < String(v));
              return chain;
            };
          case "order":
          case "limit":
            return () => chain;
          case "single":
            return async () => {
              if (columnMissing(table, selectCols))
                return { data: null, error: missingColumnError(table) };
              const row = all()[0];
              return row
                ? { data: project(row), error: null }
                : {
                    data: null,
                    error: { message: "PGRST116: no rows" },
                  };
            };
          case "maybeSingle":
            return async () => {
              if (columnMissing(table, selectCols))
                return { data: null, error: missingColumnError(table) };
              return { data: all()[0] ? project(all()[0]) : null, error: null };
            };
          case "insert":
            return (payload: Row | Row[]) => {
              const rows = (Array.isArray(payload) ? payload : [payload]).map(
                (row) => (row.id ? row : { ...row, id: `gen-${++insertSeq}` }),
              );
              if (
                state.missingContactColumn &&
                COLUMNS_WITH_COLUMN.has(table) &&
                rows.some((row) => "contact_name" in row)
              ) {
                const result: Record<string | symbol, unknown> = {
                  select: () => ({
                    single: async () => ({
                      data: null,
                      error: missingColumnError(table),
                    }),
                  }),
                };
                result.then = (onF?: unknown, onR?: unknown) =>
                  Promise.resolve({
                    data: null,
                    error: missingColumnError(table),
                  }).then(onF as never, onR as never);
                return result;
              }
              (state.store[table] ??= []).push(...rows);
              const result: Record<string | symbol, unknown> = {
                select: () => ({
                  single: async () => ({ data: rows[0] ?? null, error: null }),
                }),
              };
              result.then = (onF?: unknown, onR?: unknown) =>
                Promise.resolve({ data: rows, error: null }).then(
                  onF as never,
                  onR as never,
                );
              return result;
            };
          case "delete":
            return () => {
              deleteMode = true;
              return chain;
            };
          case "update":
            return (patch: Row) => {
              for (const row of all()) Object.assign(row, patch);
              return chain;
            };
          case "then":
            return (onF?: unknown, onR?: unknown) => {
              if (deleteMode) {
                const matched = all();
                const list = state.store[table] ?? [];
                for (let i = list.length - 1; i >= 0; i -= 1)
                  if (matched.includes(list[i])) list.splice(i, 1);
                return Promise.resolve({ data: null, error: null }).then(
                  onF as never,
                  onR as never,
                );
              }
              if (columnMissing(table, selectCols))
                return Promise.resolve({
                  data: null,
                  error: missingColumnError(table),
                }).then(onF as never, onR as never);
              return Promise.resolve({
                data: all().map(project),
                error: null,
              }).then(onF as never, onR as never);
            };
          default:
            return undefined;
        }
      },
    });
    return chain;
  }

  const rpc = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: null }> => {
    switch (name) {
      case "reserve_sender_slot":
        return { data: { reserved: true, wait_ms: 0 }, error: null };
      case "get_sender_slot_wait_ms":
        return { data: 0, error: null };
      case "claim_next_email_message": {
        const campaign = (state.store["email_campaigns"] ?? []).find(
          (c) =>
            c.id === args.target_campaign_id &&
            c.user_id === args.target_user_id,
        );
        if (
          !campaign ||
          !["queued", "sending"].includes(String(campaign.status))
        )
          return { data: null, error: null };
        const now = new Date();
        const message = (state.store["email_messages"] ?? []).find(
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
        // `returns public.email_messages` → the FULL row of the CURRENT
        // schema: pre-migration there is simply no contact_name key.
        const data = state.missingContactColumn
          ? Object.fromEntries(
              Object.entries(message).filter(([key]) => key !== "contact_name"),
            )
          : message;
        return { data, error: null };
      }
      case "finalize_email_message": {
        const m = (state.store["email_messages"] ?? []).find(
          (x) => x.id === args.target_message_id,
        );
        if (!m || m.status !== "sending") return { data: false, error: null };
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
        const c = (state.store["email_campaigns"] ?? []).find(
          (x) => x.id === m.campaign_id,
        );
        if (c) {
          c.sending_count = 0;
          if (args.succeeded) c.sent_count = Number(c.sent_count ?? 0) + 1;
          else c.failed_count = Number(c.failed_count ?? 0) + 1;
          const remaining = (state.store["email_messages"] ?? []).filter(
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
        const m = (state.store["email_messages"] ?? []).find(
          (x) => x.id === args.target_message_id,
        );
        if (!m || m.status !== "sending") return { data: false, error: null };
        m.status = "queued";
        m.next_attempt_at = new Date(Date.now() + 60_000).toISOString();
        m.error_code = args.retry_code;
        m.error_message = args.retry_message;
        return { data: true, error: null };
      }
      case "reserve_email_capacity":
      case "get_daily_usage_snapshot":
        return { data: USAGE, error: null };
      default:
        return { data: null, error: null };
    }
  };

  state.makeChain = makeChain;
  state.makeRpc = rpc;
  return state;
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => H.makeChain(table),
    rpc: (name: string, args?: Record<string, unknown>) =>
      H.makeRpc(name, args ?? {}),
    storage: { from: () => ({ remove: async () => undefined }) },
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: USER_ID } } }),
    },
    from: (table: string) => H.makeChain(table),
  }),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUserAndProfile: async () => ({
    user: { id: USER_ID, email: "u@example.test" },
    profile: { id: USER_ID, account_status: "active" },
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Keep the REAL sanitizer / validateRecipientList / probe; stub only the
// ownership guards.
vi.mock("@/lib/application-drafts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/application-drafts")>();
  return {
    ...actual,
    assertDraftOwnership: async (_userId: string, draftId: string) => ({
      id: draftId,
      user_id: USER_ID,
    }),
    assertSenderOwnership: async () => ({}),
  };
});

vi.mock("@/lib/email-providers", () => ({
  createEmailProvider: async () => ({
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
      return Promise.resolve({ providerMessageId: `pm-${H.sendEmails.length}` });
    },
  }),
}));

const { getApplicationComposerData } = await import(
  "@/lib/application-drafts"
);
const { saveDraft } = await import("@/app/applications/new/actions");
const { createCampaign, processCampaignBatch } = await import(
  "@/lib/email-campaigns"
);
const { resetContactNameProbe } = await import(
  "@/lib/contact-name-support"
);

const now = "2026-10-01T09:00:00Z";

function seedWorld() {
  H.store["profiles"] = [
    {
      id: USER_ID,
      account_status: "active",
      selected_goal: "ausbildung",
    },
  ];
  H.store["email_accounts"] = [
    {
      id: ACC,
      user_id: USER_ID,
      provider: "gmail",
      email: "sender@example.com",
      is_active: true,
      created_at: now,
      updated_at: now,
      last_used_at: null,
    },
  ];
  H.store["application_drafts"] = [
    {
      id: "draft-1",
      user_id: USER_ID,
      goal: "ausbildung",
      sender_email_account_id: ACC,
      subject: "Bewerbung bei {{company_name}}",
      body_html:
        "<p>{{greeting}}</p><p>Ich möchte gerne bei {{company_name}} arbeiten.</p>",
      body_text: "{{greeting}} Ich möchte gerne bei {{company_name}} arbeiten.",
      opportunity_title: null,
      created_at: now,
      updated_at: now,
    },
  ];
  H.store["application_draft_recipients"] = [
    {
      id: "r-1",
      draft_id: "draft-1",
      email: "bewerbung@carrier.de",
      company_name: null,
      contact_name: null,
      validation_status: "valid",
      created_at: now,
    },
    {
      id: "r-2",
      draft_id: "draft-1",
      email: "info@bosch.de",
      company_name: null,
      contact_name: "Herr Mustermann",
      validation_status: "valid",
      created_at: "2026-10-01T09:00:01Z",
    },
  ];
}

function seedCampaign(id = "campaign-1") {
  H.store["email_campaigns"] = [
    {
      id,
      user_id: USER_ID,
      draft_id: "draft-1",
      email_account_id: ACC,
      usage_date: "2026-10-02",
      status: "queued",
      total_recipients: 2,
      queued_count: 2,
      sending_count: 0,
      sent_count: 0,
      failed_count: 0,
      cancelled_count: 0,
      reserved_count: 2,
      created_at: now,
      started_at: null,
      completed_at: null,
    },
  ];
  H.store["email_messages"] = [
    {
      id: "m-1",
      campaign_id: id,
      user_id: USER_ID,
      recipient_email: "bewerbung@carrier.de",
      company_name: null,
      contact_name: null,
      subject: "Bewerbung bei {{company_name}}",
      status: "queued",
      attempt_count: 0,
      next_attempt_at: null,
      created_at: now,
      updated_at: new Date().toISOString(),
    },
    {
      id: "m-2",
      campaign_id: id,
      user_id: USER_ID,
      recipient_email: "info@bosch.de",
      company_name: null,
      contact_name: "Herr Mustermann",
      subject: "Bewerbung bei {{company_name}}",
      status: "queued",
      attempt_count: 0,
      next_attempt_at: null,
      created_at: "2026-10-01T09:00:01Z",
      updated_at: new Date().toISOString(),
    },
  ];
}

beforeEach(() => {
  H.store = {};
  H.probeLog = [];
  H.sendEmails = [];
  H.sendError = null;
  H.missingContactColumn = false;
  // The probe is cached per process — every test re-probes its own schema.
  resetContactNameProbe();
});

describe("DB WITHOUT the contact_name migration (deployed-code-first state)", () => {
  beforeEach(() => {
    H.missingContactColumn = true;
  });

  it("page load keeps the user's recipients (button can enable)", async () => {
    seedWorld();
    const data = await getApplicationComposerData();
    expect(data).not.toBeNull();
    expect(data!.draft).not.toBeNull();
    // THE BUG: without the fix this select errored and the draft came back
    // with ZERO recipients → "Send applications" permanently disabled.
    expect(data!.draft!.recipients).toHaveLength(2);
    expect(
      data!.draft!.recipients.map((r) => r.email).sort(),
    ).toEqual(["bewerbung@carrier.de", "info@bosch.de"]);
    // Contact data degrades to null — nothing is invented.
    expect(data!.draft!.recipients.every((r) => r.contact_name === null)).toBe(
      true,
    );
  });

  it("draft autosave succeeds and never writes the missing column", async () => {
    seedWorld();
    await saveDraft({
      draftId: "draft-1",
      goal: "ausbildung",
      senderAccountId: ACC,
      subject: "Bewerbung bei {{company_name}}",
      bodyHtml: "<p>{{greeting}}</p>",
      recipients: [
        {
          email: "bewerbung@carrier.de",
          companyName: "Carrier",
          contactName: "Herr X",
          status: "valid",
        },
        {
          email: "info@bosch.de",
          companyName: null,
          contactName: null,
          status: "valid",
        },
      ],
    });
    // The bug: the insert carried contact_name → PostgREST error → the
    // action threw → saveState "error" → the button stayed disabled.
    const rows = H.store["application_draft_recipients"];
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => !("contact_name" in row))).toBe(true);
    expect(rows.find((r) => r.email === "bewerbung@carrier.de")?.company_name).toBe(
      "Carrier",
    );
    expect(H.store["application_drafts"][0].subject).toBe(
      "Bewerbung bei {{company_name}}",
    );
  });

  it("campaign creation works (no more 'No valid recipients found.')", async () => {
    seedWorld();
    const created = await createCampaign({
      draftId: "draft-1",
      senderAccountId: ACC,
      goal: "ausbildung",
      recipientEmails: [],
    });
    const rows = H.store["email_messages"].filter(
      (row) => row.campaign_id === created.campaignId,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "queued")).toBe(true);
    expect(rows.every((row) => !("contact_name" in row))).toBe(true);
    // The subject TEMPLATE stays tokenized — rendering happens per
    // recipient at send time.
    expect(rows[0].subject).toBe("Bewerbung bei {{company_name}}");
  });

  it("the worker still sends personalized mail (domain company + generic greeting)", async () => {
    seedWorld();
    seedCampaign();
    const result = await processCampaignBatch(USER_ID, "campaign-1", 5);
    expect(result.processed).toBe(2);
    expect(H.sendEmails).toHaveLength(2);
    const [carrier, bosch] = H.sendEmails;
    expect(carrier.to).toBe("bewerbung@carrier.de");
    expect(bosch.to).toBe("info@bosch.de");
    // Company personalization works WITHOUT the migration (it is derived
    // from the email address at render time).
    expect(String(carrier.html)).toContain("bei Carrier arbeiten.");
    expect(String(bosch.html)).toContain("bei Bosch arbeiten.");
    // No contact metadata available → exactly the general formal greeting.
    for (const sent of H.sendEmails) {
      expect(String(sent.html)).toContain("Sehr geehrte Damen und Herren,");
    }
    // No unresolved tokens, no cross-recipient leakage, no failures.
    for (const sent of H.sendEmails) {
      const payload = `${sent.subject} ${sent.html} ${sent.text}`;
      expect(payload).not.toMatch(
        /\{\{\s*(company_name|contact_name|greeting)\s*\}\}/,
      );
    }
    expect(String(carrier.html)).not.toContain("Bosch");
    expect(String(bosch.html)).not.toContain("Carrier");
    expect(
      H.store["email_messages"].every((row) => row.status === "sent"),
    ).toBe(true);
    expect(H.store["email_campaigns"][0].status).toBe("completed");
  });
});

describe("DB WITH the migration applied (full feature)", () => {
  it("contact_name flows end-to-end and personalizes the greeting", async () => {
    seedWorld();
    seedCampaign();
    await processCampaignBatch(USER_ID, "campaign-1", 5);
    expect(H.sendEmails).toHaveLength(2);
    const bosch = H.sendEmails.find(
      (sent) => sent.to === "info@bosch.de",
    )!;
    expect(String(bosch.html)).toContain("Sehr geehrter Herr Mustermann,");
    const carrier = H.sendEmails.find(
      (sent) => sent.to === "bewerbung@carrier.de",
    )!;
    expect(String(carrier.html)).toContain("Sehr geehrte Damen und Herren,");
    expect(String(carrier.html)).not.toContain("Mustermann");
  });

  it("campaign creation persists contact_name for the worker", async () => {
    seedWorld();
    const created = await createCampaign({
      draftId: "draft-1",
      senderAccountId: ACC,
      goal: "ausbildung",
      recipientEmails: [],
    });
    const boschRow = H.store["email_messages"].find(
      (row) =>
        row.campaign_id === created.campaignId &&
        row.recipient_email === "info@bosch.de",
    );
    expect(boschRow?.contact_name).toBe("Herr Mustermann");
  });
});

describe("capability probe", () => {
  it("probes once per process (cached) and degrades on missing column", async () => {
    H.missingContactColumn = true;
    seedWorld();
    const { hasContactNameColumn } = await import(
      "@/lib/contact-name-support"
    );
    expect(await hasContactNameColumn()).toBe(false);
    expect(await hasContactNameColumn()).toBe(false);
    expect(await hasContactNameColumn()).toBe(false);
    // Exactly one probe query despite many consumers.
    const probes = H.probeLog.filter(
      (entry) =>
        entry.table === "application_draft_recipients" &&
        entry.cols === "contact_name",
    );
    expect(probes).toHaveLength(1);
  });

  it("detects the column when the migration is applied", async () => {
    seedWorld();
    const { hasContactNameColumn } = await import(
      "@/lib/contact-name-support"
    );
    expect(await hasContactNameColumn()).toBe(true);
  });
});

describe("composer UI contract (no silent failure)", () => {
  const root = fileURLToPath(new URL("..", import.meta.url)).replace(
    /\/+$/,
    "",
  );
  const COMPOSER = readFileSync(
    `${root}/src/components/application-composer.tsx`,
    "utf8",
  );

  it("disables the send button only for genuine reasons", () => {
    const disabled = COMPOSER.match(
      /disabled=\{\s*!recipients\.some[\s\S]*?saveState !== "saved"\s*\}/,
    );
    expect(disabled).not.toBeNull();
    const expr = disabled![0];
    // valid recipients required …
    expect(expr).toContain(
      '!recipients.some((recipient) => recipient.status === "valid")',
    );
    // … autosave in flight …
    expect(expr).toContain("isPending");
    // … a send in flight (duplicate-submission guard) …
    expect(expr).toContain("isSending");
    // … and the genuinely-required saved-draft gate.
    expect(expr).toContain('saveState !== "saved"');
  });

  it("shows a clear, visible reason when the draft cannot be saved", () => {
    // A disabled button with only a tiny header chip IS a silent failure —
    // the send card must explain the blocked state in place, next to the
    // button.
    const hint = COMPOSER.match(
      /saveState === "error"[\s\S]{0,300}?text-danger[\s\S]{0,300}?Save failed/,
    );
    expect(hint, "an inline 'Save failed' message (text-danger) must exist").not.toBeNull();
  });

  it("keeps the send gate released on failure (finally) — no stuck loading", () => {
    const handler = COMPOSER.slice(
      COMPOSER.indexOf("function handleSendSubmit("),
      COMPOSER.indexOf("const applyTemplate"),
    );
    expect(handler).toContain("sendGate.begin()");
    expect(handler).toMatch(/finally[\s\S]*sendGate\.end\(\)/);
  });
});
