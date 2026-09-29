import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const detailsArbeit =
  (await import("../fixtures/ba-details-arbeit.json")) as Record<
    string,
    unknown
  >;

const { createAdminMock, jsonResponse } = await import("../helpers");

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));
const { createAdminClient } = await import("@/lib/supabase/admin");

const { buildOpportunityPrefill, applyOpportunityPrefill } =
  await import("@/lib/opportunity-prefill");
import type { ApplicationDraft } from "@/lib/application-drafts";
import type { Opportunity } from "@/lib/opportunities/types";

const DETAILS_REF = detailsArbeit.referenznummer as string;
const KEY = `arbeitsagentur:${DETAILS_REF}`;

let adminMock: Awaited<ReturnType<typeof createAdminMock>>;

function setAdminMock(options: Parameters<typeof createAdminMock>[0] = {}) {
  adminMock = createAdminMock(options);
  vi.mocked(createAdminClient).mockReturnValue(adminMock.admin as never);
}

function stubDetails(overrides: Record<string, unknown> = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse({ ...detailsArbeit, ...overrides })),
  );
}

function baseDraft(
  overrides: Partial<ApplicationDraft> = {},
): ApplicationDraft {
  return {
    id: "draft-1",
    user_id: "user-1",
    goal: "arbeit",
    sender_email_account_id: "acc-1",
    subject: "",
    body_html: "",
    body_text: "",
    created_at: "2026-09-28T08:00:00.000Z",
    updated_at: "2026-09-28T08:00:00.000Z",
    opportunity_key: null,
    opportunity_title: null,
    opportunity_company: null,
    opportunity_source_url: null,
    recipients: [],
    attachments: [],
    ...overrides,
  };
}

function composerData(draft: ApplicationDraft) {
  return {
    userId: "user-1",
    accounts: [{ id: "acc-1" }],
    draft,
  };
}

function mkOpp(overrides: Partial<Opportunity> = {}): Opportunity {
  const base: Opportunity = {
    id: "arbeitsagentur:TEST-1",
    provider: "arbeitsagentur",
    external_id: "TEST-1",
    source_name: "S",
    source_url: "https://example.test/1",
    source_type: "official_source",
    additional_sources: [],
    application_url: null,
    title: "Ausbildung Mechatroniker/in",
    goal: "ausbildung",
    stellenangebotsart: "AUSBILDUNG",
    company_name: null,
    company_url: null,
    location: "10115 Berlin",
    location_detail: null,
    distance_km: null,
    latitude: null,
    longitude: null,
    profession: "Mechatroniker/in",
    alternative_professions: [],
    description: null,
    tasks: [],
    requirements: [],
    employment_type: null,
    home_office: null,
    career_change_friendly: null,
    salary: null,
    training_type: "AUSBILDUNG",
    education_requirement: null,
    valid_from: null,
    application_deadline: null,
    posted_at: null,
    updated_at: null,
    retrieved_at: "2026-09-28T12:00:00.000Z",
    contact: null,
    required_skills: [],
    preferred_skills: [],
    required_languages: [],
    extracted_keywords: [],
    match: null,
    ...overrides,
  } as import("@/lib/opportunities/types").Opportunity;
  return base;
}

beforeEach(() => {
  setAdminMock();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// buildOpportunityPrefill (pure, deterministic, documented fields only)
// ---------------------------------------------------------------------------

describe("buildOpportunityPrefill", () => {
  it("Ausbildung subject uses the documented profession + reference", () => {
    const prefill = buildOpportunityPrefill(mkOpp());
    expect(prefill.subject).toBe(
      "Bewerbung um einen Ausbildungsplatz als Mechatroniker/in (Referenz TEST-1)",
    );
    expect(prefill.goal).toBe("ausbildung");
  });

  it("Arbeit subject uses the documented profession", () => {
    const prefill = buildOpportunityPrefill(
      mkOpp({
        goal: "arbeit",
        stellenangebotsart: "ARBEIT",
        training_type: null,
        profession: "Koch/in",
      }),
    );
    expect(prefill.subject).toBe("Bewerbung als Koch/in (Referenz TEST-1)");
    expect(prefill.goal).toBe("arbeit");
  });

  it("missing profession falls back to a generic, factual subject", () => {
    const prefill = buildOpportunityPrefill(
      mkOpp({ goal: "arbeit", stellenangebotsart: "ARBEIT", profession: null }),
    );
    expect(prefill.subject).toBe(
      "Bewerbung auf Ihre Stellenausschreibung (Referenz TEST-1)",
    );
  });

  it("undocumented reference is dropped (never invented)", () => {
    const prefill = buildOpportunityPrefill(mkOpp({ external_id: "   " }));
    expect(prefill.subject).not.toContain("Referenz");
    expect(prefill.bodyHtml).not.toContain("Referenz");
  });

  it("HTML-injecting source fields are escaped in the body", () => {
    const prefill = buildOpportunityPrefill(
      mkOpp({
        company_name: `ACME <script>alert(1)</script> GmbH`,
        location: 'Berlin "Mitte"',
      }),
    );
    expect(prefill.bodyHtml).toContain("&lt;script&gt;");
    expect(prefill.bodyHtml).not.toContain("<script>alert");
    expect(prefill.bodyHtml).toContain("&quot;Mitte&quot;");
    // Subject is plain text (no HTML), company appears escaped-free there:
    expect(prefill.subject).not.toContain("<");
  });

  it("missing company/location drop out of the body (no placeholders)", () => {
    const prefill = buildOpportunityPrefill(
      mkOpp({ company_name: null, location: null }),
    );
    expect(prefill.bodyHtml).not.toContain(" bei ");
    expect(prefill.bodyHtml).not.toContain(" in ");
    expect(prefill.context.company).toBeNull();
    expect(prefill.context.location).toBeNull();
  });

  it("a documented + valid contact email becomes the pre-filled recipient", () => {
    const prefill = buildOpportunityPrefill(
      mkOpp({
        company_name: "ACME GmbH",
        contact: { person: null, email: "  HR@Acme.Example ", phone: null },
      }),
    );
    expect(prefill.recipient).toEqual({
      email: "hr@acme.example",
      companyName: "ACME GmbH",
    });
  });

  it("an invalid/missing contact email never becomes a recipient", () => {
    const invalid = buildOpportunityPrefill(
      mkOpp({ contact: { person: null, email: "not-an-email", phone: null } }),
    );
    expect(invalid.recipient).toBeNull();
    const none = buildOpportunityPrefill(mkOpp());
    expect(none.recipient).toBeNull();
  });

  it("is deterministic: same opportunity → identical prefill", () => {
    const opportunity = mkOpp({
      company_name: "ACME GmbH",
      location: "10115 Berlin",
    });
    expect(buildOpportunityPrefill(opportunity)).toEqual(
      buildOpportunityPrefill(opportunity),
    );
  });

  it("context carries the source URL and the detail href", () => {
    const prefill = buildOpportunityPrefill(mkOpp());
    expect(prefill.context.sourceUrl).toBe("https://example.test/1");
    expect(prefill.context.detailHref).toBe(
      "/opportunities/arbeitsagentur%3ATEST-1",
    );
  });
});

// ---------------------------------------------------------------------------
// applyOpportunityPrefill (server-side draft strategy)
// ---------------------------------------------------------------------------

describe("applyOpportunityPrefill", () => {
  it("rejects malformed keys before any network or database call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    for (const key of [
      "not-a-key",
      "otherprovider:abc123-S",
      "arbeitsagentur:bad ref",
    ]) {
      const outcome = await applyOpportunityPrefill(
        composerData(baseDraft()),
        key,
      );
      expect(outcome).toEqual({ ok: false, error: "invalid_key" });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(adminMock.calls).toHaveLength(0);
  });

  it("reports unavailable when the source no longer has the vacancy (no draft writes)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              messages: [{ code: "STELLENANGEBOT_NICHT_GEFUNDEN" }],
              timestamp: "2026-09-28T00:00:00Z",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const outcome = await applyOpportunityPrefill(
      composerData(baseDraft()),
      KEY,
    );
    expect(outcome).toEqual({ ok: false, error: "unavailable" });
    expect(
      adminMock.calls.some(
        (call) =>
          call.table === "application_drafts" &&
          (call.op === "update" || call.op === "insert"),
      ),
    ).toBe(false);
  });

  it("updates a BLANK draft in place (no new draft, context persisted)", async () => {
    stubDetails();
    const outcome = await applyOpportunityPrefill(
      composerData(baseDraft()),
      KEY,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.createdNewDraft).toBe(false);
    expect(outcome.notice).toBeNull();

    const update = adminMock.calls.find(
      (call) => call.table === "application_drafts" && call.op === "update",
    );
    expect(update).toBeDefined();
    const payload = update?.args[0] as Record<string, unknown>;
    expect(String(payload.subject)).toContain("Bewerbung");
    expect(payload.opportunity_key).toBe(KEY);
    expect(String(payload.body_text).trim()).not.toBe("");
    // No insert of a second draft.
    expect(
      adminMock.calls.some(
        (call) => call.table === "application_drafts" && call.op === "insert",
      ),
    ).toBe(false);

    // The details fixture documents a contact email → recipient persisted.
    const recipientInsert = adminMock.calls.find(
      (call) =>
        call.table === "application_draft_recipients" && call.op === "insert",
    );
    expect(recipientInsert).toBeDefined();
    const rows = recipientInsert?.args[0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].draft_id).toBe("draft-1");
    expect(String(rows[0].email)).toContain("@");

    // Returned draft carries the prefill + context.
    expect(outcome.draft.subject).toBe(String(payload.subject));
    expect(outcome.draft.opportunity_key).toBe(KEY);
    expect(outcome.draft.recipients).toHaveLength(1);
  });

  it("keeps a NON-BLANK draft untouched and creates a new pre-filled draft", async () => {
    stubDetails();
    setAdminMock({
      singleData: (table) =>
        table === "application_drafts"
          ? {
              id: "draft-2",
              user_id: "user-1",
              goal: "arbeit",
              sender_email_account_id: "acc-1",
              subject: "",
              body_html: "",
              body_text: "",
              created_at: "2026-09-28T09:00:00.000Z",
              updated_at: "2026-09-28T09:00:00.000Z",
            }
          : null,
    });
    const busyDraft = baseDraft({
      subject: "Meine laufende Bewerbung",
      body_html: "<p>WIP</p>",
      body_text: "WIP",
      recipients: [
        {
          id: "r-1",
          email: "other@example.com",
          company_name: null,
          validation_status: "valid",
        },
      ],
    });
    const outcome = await applyOpportunityPrefill(composerData(busyDraft), KEY);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.createdNewDraft).toBe(true);
    expect(outcome.notice).toContain("neuer Entwurf");

    const insert = adminMock.calls.find(
      (call) => call.table === "application_drafts" && call.op === "insert",
    );
    expect(insert).toBeDefined();
    const payload = insert?.args[0] as Record<string, unknown>;
    expect(payload.user_id).toBe("user-1");
    expect(payload.opportunity_key).toBe(KEY);
    expect(String(payload.subject)).toContain("Bewerbung");
    // The previous draft is never modified.
    expect(
      adminMock.calls.some(
        (call) => call.table === "application_drafts" && call.op === "update",
      ),
    ).toBe(false);
    // New recipient targets the NEW draft.
    const recipientInsert = adminMock.calls.find(
      (call) =>
        call.table === "application_draft_recipients" && call.op === "insert",
    );
    const rows = recipientInsert?.args[0] as Array<Record<string, unknown>>;
    expect(rows[0]?.draft_id).toBe("draft-2");
    expect(outcome.draft.id).toBe("draft-2");
  });

  it("prefills no recipient when the source documents no contact email", async () => {
    // Description removed → no contact person/email/phone is extractable.
    stubDetails({ stellenangebotsBeschreibung: null });
    const outcome = await applyOpportunityPrefill(
      composerData(baseDraft()),
      KEY,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(
      adminMock.calls.some(
        (call) =>
          call.table === "application_draft_recipients" && call.op === "insert",
      ),
    ).toBe(false);
    expect(outcome.draft.recipients).toEqual([]);
  });

  it("writes a fail-safe, user-scoped update (id + user_id filters)", async () => {
    stubDetails();
    await applyOpportunityPrefill(composerData(baseDraft()), KEY);
    const eqCalls = adminMock.calls.filter(
      (call) => call.table === "application_drafts" && call.op === "eq",
    );
    const filterValues = eqCalls.map((call) => call.args[0]);
    expect(filterValues).toContain("id");
    expect(filterValues).toContain("user_id");
    const userScope = eqCalls.find((call) => call.args[0] === "user_id");
    expect(userScope?.args[1]).toBe("user-1");
  });
});
