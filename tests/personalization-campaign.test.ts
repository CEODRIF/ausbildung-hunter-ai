import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Smart personalization × the existing sending pipeline.
 *
 * Runs the REAL createCampaign + processCampaignBatch against an in-memory
 * store that mirrors the email_campaigns / email_messages schema, and pins:
 *
 *   - the draft keeps its variable tokens (the editable original survives),
 *   - createCampaign persists each recipient's company_name + contact_name
 *     onto the email_messages row (the worker's only data source),
 *   - every recipient receives an INDEPENDENT rendered copy (subject +
 *     html + text) built from that recipient's own data only,
 *   - no rendered payload ever contains another recipient's data or an
 *     unresolved token,
 *   - an unresolvable variable goes through the EXISTING per-recipient
 *     failure path (finalize as failed, deterministic code, no provider
 *     call),
 *   - the existing temporary-error retry behaviour stays intact.
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
  rpcLog: [] as Array<{ name: string; args: Record<string, unknown> }>,
  sendEmails: [] as Array<Row>,
  sendError: null as null | { code: string; message: string; temporary: boolean },
}));

vi.mock("@/lib/supabase/admin", () => {
  let insertSeq = 0;
  function makeChain(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    const all = () =>
      (H.store[table] ?? []).filter((row) => filters.every((f) => f(row)));
    const chain: Record<string | symbol, unknown> = new Proxy({}, {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        switch (prop) {
          case "select":
            return () => chain;
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
              filters.push(
                (row) => String(row[column] ?? "") < String(value),
              );
              return chain;
            };
          case "order":
          case "limit":
            return () => chain;
          case "single":
            return async () => {
              const matched = all();
              return matched[0]
                ? { data: matched[0], error: null }
                : { data: null, error: { message: "PGRST116: no rows" } };
            };
          case "maybeSingle":
            return async () => ({ data: all()[0] ?? null, error: null });
          case "insert":
            return (payload: Row | Row[]) => {
              // Mirror the schema: every row gets a PK (DB-generated when
              // the payload omits it).
              const rows = (Array.isArray(payload) ? payload : [payload]).map(
                (row) =>
                  row.id ? row : { ...row, id: `gen-${table}-${++insertSeq}` },
              );
              (H.store[table] ??= []).push(...rows);
              const result: Record<string | symbol, unknown> = {
                select: () => ({
                  single: async () => ({ data: rows[0] ?? null, error: null }),
                }),
              };
              result.then = (onFulfilled?: unknown, onRejected?: unknown) =>
                Promise.resolve({ data: rows, error: null }).then(
                  onFulfilled as never,
                  onRejected as never,
                );
              return result;
            };
          case "delete":
            return () => {
              const matched = all();
              const list = H.store[table] ?? [];
              for (let i = list.length - 1; i >= 0; i -= 1)
                if (matched.includes(list[i])) list.splice(i, 1);
              return Promise.resolve({ data: null, error: null });
            };
          case "then":
            return (onFulfilled?: unknown, onRejected?: unknown) =>
              Promise.resolve({ data: all(), error: null }).then(
                onFulfilled as never,
                onRejected as never,
              );
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
        if (!campaign || !["queued", "sending"].includes(String(campaign.status)))
          return { data: null, error: null };
        const now = new Date();
        const message = (H.store["email_messages"] ?? []).find(
          (m) =>
            m.campaign_id === campaign.id &&
            m.user_id === args.target_user_id &&
            m.status === "queued" &&
            // Due-gate, same as the real RPC.
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
        const c = (H.store["email_campaigns"] ?? []).find(
          (x) => x.id === m.campaign_id,
        );
        if (c) {
          c.sending_count = 0;
          if (args.succeeded) c.sent_count = Number(c.sent_count ?? 0) + 1;
          else c.failed_count = Number(c.failed_count ?? 0) + 1;
          // Mirror the real RPC: no active messages left → terminal status.
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
        if (!m || m.status !== "sending") return { data: false, error: null };
        m.status = "queued";
        // The real RPC back off 60 s — a re-queued message is NOT claimable
        // again in the same batch.
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
  return {
    createAdminClient: () => ({
      from: (table: string) => makeChain(table),
      rpc: (name: string, args?: Record<string, unknown>) =>
        rpcImpl(name, args ?? {}),
      storage: { from: () => ({ remove: async () => undefined }) },
    }),
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
      return Promise.resolve({
        providerMessageId: `pm-${H.sendEmails.length}`,
      });
    },
  }),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUserAndProfile: async () => ({
    user: USER,
    profile: { id: USER.id, account_status: "active" },
  }),
}));

// Keep the REAL sanitizer / htmlToText / validateRecipientList (the feature
// relies on them); only the ownership guards are stubbed.
vi.mock("@/lib/application-drafts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/application-drafts")>();
  return {
    ...actual,
    assertDraftOwnership: async (_userId: string, draftId: string) => ({
      id: draftId,
      user_id: USER.id,
    }),
    assertSenderOwnership: async () => ({}),
  };
});

const { createCampaign, processCampaignBatch } = await import(
  "@/lib/email-campaigns"
);

function seedCampaign() {
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
  (H.store["application_draft_recipients"] ??= []).push(
    {
      id: "r-1",
      draft_id: "draft-1",
      email: "bewerbung@carrier.de",
      company_name: null,
      contact_name: null,
      validation_status: "valid",
      created_at: "2026-10-01T09:00:00Z",
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
  );
  (H.store["email_campaigns"] ??= []).push({
    id: "campaign-1",
    user_id: USER.id,
    draft_id: "draft-1",
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
  });
  (H.store["email_messages"] ??= []).push(
    {
      id: "m-1",
      campaign_id: "campaign-1",
      user_id: USER.id,
      recipient_email: "bewerbung@carrier.de",
      company_name: null,
      contact_name: null,
      subject: "Bewerbung bei {{company_name}}",
      status: "queued",
      attempt_count: 0,
      next_attempt_at: null,
      created_at: "2026-10-01T10:00:00Z",
      updated_at: new Date().toISOString(),
    },
    {
      id: "m-2",
      campaign_id: "campaign-1",
      user_id: USER.id,
      recipient_email: "info@bosch.de",
      company_name: null,
      contact_name: "Herr Mustermann",
      subject: "Bewerbung bei {{company_name}}",
      status: "queued",
      attempt_count: 0,
      next_attempt_at: null,
      created_at: "2026-10-01T10:00:01Z",
      updated_at: new Date().toISOString(),
    },
  );
}

function resetStore() {
  H.store = {};
  H.rpcLog = [];
  H.sendEmails = [];
  H.sendError = null;
}

beforeEach(resetStore);

describe("createCampaign + per-recipient rendering", () => {
  it("persists each recipient's personalization data onto the message rows", async () => {
    seedCampaign();
    const created = await createCampaign({
      draftId: "draft-1",
      senderAccountId: "account-1",
      goal: "ausbildung",
      recipientEmails: [],
    });
    // A FRESH campaign row (the seeded campaign-1 is untouched) with two
    // message rows — one per valid recipient — carrying the personalization
    // data from application_draft_recipients.
    const freshCampaign = H.store["email_campaigns"].find(
      (row) => row.id === created.campaignId,
    );
    expect(freshCampaign).toBeDefined();
    const rows = H.store["email_messages"].filter(
      (row) => row.campaign_id === created.campaignId,
    );
    expect(rows).toHaveLength(2);
    const carrier = rows.find(
      (row) => row.recipient_email === "bewerbung@carrier.de",
    );
    const bosch = rows.find((row) => row.recipient_email === "info@bosch.de");
    expect(carrier).toBeDefined();
    expect(bosch).toBeDefined();
    expect(bosch?.contact_name).toBe("Herr Mustermann");
    expect(carrier?.contact_name).toBeNull();
    // The stored subject is the TEMPLATE (tokens intact) — rendering is a
    // send-time concern, the draft stays editable.
    expect(bosch?.subject).toBe("Bewerbung bei {{company_name}}");
    expect(carrier?.status).toBe("queued");
  });

  it("sends each recipient an independent rendered copy (no leakage, no tokens)", async () => {
    seedCampaign();
    const result = await processCampaignBatch(USER.id, "campaign-1", 5);
    expect(result.processed).toBe(2);
    expect(H.sendEmails).toHaveLength(2);

    const [carrier, bosch] = H.sendEmails;
    expect(carrier.to).toBe("bewerbung@carrier.de");
    expect(bosch.to).toBe("info@bosch.de");

    // Subject + html + text are all rendered per recipient.
    expect(carrier.subject).toBe("Bewerbung bei Carrier");
    expect(bosch.subject).toBe("Bewerbung bei Bosch");
    expect(String(carrier.html)).toContain("bei Carrier arbeiten.");
    expect(String(carrier.html)).toContain("Sehr geehrte Damen und Herren,");
    expect(String(carrier.text)).toContain("bei Carrier arbeiten.");
    expect(String(bosch.html)).toContain("bei Bosch arbeiten.");
    expect(String(bosch.html)).toContain("Sehr geehrter Herr Mustermann,");
    expect(String(bosch.text)).toContain("Sehr geehrter Herr Mustermann,");

    // No cross-recipient leakage.
    expect(`${carrier.subject} ${carrier.html} ${carrier.text}`).not.toContain(
      "Bosch",
    );
    expect(`${carrier.subject} ${carrier.html} ${carrier.text}`).not.toContain(
      "Mustermann",
    );
    expect(`${bosch.subject} ${bosch.html} ${bosch.text}`).not.toContain(
      "Carrier",
    );

    // No unresolved token ever reaches the provider.
    for (const sent of H.sendEmails) {
      const payload = `${sent.subject} ${sent.html} ${sent.text}`;
      expect(payload).not.toMatch(
        /\{\{\s*(company_name|contact_name|greeting)\s*\}\}/,
      );
    }

    // The DRAFT still contains the tokens (the editable original is
    // preserved; only the sent copies were rendered).
    const draft = H.store["application_drafts"][0];
    expect(draft.body_html).toContain("{{greeting}}");
    expect(draft.body_html).toContain("{{company_name}}");
    expect(draft.subject).toContain("{{company_name}}");

    // Both messages finalized as sent through the existing mechanism.
    for (const id of ["m-1", "m-2"]) {
      const row = H.store["email_messages"].find((r) => r.id === id);
      expect(row?.status).toBe("sent");
      expect(row?.provider_message_id).toBeTruthy();
    }
  });

  it("honours the per-recipient company override over the domain inference", async () => {
    seedCampaign();
    H.store["email_messages"].find((r) => r.id === "m-1")!.company_name =
      "Carrier Solutions GmbH";
    await processCampaignBatch(USER.id, "campaign-1", 5);
    expect(H.sendEmails[0].subject).toBe(
      "Bewerbung bei Carrier Solutions GmbH",
    );
    expect(String(H.sendEmails[0].html)).toContain(
      "bei Carrier Solutions GmbH arbeiten.",
    );
  });

  it("routes an unresolvable variable through the existing per-recipient failure path", async () => {
    seedCampaign();
    // A token trapped in an attribute can never be resolved safely → the
    // message must FAIL (deterministic), not be sent malformed.
    H.store["application_drafts"][0].body_html =
      '<a href="{{company_name}}">Kontakt</a><p>{{greeting}}</p>';
    H.store["application_drafts"][0].body_text =
      "Kontakt {{greeting}}";
    const result = await processCampaignBatch(USER.id, "campaign-1", 5);
    expect(result.processed).toBe(2);
    expect(H.sendEmails).toHaveLength(0); // the provider is never called
    for (const id of ["m-1", "m-2"]) {
      const row = H.store["email_messages"].find((r) => r.id === id);
      expect(row?.status).toBe("failed");
      expect(row?.error_code).toBe("personalization_failed");
      expect(String(row?.error_message)).toContain("personalization");
    }
    expect(H.store["email_campaigns"][0].status).toBe("failed");
  });

  it("keeps the existing temporary-error retry behaviour intact", async () => {
    seedCampaign();
    H.sendError = {
      code: "provider_rate_limited",
      message: "Rate limited.",
      temporary: true,
    };
    await processCampaignBatch(USER.id, "campaign-1", 5);
    // Both messages attempted → provider called twice, both re-queued via
    // the existing retry RPC (attempt_count still below the retry cap).
    expect(H.sendEmails).toHaveLength(2);
    expect(H.rpcLog.filter((entry) => entry.name === "retry_email_message")).toHaveLength(2);
    expect(H.store["email_messages"].every((r) => r.status === "queued")).toBe(
      true,
    );
    // …and the re-queued copies were rendered for the NEXT attempt too
    // (rendering is deterministic per recipient — no drift between tries).
    // Advance past the 60 s retry gate, then clear the provider error.
    for (const m of H.store["email_messages"]) m.next_attempt_at = null;
    H.sendError = null;
    await processCampaignBatch(USER.id, "campaign-1", 5);
    expect(H.sendEmails).toHaveLength(4);
    expect(H.sendEmails[2].subject).toBe("Bewerbung bei Carrier");
    expect(H.sendEmails[3].subject).toBe("Bewerbung bei Bosch");
    expect(H.store["email_messages"].every((r) => r.status === "sent")).toBe(
      true,
    );
  });

  it("still passes attachments + sanitizes the rendered HTML", async () => {
    seedCampaign();
    (H.store["application_draft_attachments"] ??= []).push({
      id: "a-1",
      draft_id: "draft-1",
      filename: "cv.pdf",
      mime_type: "application/pdf",
      size_bytes: 1024,
      storage_path: "u/d/cv.pdf",
    });
    // Hostile override must arrive at the provider HTML-escaped.
    H.store["email_messages"].find((r) => r.id === "m-1")!.company_name =
      '<b onclick=alert(1)>Firma</b>';
    await processCampaignBatch(USER.id, "campaign-1", 5);
    const carrier = H.sendEmails[0];
    expect(String(carrier.html)).toContain("&lt;b onclick=alert(1)&gt;Firma&lt;/b&gt;");
    expect(String(carrier.html)).not.toContain("<b onclick");
    expect(carrier.attachments).toEqual([]); // attachments flow via the provider factory (unchanged path)
  });
});
