import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateGoal } from "@/lib/application-templates";

/**
 * Praktikum — third application type: templates, goal persistence,
 * campaign compatibility, migration-state gating and UI contracts.
 *
 * The node test environment has no DOM (repo convention), so UI wiring is
 * pinned with source contracts while the backend paths (saveDraft,
 * createCampaign, the enum probe) run REAL code against a store mock that
 * faithfully emulates the Postgres `application_goal` enum: with the
 * migration applied the value is accepted, without it every write of
 * 'praktikum' (and the probe read) fails with an invalid-enum error.
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
    praktikumGoalQueries: number;
    enumHasPraktikum: boolean;
  } = {
    store: {},
    praktikumGoalQueries: 0,
    enumHasPraktikum: true,
  };
  return state;
});

const ENUM_ERR = {
  code: "22P02",
  message: 'invalid input value for enum application_goal: "praktikum"',
};

const COLUMNS_WITH_COLUMN = new Set([
  "application_draft_recipients",
  "email_messages",
]);
let insertSeq = 0;

function makeChain(table: string) {
  const filters: Array<(row: Row) => boolean> = [];
  let selectCols: string | null = null;
  let deleteMode = false;
  let updatePatch: Row | null = null;
  let enumViolation = false;
  const all = () =>
    (H.store[table] ?? []).filter((row) => filters.every((f) => f(row)));
  const project = (row: Row): Row =>
    selectCols === null || selectCols.includes("*")
      ? row
      : Object.fromEntries(
          Object.entries(row).filter(([k]) =>
            selectCols!.split(",").map((c) => c.trim()).includes(k),
          ),
        );
  const columnMissing = () =>
    COLUMNS_WITH_COLUMN.has(table) &&
    selectCols !== null &&
    selectCols.split(",").map((c) => c.trim()).includes("contact_name");
  const chain: Record<string | symbol, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (typeof prop !== "string") return undefined;
      switch (prop) {
        case "select":
          return (cols: string) => {
            selectCols = cols;
            return chain;
          };
        case "eq":
          return (col: string, value: unknown) => {
            if (col === "goal" && value === "praktikum") {
              H.praktikumGoalQueries += 1;
              if (!H.enumHasPraktikum) enumViolation = true;
            }
            filters.push((row) => row[col] === value);
            return chain;
          };
        case "in":
          return (col: string, vals: unknown[]) => {
            filters.push((row) => vals.includes(row[col]));
            return chain;
          };
        case "lt":
          return (col: string, value: unknown) => {
            filters.push((row) => String(row[col] ?? "") < String(value));
            return chain;
          };
        case "order":
        case "limit":
          return () => chain;
        case "single":
          return async () => {
            if (enumViolation) return { data: null, error: ENUM_ERR };
            if (columnMissing())
              return { data: null, error: { code: "PGRST204" } };
            const row = all()[0];
            return row
              ? { data: project(row), error: null }
              : { data: null, error: { message: "PGRST116: no rows" } };
          };
        case "maybeSingle":
          return async () => {
            if (enumViolation) return { data: null, error: ENUM_ERR };
            return { data: all()[0] ? project(all()[0]) : null, error: null };
          };
        case "insert":
          return (payload: Row | Row[]) => {
            const rows = (Array.isArray(payload) ? payload : [payload]).map(
              (row) => (row.id ? row : { ...row, id: `gen-${++insertSeq}` }),
            );
            const violation =
              (table === "application_drafts" ||
                table === "application_draft_recipients") &&
              rows.some((row) => row.goal === "praktikum" && !H.enumHasPraktikum);
            if (
              (table === "application_drafts" &&
                rows.some(
                  (row) =>
                    row.goal === "praktikum" && !H.enumHasPraktikum,
                )) ||
              violation
            ) {
              const result: Record<string | symbol, unknown> = {
                select: () => ({ single: async () => ({ data: null, error: ENUM_ERR }) }),
              };
              result.then = (onF?: unknown, onR?: unknown) =>
                Promise.resolve({ data: null, error: ENUM_ERR }).then(
                  onF as never,
                  onR as never,
                );
              return result;
            }
            (H.store[table] ??= []).push(...rows);
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
            updatePatch = patch;
            return chain;
          };
        case "then":
          return (onF?: unknown, onR?: unknown) => {
            if (deleteMode) {
              const matched = all();
              const list = H.store[table] ?? [];
              for (let i = list.length - 1; i >= 0; i -= 1)
                if (matched.includes(list[i])) list.splice(i, 1);
              return Promise.resolve({ data: null, error: null }).then(
                onF as never,
                onR as never,
              );
            }
            if (updatePatch !== null) {
              const violation =
                updatePatch.goal === "praktikum" && !H.enumHasPraktikum;
              if (violation)
                return Promise.resolve({ data: null, error: ENUM_ERR }).then(
                  onF as never,
                  onR as never,
                );
              for (const row of all()) Object.assign(row, updatePatch);
              return Promise.resolve({ data: all(), error: null }).then(
                onF as never,
                onR as never,
              );
            }
            if (enumViolation)
              return Promise.resolve({ data: null, error: ENUM_ERR }).then(
                onF as never,
                onR as never,
              );
            if (columnMissing())
              return Promise.resolve({ data: null, error: { code: "PGRST204" } }).then(
                onF as never,
                onR as never,
              );
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

// (the mock rpc needs no arguments — only the function name matters)
const rpc = async (
  name: string,
): Promise<{ data: unknown; error: null }> => {
  switch (name) {
    case "reserve_sender_slot":
      return { data: { reserved: true, wait_ms: 0 }, error: null };
    case "get_sender_slot_wait_ms":
      return { data: 0, error: null };
    case "reserve_email_capacity":
    case "get_daily_usage_snapshot":
      return { data: USAGE, error: null };
    default:
      return { data: null, error: null };
  }
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => makeChain(table),
    rpc: (name: string) => rpc(name),
    storage: { from: () => ({ remove: async () => undefined }) },
  }),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUserAndProfile: async () => ({
    user: { id: USER_ID, email: "u@example.test" },
    profile: { id: USER_ID, account_status: "active" },
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => undefined) }));

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

const { saveDraft } = await import("@/app/applications/new/actions");
const { createCampaign } = await import("@/lib/email-campaigns");
const {
  supportsPraktikumGoal,
  resetPraktikumProbe,
  resetContactNameProbe,
} = await import("@/lib/contact-name-support");
const { applicationTemplates } = await import("@/lib/application-templates");
const {
  renderPersonalizedMessage,
  GREETING_FALLBACK,
} = await import("@/lib/personalization");

const NOW = "2026-10-01T09:00:00Z";

function seedDraft(goal: "ausbildung" | "arbeit" | "praktikum") {
  H.store["application_drafts"] = [
    {
      id: "draft-1",
      user_id: USER_ID,
      goal,
      sender_email_account_id: ACC,
      subject: "Bewerbung bei {{company_name}}",
      body_html: "<p>{{greeting}}</p><p>bei {{company_name}}</p>",
      body_text: "{{greeting}} bei {{company_name}}",
      opportunity_title: null,
      created_at: NOW,
      updated_at: NOW,
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
      created_at: NOW,
    },
  ];
}

beforeEach(() => {
  H.store = {};
  H.praktikumGoalQueries = 0;
  H.enumHasPraktikum = true;
  resetPraktikumProbe();
  resetContactNameProbe();
});

describe("enum probe (migration state)", () => {
  it("detects the praktikum value when the migration is applied", async () => {
    seedDraft("ausbildung");
    expect(await supportsPraktikumGoal()).toBe(true);
  });

  it("reports unsupported when the enum lacks the value (cached, one probe)", async () => {
    H.enumHasPraktikum = false;
    seedDraft("ausbildung");
    expect(await supportsPraktikumGoal()).toBe(false);
    expect(await supportsPraktikumGoal()).toBe(false);
    // Cached: three consumers → exactly one enum probe query.
    expect(H.praktikumGoalQueries).toBe(1);
  });
});

describe("draft persistence of the goal", () => {
  it("saveDraft persists goal=praktikum with the migration applied", async () => {
    seedDraft("ausbildung");
    await saveDraft({
      draftId: "draft-1",
      goal: "praktikum",
      senderAccountId: ACC,
      subject: "Bewerbung um ein Praktikum bei {{company_name}}",
      bodyHtml: "<p>{{greeting}}</p>",
      recipients: [
        {
          email: "bewerbung@carrier.de",
          companyName: null,
          contactName: null,
          status: "valid",
        },
      ],
    });
    expect(H.store["application_drafts"][0].goal).toBe("praktikum");
    expect(H.store["application_drafts"][0].subject).toBe(
      "Bewerbung um ein Praktikum bei {{company_name}}",
    );
  });

  it("with the migration unapplied, a praktikum save fails clearly (DB rejects the enum value)", async () => {
    H.enumHasPraktikum = false;
    seedDraft("ausbildung");
    await expect(
      saveDraft({
        draftId: "draft-1",
        goal: "praktikum",
        senderAccountId: ACC,
        subject: "x",
        bodyHtml: "<p>y</p>",
        recipients: [],
      }),
    ).rejects.toThrow(/draft/i);
    // The existing goal is untouched.
    expect(H.store["application_drafts"][0].goal).toBe("ausbildung");
  });
});

describe("campaign creation with the new type", () => {
  it("createCampaign works for goal=praktikum (migration applied)", async () => {
    seedDraft("praktikum");
    const created = await createCampaign({
      draftId: "draft-1",
      senderAccountId: ACC,
      goal: "praktikum",
      recipientEmails: [],
    });
    const messages = H.store["email_messages"].filter(
      (row) => row.campaign_id === created.campaignId,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].status).toBe("queued");
    expect(messages[0].recipient_email).toBe("bewerbung@carrier.de");
  });

  it("all three goals create campaigns the same way", async () => {
    for (const goal of ["ausbildung", "arbeit", "praktikum"] as const) {
      H.store = {};
      seedDraft(goal);
      resetPraktikumProbe();
      resetContactNameProbe();
      const created = await createCampaign({
        draftId: "draft-1",
        senderAccountId: ACC,
        goal,
        recipientEmails: [],
      });
      expect(H.store["email_campaigns"].some((c) => c.id === created.campaignId)).toBe(
        true,
      );
    }
  });
});

describe("templates", () => {
  const GOALS = Object.keys(applicationTemplates) as TemplateGoal[];

  it("exactly the three professional German templates exist", () => {
    expect(GOALS.sort()).toEqual(["arbeit", "ausbildung", "praktikum"]);
    for (const goal of GOALS) {
      const template = applicationTemplates[goal];
      expect(template.subject.length).toBeGreaterThan(0);
      expect(template.body).toContain("bewerbe ich mich");
      expect(template.body).toContain("Mit freundlichen Grüßen");
      expect(template.body).toContain("Mustapha Drif");
      expect(template.body).toContain("persönlichen Gespräch");
    }
    // Distinct content — no copy-paste template.
    const subjects = GOALS.map((g) => applicationTemplates[g].subject);
    const bodies = GOALS.map((g) => applicationTemplates[g].body);
    expect(new Set(subjects).size).toBe(3);
    expect(new Set(bodies).size).toBe(3);
    // Type-specific core wording.
    expect(applicationTemplates.ausbildung.subject).toContain("Ausbildungsplatz");
    expect(applicationTemplates.ausbildung.body).toContain("Ausbildungsplatz");
    expect(applicationTemplates.arbeit.subject).toBe(
      "Bewerbung bei {{company_name}}",
    );
    expect(applicationTemplates.arbeit.body).toContain("berufliche Möglichkeit");
    expect(applicationTemplates.praktikum.subject).toContain("Praktikum");
    expect(applicationTemplates.praktikum.body).toContain("Praktikum");
    expect(applicationTemplates.praktikum.body).toContain("Berufsalltag");
  });

  it("only the supported personalization tokens are used", () => {
    for (const goal of GOALS) {
      const template = applicationTemplates[goal];
      const all = template.subject + template.body;
      expect(all).toContain("{{greeting}}");
      expect(all).toContain("{{company_name}}");
      const tokens = all.match(/\{\{[^}]*\}\}/g) ?? [];
      for (const token of tokens) {
        expect(["{{greeting}}", "{{company_name}}", "{{contact_name}}"]).toContain(
          token,
        );
      }
    }
  });

  it("no unsupported bracket placeholders or invented specifics", () => {
    for (const goal of GOALS) {
      const all =
        applicationTemplates[goal].subject + applicationTemplates[goal].body;
      // [Position], [Branche], [Qualifikation], … must not appear.
      expect(all).not.toMatch(/\[[A-Za-zÄÖÜäöüß]{2,}\]/);
      // No invented dates, durations or degree claims.
      expect(all).not.toMatch(/\b\d{1,2}\.\s*\d{1,2}\.\s*\d{2,4}\b/);
      expect(all).not.toMatch(/(3|6|12)\s+Monaten?/i);
      expect(all).not.toMatch(/Pflichtpraktikum|BA\b|MA\b|B\. ?Sc\.|Master/i);
    }
  });

  it("company fallback keeps every sentence grammatical", () => {
    for (const goal of GOALS) {
      const template = applicationTemplates[goal];
      const rendered = renderPersonalizedMessage(
        { subject: template.subject, bodyHtml: template.body, bodyText: "" },
        { email: "me@gmail.com" }, // free provider → fallback
      );
      expect(rendered.subject).toContain("bei Ihrem Unternehmen");
      expect(rendered.bodyHtml).toContain("bei Ihrem Unternehmen");
      expect(rendered.subject).not.toMatch(/\{\{\s*\w+\s*\}\}/);
      expect(rendered.bodyHtml).not.toMatch(/\{\{\s*\w+\s*\}\}/);
    }
  });

  it("unknown contact → the standard formal greeting; verified contact → personalized", () => {
    for (const goal of GOALS) {
      const template = applicationTemplates[goal];
      const generic = renderPersonalizedMessage(
        { subject: template.subject, bodyHtml: template.body, bodyText: "" },
        { email: "jobs@bmw.de" },
      );
      expect(generic.bodyHtml).toContain(GREETING_FALLBACK);
      expect(generic.bodyHtml).not.toContain("{{");
      const personal = renderPersonalizedMessage(
        { subject: template.subject, bodyHtml: template.body, bodyText: "" },
        { email: "jobs@bmw.de", contactName: "Frau Dr. Schulz" },
      );
      expect(personal.bodyHtml).toContain("Sehr geehrte Frau Dr. Schulz,");
      expect(personal.bodyHtml).toContain("bei BMW");
    }
  });

  it("recipients render independently (no cross-recipient leakage)", () => {
    const template = applicationTemplates.praktikum;
    const carrier = renderPersonalizedMessage(
      { subject: template.subject, bodyHtml: template.body, bodyText: "" },
      { email: "bewerbung@carrier.de" },
    );
    const bosch = renderPersonalizedMessage(
      { subject: template.subject, bodyHtml: template.body, bodyText: "" },
      { email: "info@bosch.de", contactName: "Herr Mustermann" },
    );
    expect(carrier.subject).toContain("Carrier");
    expect(bosch.subject).toContain("Bosch");
    expect(`${carrier.subject} ${carrier.bodyHtml}`).not.toContain("Bosch");
    expect(`${carrier.subject} ${carrier.bodyHtml}`).not.toContain("Mustermann");
    expect(`${bosch.subject} ${bosch.bodyHtml}`).not.toContain("Carrier");
    expect(bosch.bodyHtml).toContain("Sehr geehrter Herr Mustermann,");
  });
});

describe("composer UI wiring (source contracts)", () => {
  const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/+$/, "");
  const COMPOSER = readFileSync(
    `${root}/src/components/application-composer.tsx`,
    "utf8",
  );
  const PAGE = readFileSync(
    `${root}/src/app/applications/new/page.tsx`,
    "utf8",
  );
  const ACTIONS = readFileSync(
    `${root}/src/app/applications/new/send-action.ts`,
    "utf8",
  );
  const SCHEDULE = readFileSync(
    `${root}/src/app/applications/new/schedule-action.ts`,
    "utf8",
  );

  it("the selector offers all three types when supported, gated by the probe", () => {
    expect(COMPOSER).toContain('{ value: "praktikum" as const, label: "Praktikum" }');
    // The third option only exists while the enum supports it.
    expect(COMPOSER).toMatch(/praktikumOn[\s\S]{0,120}\{ value: "praktikum"/);
    // Three options → three equal columns (responsive, same control style).
    expect(COMPOSER).toContain("goalOptions.length === 3 ? \"grid-cols-3\" : \"grid-cols-2\"");
    // The template panel offers the Praktikum template, same gate.
    expect(COMPOSER).toMatch(/praktikumOn && \([\s\S]{0,400}?Praktikum Bewerbung/);
    // The page passes the server probe result.
    expect(PAGE).toContain("await supportsPraktikumGoal()");
    expect(PAGE).toContain("praktikumSupported={praktikumSupported}");
  });

  it("both server actions accept all three goals (and reject anything else)", () => {
    for (const source of [ACTIONS, SCHEDULE]) {
      expect(source).toMatch(
        /goal !== "ausbildung" && goal !== "arbeit" && goal !== "praktikum"/,
      );
      expect(source).toContain("Invalid application goal.");
    }
  });

  it("selecting a template never sends (fills the editable draft only)", () => {
    const start = COMPOSER.indexOf("const applyTemplate = (templateGoal");
    expect(start).toBeGreaterThan(-1);
    const body = COMPOSER.slice(start, COMPOSER.indexOf("};", start));
    expect(body).toContain("setGoal(templateGoal)");
    expect(body).toContain("setSubject(applicationTemplates[templateGoal].subject)");
    expect(body).toContain("setBody(applicationTemplates[templateGoal].body)");
    // No server action, no await, no network.
    expect(body).not.toContain("await");
    expect(body).not.toContain("sendApplications");
    expect(body).not.toContain("scheduleApplications");
    // An unsupported praktikum goal is never set (button hidden anyway).
    expect(body).toMatch(/templateGoal === "praktikum" && !praktikumOn/);
  });
});
