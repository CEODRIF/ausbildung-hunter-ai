import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Company Discovery — persistence, campaign bridge and the Excel export.
 *
 * Everything runs through an in-memory stand-in for the Supabase admin client,
 * so these tests exercise the REAL store code paths (which columns are
 * written, which rows come back, which provenance is kept) instead of
 * asserting on mocks of themselves. The workbook is built by the real
 * `exceljs` and parsed back: the file content is verified, not assumed.
 */

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  failNext: false,
  /** Simulates a database that has NOT received the link migration yet. */
  missingLinkColumn: false,
  lastUpsert: null as null | { table: string; options: unknown },
  auth: { user: { id: "" } as { id: string } | null, accountStatus: "active" },
}));

const UNKNOWN_COLUMN_ERROR = {
  code: "PGRST204",
  message:
    "Could not find the 'discovery_run_id' column of 'application_drafts' in the schema cache",
};

function matches(row: Row, filters: Array<[string, unknown]>, sets: Array<[string, unknown[]]>) {
  return (
    filters.every(([column, value]) => row[column] === value) &&
    sets.every(([column, values]) => values.includes(row[column]))
  );
}

function makeClient() {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const sets: Array<[string, unknown[]]> = [];
      const nullFilters: Array<[string]> = [];
      let limit: number | null = null;
      let payload: Row[] | null = null;
      let op: "select" | "insert" | "upsert" = "select";
      let touchesLinkColumn = false;
      const rows = () => (state.db[table] ??= []);
      const exec = () => {
        if (state.failNext) {
          state.failNext = false;
          return {
            data: null,
            error: { code: "PGRST205", message: "schema cache" },
          };
        }
        if (state.missingLinkColumn && touchesLinkColumn) {
          return { data: null, error: UNKNOWN_COLUMN_ERROR };
        }
        if (op !== "select") {
          // PostgREST returns the STORED row (defaults included) — the fake
          // therefore assigns the id/created_at defaults the schema declares.
          const stored = (payload ?? []).map((row) => ({
            id: row.id ?? `generated-${rows().length + 1}`,
            created_at: row.created_at ?? "2026-10-03T00:00:00.000Z",
            ...row,
          }));
          rows().push(...stored);
          return { data: stored, error: null };
        }
        let found = rows().filter((row) => matches(row, filters, sets));
        for (const [column] of nullFilters) {
          found = found.filter((row) => row[column] !== null && row[column] !== undefined);
        }
        if (limit !== null) found = found.slice(0, limit);
        return { data: found, error: null };
      };
      const api = {
        select: (columns?: string) => {
          if (columns && columns.includes("discovery_run_id")) touchesLinkColumn = true;
          return api;
        },
        not: (column: string) => {
          nullFilters.push([column]);
          return api;
        },
        eq: (column: string, value: unknown) => {
          filters.push([column, value]);
          return api;
        },
        in: (column: string, values: unknown[]) => {
          sets.push([column, values]);
          return api;
        },
        order: () => api,
        limit: (value: number) => {
          limit = value;
          return api;
        },
        insert: (values: Row | Row[]) => {
          op = "insert";
          payload = Array.isArray(values) ? values : [values];
          if (payload.some((row) => "discovery_run_id" in row)) touchesLinkColumn = true;
          return api;
        },
        upsert: (values: Row | Row[], options?: unknown) => {
          op = "upsert";
          payload = Array.isArray(values) ? values : [values];
          state.lastUpsert = { table, options };
          return api;
        },
        single: async () => {
          const result = exec();
          return {
            data: result.data?.[0] ?? null,
            error: result.error ?? (result.data?.length ? null : { message: "no row" }),
          };
        },
        maybeSingle: async () => {
          const result = exec();
          return { data: result.data?.[0] ?? null, error: result.error };
        },
        then: (resolve: (value: unknown) => unknown) => resolve(exec()),
      };
      return api;
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeClient() }));
vi.mock("@/lib/auth", () => ({
  getCurrentUserAndProfile: vi.fn(async () =>
    state.auth.user
      ? {
          user: state.auth.user,
          profile: { id: state.auth.user.id, account_status: state.auth.accountStatus },
        }
      : { user: null, profile: null },
  ),
}));

import { GET as exportRoute } from "@/app/api/company-discovery/[runId]/export/route";
import { GET as resultsRoute } from "@/app/api/company-discovery/[runId]/results/route";
import {
  createDiscoveryDraft,
  listRecentDiscoveryCampaigns,
} from "@/lib/company-discovery/campaigns";
import {
  getDiscoveryRunStrict,
  listRunCompaniesWithEmails,
  recordCompanyEmail,
} from "@/lib/company-discovery/runs";

const USER_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_ID = "44444444-4444-4444-8444-444444444444";

const RUN_ROW = {
  run_id: RUN_ID,
  user_id: USER_ID,
  params: {
    field: "Marketing / E-Commerce",
    role: "Kaufmann",
    beginn: { mode: "year", year: 2027 },
    goal: "both",
    targetCompanies: 10,
    onlyPublicEmail: true,
  },
  status: "partial",
  target_companies: 10,
  found_companies: 4,
  offers_analyzed: 12,
  unique_companies: 4,
  duplicates_removed: 2,
  companies_rejected: 6,
  sources: [{ id: "arbeitsagentur", status: "ok" }],
  credits_charged: 0,
  error: null,
  created_at: "2026-10-03T10:00:00.000Z",
  started_at: "2026-10-03T10:00:01.000Z",
  finished_at: "2026-10-03T10:00:20.000Z",
  updated_at: "2026-10-03T10:00:20.000Z",
};

function companyRow(overrides: Partial<Row> = {}): Row {
  return {
    id: COMPANY_ID,
    run_id: RUN_ID,
    company_key: "mustermann gmbh",
    company_name: "Mustermann GmbH",
    website_url: null,
    website_source_url: null,
    role: "Kaufmann im E-Commerce",
    field: "Marketing / E-Commerce",
    offer_type: "ausbildung",
    city: "Köln",
    state: "Nordrhein-Westfalen",
    beginn: "2027-08-01",
    salary_label: "1.150 €",
    offer_source: "arbeitsagentur",
    offer_url: "https://www.arbeitsagentur.de/jobsuche/jobdetail/1-S",
    status: "accepted",
    reject_reason: null,
    discovered_at: "2026-10-03T10:00:05.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  state.db = {
    discovery_runs: [{ ...RUN_ROW }],
    discovery_companies: [],
    discovery_company_emails: [],
    email_campaigns: [],
    application_drafts: [],
    application_draft_recipients: [],
    email_accounts: [],
  };
  state.failNext = false;
  state.missingLinkColumn = false;
  state.lastUpsert = null;
  state.auth.user = { id: USER_ID };
  state.auth.accountStatus = "active";
});

// ---------------------------------------------------------------------------
// Saving + reading public emails
// ---------------------------------------------------------------------------

describe("persisting public emails with provenance", () => {
  it("stores the address exactly as published, with its page and type", async () => {
    await recordCompanyEmail(
      COMPANY_ID,
      "bewerbung@mustermann-gmbh.de",
      "https://mustermann-gmbh.de/impressum",
      "impressum",
      "high",
    );
    const row = state.db.discovery_company_emails[0];
    expect(row).toMatchObject({
      company_id: COMPANY_ID,
      email: "bewerbung@mustermann-gmbh.de",
      email_source_url: "https://mustermann-gmbh.de/impressum",
      email_source_type: "impressum",
      confidence: "high",
    });
    expect(state.lastUpsert).toEqual({
      table: "discovery_company_emails",
      options: { onConflict: "company_id,email", ignoreDuplicates: true },
    });
  });

  it("returns each company with its stored addresses, and nothing for a foreign run", async () => {
    state.db.discovery_companies = [
      companyRow(),
      companyRow({ id: "55555555-5555-4555-8555-555555555555", company_key: "ohne ag", company_name: "Ohne AG" }),
    ];
    state.db.discovery_company_emails = [
      {
        company_id: COMPANY_ID,
        email: "bewerbung@mustermann-gmbh.de",
        email_source_url: "https://mustermann-gmbh.de/impressum",
        email_source_type: "impressum",
        confidence: "high",
      },
    ];
    const results = await listRunCompaniesWithEmails(RUN_ID, USER_ID);
    expect(results).toHaveLength(2);
    expect(results[0].emails).toEqual([
      {
        email: "bewerbung@mustermann-gmbh.de",
        sourceUrl: "https://mustermann-gmbh.de/impressum",
        sourceType: "impressum",
        confidence: "high",
      },
    ]);
    // A company without a published address carries an EMPTY list — the UI
    // renders "No public email found" instead of an invented address.
    expect(results[1].emails).toEqual([]);
    // Another user's run id yields nothing.
    expect(await listRunCompaniesWithEmails(RUN_ID, "99999999-9999-4999-8999-999999999999")).toEqual([]);
  });

  it("survives a reload: the run and its results are read back from the database", async () => {
    state.db.discovery_companies = [companyRow()];
    const run = await getDiscoveryRunStrict(RUN_ID, USER_ID);
    expect(run?.runId).toBe(RUN_ID);
    expect(run?.status).toBe("partial");
    expect(run?.progress.foundCompanies).toBe(4);
    const response = await resultsRoute(new Request("http://localhost/x"), {
      params: Promise.resolve({ runId: RUN_ID }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.companies).toHaveLength(1);
    expect(body.companies[0].companyName).toBe("Mustermann GmbH");
  });

  it("reports a database outage instead of an empty result", async () => {
    state.failNext = true;
    const response = await resultsRoute(new Request("http://localhost/x"), {
      params: Promise.resolve({ runId: RUN_ID }),
    });
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.code).toBe("database_not_ready");
    expect(JSON.stringify(body)).not.toContain("PGRST205");
  });
});

// ---------------------------------------------------------------------------
// Campaign bridge
// ---------------------------------------------------------------------------

describe("campaign created from a discovery selection", () => {
  it("persists a draft immediately, linked to the run", async () => {
    state.db.email_accounts = [{ id: ACCOUNT_ID, user_id: USER_ID, is_active: true, created_at: "2026-09-01" }];
    const result = await createDiscoveryDraft({
      userId: USER_ID,
      runId: RUN_ID,
      recipients: [
        { email: "bewerbung@mustermann-gmbh.de", companyName: "Mustermann GmbH" },
        { email: "BEWERBUNG@mustermann-gmbh.de", companyName: "Mustermann GmbH" },
      ],
    });
    expect(result.ok).toBe(true);
    const draft = state.db.application_drafts[0];
    expect(draft).toMatchObject({
      user_id: USER_ID,
      discovery_run_id: RUN_ID,
      sender_email_account_id: ACCOUNT_ID,
      goal: "ausbildung",
    });
    // The duplicate address is collapsed; nothing else is added.
    expect(state.db.application_draft_recipients).toHaveLength(1);
    expect(state.db.application_draft_recipients[0]).toMatchObject({
      draft_id: draft.id,
      email: "bewerbung@mustermann-gmbh.de",
      company_name: "Mustermann GmbH",
      validation_status: "valid",
    });
  });

  it("refuses without an email account and says which code to show", async () => {
    const result = await createDiscoveryDraft({
      userId: USER_ID,
      runId: RUN_ID,
      recipients: [{ email: "bewerbung@mustermann-gmbh.de" }],
    });
    expect(result).toEqual({ ok: false, code: "no_email_account" });
    expect(state.db.application_drafts).toEqual([]);
  });

  it("refuses addresses that are not real published addresses", async () => {
    state.db.email_accounts = [{ id: ACCOUNT_ID, user_id: USER_ID, is_active: true, created_at: "2026-09-01" }];
    const result = await createDiscoveryDraft({
      userId: USER_ID,
      runId: RUN_ID,
      recipients: [{ email: "keine Angabe" }, { email: "" }],
    });
    expect(result).toEqual({ ok: false, code: "invalid_params" });
  });

  it("refuses another user's run", async () => {
    const result = await createDiscoveryDraft({
      userId: "99999999-9999-4999-8999-999999999999",
      runId: RUN_ID,
      recipients: [{ email: "bewerbung@mustermann-gmbh.de" }],
    });
    expect(result).toEqual({ ok: false, code: "not_found" });
  });

  it("lists previous campaigns with their status, counters and run link", async () => {
    state.db.application_drafts = [
      { id: "66666666-6666-4666-8666-666666666666", subject: "Kaufmann E-Commerce — 2027", opportunity_title: null },
    ];
    state.db.email_campaigns = [
      {
        id: "77777777-7777-4777-8777-777777777777",
        user_id: USER_ID,
        draft_id: "66666666-6666-4666-8666-666666666666",
        status: "draft",
        total_recipients: 10,
        sent_count: 0,
        failed_count: 0,
        created_at: "2026-10-02T09:00:00.000Z",
        started_at: null,
        completed_at: null,
        discovery_run_id: RUN_ID,
      },
    ];
    const campaigns = await listRecentDiscoveryCampaigns(USER_ID, 5);
    expect(campaigns).toHaveLength(1);
    expect(campaigns[0]).toMatchObject({
      title: "Kaufmann E-Commerce — 2027",
      status: "draft",
      totalRecipients: 10,
      discoveryRunId: RUN_ID,
      createdAt: "2026-10-02T09:00:00.000Z",
      updatedAt: "2026-10-02T09:00:00.000Z",
    });
  });
});

// ---------------------------------------------------------------------------
// Excel export
// ---------------------------------------------------------------------------

describe("Excel export", () => {
  it("writes the real stored data, one row per company", async () => {
    state.db.discovery_companies = [
      companyRow(),
      companyRow({
        id: "55555555-5555-4555-8555-555555555555",
        company_key: "ohne ag",
        company_name: "Ohne AG",
        city: "Dortmund",
      }),
    ];
    state.db.discovery_company_emails = [
      {
        company_id: COMPANY_ID,
        email: "bewerbung@mustermann-gmbh.de",
        email_source_url: "https://mustermann-gmbh.de/impressum",
        email_source_type: "impressum",
        confidence: "high",
      },
    ];

    const response = await exportRoute(
      new Request(`http://localhost/api/company-discovery/${RUN_ID}/export?lang=ar`),
      { params: Promise.resolve({ runId: RUN_ID }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "spreadsheetml.sheet",
    );
    expect(response.headers.get("content-disposition")).toContain(
      "ausbildung-company-discovery-2027-",
    );

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await response.arrayBuffer());
    const sheet = workbook.getWorksheet("Companies");
    expect(sheet).toBeDefined();
    const headers = (sheet!.getRow(1).values as unknown[]).slice(1);
    expect(headers).toEqual([
      "Company Name",
      "Website",
      "Public Email",
      "Email Source",
      "Role",
      "Field",
      "City",
      "State",
      "Offer Type",
      "Beginn",
      "Salary",
      "Offer Source",
      "Offer URL",
      "Discovery Run ID",
    ]);
    const first = sheet!.getRow(2).values as unknown[];
    expect(first[1]).toBe("Mustermann GmbH");
    expect(first[3]).toBe("bewerbung@mustermann-gmbh.de");
    expect(first[4]).toBe("https://mustermann-gmbh.de/impressum");
    expect(first[14]).toBe(RUN_ID);
    // The company without a published address is labelled, never addressed.
    expect((sheet!.getRow(3).values as unknown[])[3]).toBe(
      "لم يتم العثور على بريد منشور",
    );
  });

  it("does not export companies that were rejected for lack of an address", async () => {
    state.db.discovery_companies = [
      companyRow({ id: "88888888-8888-4888-8888-888888888888", status: "rejected", reject_reason: "no_public_email" }),
    ];
    const response = await exportRoute(
      new Request(`http://localhost/api/company-discovery/${RUN_ID}/export`),
      { params: Promise.resolve({ runId: RUN_ID }) },
    );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await response.arrayBuffer());
    expect(workbook.getWorksheet("Companies")!.rowCount).toBe(1); // header only
  });

  it("requires a session and refuses an unknown run", async () => {
    state.auth.user = null;
    const unauthenticated = await exportRoute(
      new Request("http://localhost/x"),
      { params: Promise.resolve({ runId: RUN_ID }) },
    );
    expect(unauthenticated.status).toBe(401);

    state.auth.user = { id: USER_ID };
    const missing = await exportRoute(
      new Request("http://localhost/x"),
      { params: Promise.resolve({ runId: "00000000-0000-4000-8000-000000000000" }) },
    );
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// The reported failures: campaign not saved / not listed / wrong way back
// ---------------------------------------------------------------------------

const DRAFT_ID = "66666666-6666-4666-8666-666666666666";
const CAMPAIGN_ID = "77777777-7777-4777-8777-777777777777";

function draftRow(overrides: Row = {}): Row {
  return {
    id: DRAFT_ID,
    user_id: USER_ID,
    subject: "Kaufmann E-Commerce — 2027",
    opportunity_title: null,
    created_at: "2026-10-02T09:00:00.000Z",
    updated_at: "2026-10-02T09:05:00.000Z",
    discovery_run_id: RUN_ID,
    ...overrides,
  };
}

function campaignRow(overrides: Row = {}): Row {
  return {
    id: CAMPAIGN_ID,
    user_id: USER_ID,
    draft_id: DRAFT_ID,
    status: "queued",
    total_recipients: 2,
    sent_count: 0,
    failed_count: 0,
    created_at: "2026-10-02T09:30:00.000Z",
    started_at: null,
    completed_at: null,
    discovery_run_id: RUN_ID,
    ...overrides,
  };
}

describe("a database without the link migration (the reported failure)", () => {
  it("still saves the draft AND its recipients, and reports the missing link", async () => {
    state.missingLinkColumn = true;
    state.db.email_accounts = [
      { id: ACCOUNT_ID, user_id: USER_ID, is_active: true, created_at: "2026-09-01" },
    ];
    const result = await createDiscoveryDraft({
      userId: USER_ID,
      runId: RUN_ID,
      recipients: [
        { email: "bewerbung@mustermann-gmbh.de", companyName: "Mustermann GmbH" },
        { email: "kontakt@ohne-ag.de", companyName: "Ohne AG" },
      ],
    });
    // Nothing of the user's work is lost: only the provenance is deferred.
    expect(result).toEqual({ ok: true, draftId: expect.any(String), linked: false });
    expect(state.db.application_drafts).toHaveLength(1);
    expect(state.db.application_drafts[0]).not.toHaveProperty("discovery_run_id");
    expect(state.db.application_draft_recipients).toHaveLength(2);
  });

  it("still lists previous campaigns instead of showing an empty history", async () => {
    state.missingLinkColumn = true;
    state.db.application_drafts = [draftRow()];
    state.db.email_campaigns = [campaignRow()];
    const rows = await listRecentDiscoveryCampaigns(USER_ID, 5);
    expect(rows).toHaveLength(1);
    expect(rows[0].campaignId).toBe(CAMPAIGN_ID);
    expect(rows[0].discoveryRunId).toBeNull();
  });
});

describe("the created campaign is visible immediately and exactly once", () => {
  it("lists a discovery draft that has no campaign yet as a draft", async () => {
    state.db.application_drafts = [draftRow()];
    state.db.application_draft_recipients = [
      { draft_id: DRAFT_ID, email: "bewerbung@mustermann-gmbh.de" },
      { draft_id: DRAFT_ID, email: "kontakt@ohne-ag.de" },
    ];
    const rows = await listRecentDiscoveryCampaigns(USER_ID, 5);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      campaignId: "",
      draftId: DRAFT_ID,
      title: "Kaufmann E-Commerce — 2027",
      status: "draft",
      totalRecipients: 2,
      discoveryRunId: RUN_ID,
    });
  });

  it("lists the sent campaign once — never as a draft duplicate", async () => {
    state.db.application_drafts = [draftRow()];
    state.db.application_draft_recipients = [{ draft_id: DRAFT_ID }];
    state.db.email_campaigns = [campaignRow()];
    const rows = await listRecentDiscoveryCampaigns(USER_ID, 5);
    expect(rows).toHaveLength(1);
    expect(rows[0].campaignId).toBe(CAMPAIGN_ID);
    expect(rows[0].status).toBe("queued");
  });

  it("is idempotent across a refresh: reading twice creates nothing and repeats nothing", async () => {
    state.db.application_drafts = [draftRow()];
    state.db.application_draft_recipients = [{ draft_id: DRAFT_ID }];
    const first = await listRecentDiscoveryCampaigns(USER_ID, 5);
    const second = await listRecentDiscoveryCampaigns(USER_ID, 5);
    expect(second).toEqual(first);
    expect(state.db.application_drafts).toHaveLength(1);
    expect(state.db.email_campaigns).toEqual([]);
  });

  it("ignores drafts that were not built from a discovery run", async () => {
    state.db.application_drafts = [
      draftRow({ id: "88888888-8888-4888-8888-888888888888", discovery_run_id: null }),
    ];
    expect(await listRecentDiscoveryCampaigns(USER_ID, 5)).toEqual([]);
  });
});
