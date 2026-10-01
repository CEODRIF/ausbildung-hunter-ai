import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Bulk selection + bulk delete for the Applications list.
 *
 * Covers the selection logic (pure helpers), the server-side bulk action
 * (deleteCampaignsAction reusing the existing deleteCampaign engine path,
 * one campaign at a time), and the UI wiring (checkboxes on campaign rows
 * only, Select all, the bulk bar, the confirmation modal, the result
 * summary, double-click protection).
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
      //  - email_messages.campaign_id: ON DELETE CASCADE
      //  - email_campaigns.draft_id:   ON DELETE RESTRICT
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
            return (
              _columns: string,
              opts?: { count?: string; head?: boolean },
            ) => {
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
  ) =>
    recipients
      .filter((recipient) => recipient.email.trim())
      .map((recipient) => ({
        email: recipient.email.trim().toLowerCase(),
        company_name: recipient.companyName?.trim() || null,
        validation_status: "valid" as const,
      })),
  createStoragePath: (userId: string, draftId: string, filename: string) =>
    `${userId}/${draftId}/${filename}`,
  ALLOWED_ATTACHMENT_TYPES: new Set(["application/pdf"]),
  MAX_ATTACHMENT_SIZE: 10 * 1024 * 1024,
}));

const { deleteCampaignsAction } = await import("@/app/applications/actions");
const { createCampaign: createCampaignDirect } = await import(
  "@/lib/email-campaigns"
);
const { getCurrentUserAndProfile } = await import("@/lib/auth");
const { revalidatePath } = await import("next/cache");
const {
  campaignIds,
  pruneSelection,
  selectAllVisible,
  toggleSelection,
  bulkDeleteSummary,
} = await import("@/lib/bulk-selection");

const USER = { id: "user-1", email: "u@example.test" };
const USAGE = {
  date: "2026-10-02",
  emails_sent: 0,
  emails_reserved: 0,
  daily_limit: 100,
  remaining: 100,
};

function seedCampaign(id: string, overrides: Row = {}): Row {
  const row: Row = {
    id,
    user_id: USER.id,
    draft_id: `draft-${id}`,
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

function seedDraft(draftId: string) {
  (store["application_drafts"] ??= []).push({
    id: draftId,
    user_id: USER.id,
    goal: "ausbildung",
    sender_email_account_id: "account-1",
    subject: `Bewerbung ${draftId}`,
    body_html: "<p>Text</p>",
    body_text: "Text",
    opportunity_key: null,
    opportunity_title: null,
    opportunity_company: null,
    opportunity_source_url: null,
    created_at: "2026-10-01T09:00:00Z",
    updated_at: "2026-10-01T09:00:00Z",
  });
}

function seedMessage(campaignId: string, index: number, overrides: Row = {}) {
  (store["email_messages"] ??= []).push({
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
  });
}

function seedAccount(overrides: Row = {}) {
  (store["email_accounts"] ??= []).push({
    id: "account-1",
    user_id: USER.id,
    provider: "gmail",
    email_address: "sender1@example.com",
    is_active: true,
    oauth_token: "encrypted-token-value",
    oauth_refresh_token: "encrypted-refresh-value",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    last_used_at: null,
    ...overrides,
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

describe("selection logic (pure helpers)", () => {
  const A = { kind: "campaign", id: "campaign-A" };
  const B = { kind: "campaign", id: "campaign-B" };
  const C = { kind: "campaign", id: "campaign-C" };
  const D = { kind: "draft", id: "draft-D" };

  it("selects one campaign, then several (toggle)", () => {
    expect([...toggleSelection(new Set(), A.id)]).toEqual(["campaign-A"]);
    const two = toggleSelection(toggleSelection(new Set(), A.id), C.id);
    expect([...two].sort()).toEqual(["campaign-A", "campaign-C"]);
    // Toggling again deselects.
    expect(toggleSelection(two, A.id).has("campaign-A")).toBe(false);
  });

  it("select-all selects the visible campaigns — never drafts, never hidden rows", () => {
    const all = selectAllVisible(new Set(), [A, B, C, D]);
    expect([...all].sort()).toEqual([
      "campaign-A",
      "campaign-B",
      "campaign-C",
    ]);
    // A filtered view (only A and C visible) selects those two.
    const filtered = selectAllVisible(new Set(), [A, C]);
    expect([...filtered]).toEqual(["campaign-A", "campaign-C"]);
    // An all-draft view produces no bulk selection at all.
    expect(selectAllVisible(new Set(), [D]).size).toBe(0);
  });

  it("select-all clears the selection when everything visible is already selected", () => {
    const selected = new Set(["campaign-A", "campaign-B"]);
    expect(selectAllVisible(selected, [A, B]).size).toBe(0);
  });

  it("prunes deleted ids out of the selection after the list revalidates", () => {
    const selected = new Set(["campaign-A", "campaign-B", "campaign-C"]);
    const pruned = pruneSelection(selected, [A, B]);
    expect([...pruned]).toEqual(["campaign-A", "campaign-B"]);
    // No change → same reference (no unnecessary re-render).
    expect(pruneSelection(selected, [A, B, C])).toBe(selected);
  });

  it("campaignIds never returns draft ids", () => {
    expect(campaignIds([A, D, B])).toEqual(["campaign-A", "campaign-B"]);
  });

  it("builds the human result summary", () => {
    expect(bulkDeleteSummary(["a"], [], [])).toBe(
      "1 campaign deleted successfully.",
    );
    expect(bulkDeleteSummary(["a", "b"], ["c"], [])).toBe(
      "2 campaigns deleted successfully. 1 campaign could not be deleted because it is currently being sent.",
    );
    expect(bulkDeleteSummary([], [], ["x", "y"])).toBe(
      "2 campaigns could not be deleted.",
    );
  });
});

describe("deleteCampaignsAction (server-side, one campaign at a time)", () => {
  it("deletes only the selected campaigns — A and C, B survives", async () => {
    seedCampaign("campaign-A");
    seedCampaign("campaign-B");
    seedCampaign("campaign-C");
    for (let i = 0; i < 2; i += 1) seedMessage("campaign-A", i);
    for (let i = 0; i < 2; i += 1) seedMessage("campaign-B", i);
    for (let i = 0; i < 2; i += 1) seedMessage("campaign-C", i);

    const result = await deleteCampaignsAction([
      "campaign-A",
      "campaign-C",
    ]);

    expect(result.deleted.sort()).toEqual(["campaign-A", "campaign-C"]);
    expect(result.blocked).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(store["email_campaigns"].map((row) => row.id)).toEqual([
      "campaign-B",
    ]);
    // B's messages survive; A's and C's messages are gone (cascade, no orphans).
    expect(store["email_messages"]).toHaveLength(2);
    expect(
      store["email_messages"].every((row) => row.campaign_id === "campaign-B"),
    ).toBe(true);
  });

  it("cannot delete a campaign owned by another user", async () => {
    seedCampaign("campaign-A");
    seedCampaign("campaign-X", { user_id: "user-2" });
    seedMessage("campaign-X", 0);

    const result = await deleteCampaignsAction([
      "campaign-A",
      "campaign-X",
    ]);

    expect(result.deleted).toEqual(["campaign-A"]);
    expect(result.failed).toEqual(["campaign-X"]);
    // The foreign campaign and its messages are untouched.
    expect(store["email_campaigns"].map((row) => row.id)).toEqual([
      "campaign-X",
    ]);
    expect(store["email_messages"]).toHaveLength(1);
    // The ONLY delete query ever attempted was scoped to the caller's
    // user_id — the foreign id failed the ownership-scoped lookup before
    // any delete could run.
    expect(deletedEqChain).toEqual([
      { table: "email_campaigns", value: "campaign-A" },
      { table: "email_campaigns", value: USER.id },
    ]);
  });

  it("requires an authenticated, active account", async () => {
    seedCampaign("campaign-A");
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
      user: null,
      profile: null,
    } as never);
    const result = await deleteCampaignsAction(["campaign-A"]);
    expect(result).toEqual({
      ok: false,
      deleted: [],
      blocked: [],
      failed: [],
    });
    expect(deletedFrom).toHaveLength(0);
    expect(store["email_campaigns"]).toHaveLength(1);
  });

  it("is a no-op for an empty id list", async () => {
    seedCampaign("campaign-A");
    const result = await deleteCampaignsAction([]);
    expect(result.ok).toBe(true);
    expect(result.deleted).toEqual([]);
    expect(deletedFrom).toHaveLength(0);
  });

  it("protects a sending campaign (partial bulk delete)", async () => {
    seedCampaign("campaign-A");
    seedCampaign("campaign-B", { status: "sending" });
    seedMessage("campaign-B", 0, { status: "sending" });

    const result = await deleteCampaignsAction(["campaign-A", "campaign-B"]);

    expect(result.deleted).toEqual(["campaign-A"]);
    expect(result.blocked).toEqual(["campaign-B"]);
    expect(result.failed).toEqual([]);
    // The sending campaign keeps its row AND its in-flight message.
    expect(store["email_campaigns"].map((row) => row.id)).toEqual([
      "campaign-B",
    ]);
    expect(store["email_messages"]).toHaveLength(1);
    expect(store["email_messages"][0].status).toBe("sending");
  });

  it("protects a queued campaign with a message already claimed (in-flight)", async () => {
    seedCampaign("campaign-A");
    seedCampaign("campaign-B", {
      status: "queued",
      started_at: "2026-10-01T10:00:01Z",
    });
    seedMessage("campaign-B", 0, { status: "sending" });

    const result = await deleteCampaignsAction(["campaign-A", "campaign-B"]);

    expect(result.deleted).toEqual(["campaign-A"]);
    expect(result.blocked).toEqual(["campaign-B"]);
    expect(store["email_campaigns"].map((row) => row.id)).toEqual([
      "campaign-B",
    ]);
  });

  it("releases each deleted campaign's own capacity (per usage_date)", async () => {
    seedCampaign("campaign-A", {
      status: "queued",
      queued_count: 3,
      usage_date: "2026-10-01",
    });
    seedCampaign("campaign-B", {
      status: "queued",
      queued_count: 2,
      usage_date: "2026-10-02",
    });
    const result = await deleteCampaignsAction(["campaign-A", "campaign-B"]);
    expect(result.deleted).toHaveLength(2);
    expect(rpc).toHaveBeenCalledWith("release_email_capacity", {
      target_user_id: USER.id,
      reservation_date: "2026-10-01",
      released: 3,
    });
    expect(rpc).toHaveBeenCalledWith("release_email_capacity", {
      target_user_id: USER.id,
      reservation_date: "2026-10-02",
      released: 2,
    });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("never deletes email_accounts or OAuth tokens", async () => {
    seedAccount();
    seedCampaign("campaign-A");
    await deleteCampaignsAction(["campaign-A"]);
    // Only the campaign table is ever written to (and cascade-deleted from).
    expect(new Set(deletedFrom)).toEqual(new Set(["email_campaigns"]));
    expect(store["email_accounts"]).toHaveLength(1);
    // The account — and its encrypted tokens — is byte-for-byte intact.
    expect(store["email_accounts"][0]).toMatchObject({
      id: "account-1",
      email_address: "sender1@example.com",
      oauth_token: "encrypted-token-value",
      oauth_refresh_token: "encrypted-refresh-value",
      is_active: true,
    });
  });

  it("does not touch Search Credits or any other RPC", async () => {
    seedCampaign("campaign-A");
    await deleteCampaignsAction(["campaign-A"]);
    expect(
      rpc.mock.calls.every((call) => call[0] === "release_email_capacity"),
    ).toBe(true);
    const ACTIONS = readFileSync("src/app/applications/actions.ts", "utf8");
    expect(ACTIONS).not.toMatch(/search-credits|tavily|gemini/i);
    expect(ACTIONS).not.toContain("email_token");
    expect(ACTIONS).not.toContain("email_accounts");
  });

  it("reports a database failure as failed (never as deleted)", async () => {
    seedCampaign("campaign-A");
    deleteError = { message: "boom" };
    const result = await deleteCampaignsAction(["campaign-A"]);
    expect(result.deleted).toEqual([]);
    expect(result.failed).toEqual(["campaign-A"]);
    // The row survives a failed delete.
    expect(store["email_campaigns"]).toHaveLength(1);
  });

  it("ignores draft ids — bulk delete is campaigns only", async () => {
    seedDraft("draft-A");
    seedCampaign("campaign-A");
    const result = await deleteCampaignsAction(["draft-A", "campaign-A"]);
    expect(result.deleted).toEqual(["campaign-A"]);
    expect(result.failed).toEqual(["draft-A"]);
    expect(store["application_drafts"]).toHaveLength(1);
  });

  it("deduplicates repeated ids from the client", async () => {
    seedCampaign("campaign-A");
    seedMessage("campaign-A", 0);
    const result = await deleteCampaignsAction([
      "campaign-A",
      "campaign-A",
      "campaign-A",
    ]);
    expect(result.deleted).toEqual(["campaign-A"]);
    // Exactly one delete per campaign, each scoped by owner.
    expect(deletedEqChain).toEqual([
      { table: "email_campaigns", value: "campaign-A" },
      { table: "email_campaigns", value: USER.id },
    ]);
  });

  it("revalidates the applications list so counters refresh", async () => {
    seedCampaign("campaign-A");
    await deleteCampaignsAction(["campaign-A"]);
    expect(revalidatePath).toHaveBeenCalledWith("/applications");
  });

  it("a new campaign can be created after a bulk delete", async () => {
    seedAccount();
    seedDraft("draft-A");
    (store["application_draft_recipients"] ??= []).push({
      id: "draft-A-r0",
      draft_id: "draft-A",
      email: "x-0@example.de",
      company_name: null,
      validation_status: "valid",
      created_at: "2026-10-01T09:00:00Z",
    });
    seedCampaign("campaign-A");
    seedMessage("campaign-A", 0);
    rpc.mockResolvedValue({ data: USAGE, error: null });
    await deleteCampaignsAction(["campaign-A"]);
    expect(store["email_campaigns"]).toHaveLength(0);

    const created = await createCampaignDirect({
      draftId: "draft-A",
      senderAccountId: "account-1",
      goal: "ausbildung",
      recipientEmails: [],
    });
    expect(store["email_campaigns"]).toHaveLength(1);
    expect(store["email_messages"]).toHaveLength(1);
    expect(store["email_messages"][0].campaign_id).toBe(created.campaignId);
  });
});

describe("bulk delete UI wiring (source of truth)", () => {
  const TABLE = readFileSync(
    "src/components/applications-table.tsx",
    "utf8",
  );
  const ACTIONS = readFileSync("src/app/applications/actions.ts", "utf8");
  const PAGE = readFileSync("src/app/applications/page.tsx", "utf8");

  it("shows the bulk bar only while a selection exists, with clear + delete", () => {
    expect(TABLE).toContain("{effectiveSelected.size > 0 && (");
    expect(TABLE).toContain("{effectiveSelected.size} campaign");
    expect(TABLE).toContain('{effectiveSelected.size === 1 ? "" : "s"} selected');
    expect(TABLE).toContain("Clear selection");
    expect(TABLE).toContain("Delete selected");
    expect(TABLE).toContain("onClick={() => setSelected(new Set())}");
  });

  it("keeps the bulk UI hidden when no campaign rows exist", () => {
    // The header checkbox only renders when the view has campaign rows.
    expect(TABLE).toContain("viewCampaignIds.length > 0");
    expect(TABLE).toContain('aria-label="Select all visible campaigns"');
    expect(TABLE).toMatch(
      /onChange=\{\(\) =>[\s\S]{0,80}setSelected\(selectAllVisible\(effectiveSelected, rows\)\)/,
    );
  });

  it("renders a checkbox on campaign rows only — drafts are never selectable", () => {
    // Desktop: the checkbox cell is conditional on the row kind.
    expect(TABLE).toContain('{row.kind === "campaign" ? (');
    expect(TABLE).toMatch(
      /onChange=\{\(\) =>[\s\S]{0,80}setSelected\(toggleSelection\(selected, row\.id\)\)/g,
    );
    // The toggle is wired in both the desktop row and the mobile card.
    expect(TABLE.split("toggleSelection(selected, row.id)").length - 1).toBe(2);
    // Mobile card: the checkbox is wrapped in the same kind guard.
    expect(TABLE).toContain('{row.kind === "campaign" && (');
    // And the selection helpers can only ever see campaign ids.
    expect(TABLE).toContain(
      "const viewCampaignIds = useMemo(() => campaignIds(rows), [rows]);",
    );
  });

  it("requires a confirmation modal before the bulk delete", () => {
    expect(TABLE).toContain("Delete selected campaigns?");
    expect(TABLE).toContain("You are about to permanently delete");
    expect(TABLE).toContain("This action cannot be undone.");
    // The button count is dynamic (1 campaign / N campaigns).
    expect(TABLE).toContain("Delete ${effectiveSelected.size} campaign");
    expect(TABLE).toContain('effectiveSelected.size === 1 ? "" : "s"');
    // The destructive call exists exactly once, inside the confirm handler.
    expect(TABLE.split("deleteCampaignsAction(").length - 1).toBe(1);
    const confirm = TABLE.slice(
      TABLE.indexOf("async function confirmBulkDelete"),
      TABLE.indexOf("return (\n    <div>"),
    );
    expect(confirm).toContain("deleteCampaignsAction([...effectiveSelected])");
  });

  it("warns about (and never force-deletes) selected sending campaigns", () => {
    expect(TABLE).toContain("currently being sent");
    expect(TABLE).toContain("Please wait until sending finishes before deleting them.");
    // The confirm button is disabled while every selection is sending.
    expect(TABLE).toContain("selectedSending === effectiveSelected.size");
  });

  it("prevents double-click / double-confirm", () => {
    expect(TABLE).toContain(
      "if (isBulkDeleting || effectiveSelected.size === 0) return;",
    );
    // The confirm button is disabled while an operation is in flight.
    expect(TABLE).toMatch(/disabled=\{\s+isBulkDeleting/);
    expect(TABLE).toMatch(/\{isBulkDeleting\s*\?\s*"Deleting…"/);
  });

  it("only removes what was actually deleted; failed stays visible", () => {
    // The local hidden set grows with result.deleted ONLY.
    expect(TABLE).toContain(
      "setHiddenIds((prev) => new Set([...prev, ...result.deleted]))",
    );
    // Selection keeps blocked ids (retryable) but loses deleted ones.
    expect(TABLE).toContain("for (const id of result.deleted) next.delete(id);");
    // Stale ids are pruned (derived state, at render time) once the server
    // data returns — for both the selection and the hidden set.
    expect(TABLE).toContain("pruneSelection(selected, items)");
    expect(TABLE).toContain("pruneSelection(hiddenIds, items)");
  });

  it("shows the result summary instead of pretending a delete succeeded", () => {
    const BULK_SEL = readFileSync("src/lib/bulk-selection.ts", "utf8");
    // The table renders the helper's output verbatim.
    expect(TABLE).toContain("bulkDeleteSummary(");
    // …and the helper produces the honest, dynamic wording.
    expect(BULK_SEL).toContain("deleted successfully.");
    expect(BULK_SEL).toContain("could not be deleted because");
  });

  it("updates the counters via server revalidation, not a full reload", () => {
    // Client side: a partial RSC refresh after the bulk operation.
    expect(TABLE).toContain("router.refresh()");
    // Server side: the action revalidates the list (stats recompute from DB).
    expect(ACTIONS).toContain('revalidatePath("/applications")');
    // The page stats still come from the database-backed list.
    expect(PAGE).toContain("listUserCampaigns(user.id)");
  });

  it("the server action reuses deleteCampaign — no second delete path", () => {
    expect(ACTIONS).toContain("await deleteCampaign(user.id, id);");
    expect(ACTIONS).toContain("instanceof CampaignDeleteBlockedError");
    // …and it validates the session itself, never trusting client ids.
    expect(ACTIONS).toContain("getCurrentUserAndProfile()");
    expect(ACTIONS).toContain('profile.account_status !== "active"');
  });

  it("keeps account management and other systems out of the bulk UI", () => {
    for (const forbidden of [
      "Disconnect",
      "Reconnect",
      "Connect Gmail",
      "OAuth",
    ])
      expect(TABLE).not.toContain(forbidden);
    expect(TABLE).not.toMatch(/search-credits|tavily|gemini|outlook-oauth/i);
  });
});
