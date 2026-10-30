/**
 * AUTO BEWERB — Step 6: ONE global e-mail configuration for the whole batch.
 *
 * Every company receives the EXACT SAME recipient (unless the user sets an
 * explicit global one), subject, body (sent VERBATIM — no substitution),
 * sending account and attachment flags. The only per-company value is the
 * delivery destination: the verified application email of each company's
 * ad (legacy manual value preserved).
 *
 * Pinned here (real engine, in-memory DB, sends SCHEDULED — no dispatch,
 * no real email):
 *   1. one template applied to 3 companies → identical subject/body/
 *      account/attachments, per-company verified recipients;
 *   2. legacy per-company values (incl. the old email_body override) can
 *      NEVER override the global configuration;
 *   3. a newly added company uses the global configuration automatically;
 *   4. an explicit global recipient is used for ALL companies;
 *   5. scheduled sends carry the same global configuration;
 *   6. source contracts: no token substitution, no per-company override
 *      path anywhere (Step 6 UI, Step 7 review, actions, engine);
 *   7. the AI prompt generates a company-neutral template (no tokens);
 *   8. the generate-email route stays global + metered.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioDb } from "./helpers-studio";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/ai-service", () => ({ provider: vi.fn() }));
vi.mock("@/lib/billing/entitlement-service", () => ({
  reserveFeatureOp: vi.fn(),
  completeFeatureOp: vi.fn(),
  releaseFeatureOp: vi.fn(),
}));
vi.mock("@/lib/rate-limit", async () => {
  const { NextResponse } = await import("next/server");
  return {
    checkRateLimit: vi.fn(),
    rateLimitHeaders: vi.fn(() => ({})),
    tooManyRequests: vi.fn(() => NextResponse.json({ error: "RATE_LIMITED_MARKER" }, { status: 429 })),
  };
});
vi.mock("@/lib/email-providers", () => ({ createEmailProvider: vi.fn() }));
// PARTIAL engine mock: the REAL send engine is under test (fake DB); only the
// profile getter is faked (it serves the route's prompt context).
vi.mock("@/lib/auto-bewerb/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auto-bewerb/engine")>();
  return { ...actual, getAutoBewerbProfile: vi.fn() };
});

const { createAdminClient } = await import("@/lib/supabase/admin");
const { createClient } = await import("@/lib/supabase/server");
const { provider } = await import("@/lib/ai-service");
const { reserveFeatureOp, completeFeatureOp, releaseFeatureOp } = await import("@/lib/billing/entitlement-service");
const { checkRateLimit } = await import("@/lib/rate-limit");
const { getAutoBewerbProfile, prepareAutoBewerbSend } = await import("@/lib/auto-bewerb/engine");
const { POST } = await import("@/app/api/auto-bewerb/generate-email/route");
const { createStudioDb } = await import("./helpers-studio");
const { buildAutoBewerbEmailTemplatePrompt } = await import("@/lib/auto-bewerb/prompts");
const { resolveAutoBewerbRecipient } = await import("@/lib/auto-bewerb/schema");

const read = (p: string) => readFileSync(p, "utf8");
const STEP6 = read("src/components/auto-bewerb/step6-email.tsx");
const STEP7 = read("src/components/auto-bewerb/step7-review.tsx");
const ACTIONS = read("src/app/auto-bewerb/actions.ts");
const ENGINE = read("src/lib/auto-bewerb/engine.ts");
const SCHEMA = read("src/lib/auto-bewerb/schema.ts");
const DICT = read("src/lib/i18n/dictionaries.ts");

// ---------------------------------------------------------------------------
// Fake-DB functional tests (global mode — settings columns present)
// ---------------------------------------------------------------------------

const USER = "11111111-1111-4111-8111-111111111111";
const ACCT_ID = "33333333-3333-4333-8333-333333333333";
const CO1 = "44444444-4444-4444-8444-444444444444";
const CO2 = "55555555-5555-4555-8555-555555555555";
const CO3 = "66666666-6666-4666-8666-666666666666";
const CO_NEW = "99990000-1111-2222-3333-444455556666";
const D1 = "77777777-7777-4777-8777-777777777777";

const GLOBAL_BODY =
  "Sehr geehrte Damen und Herren,\n\nhiermit bewerbe ich mich um eine Ausbildungsstelle. Anbei erhalten Sie meinen Lebenslauf und mein Anschreiben als PDF.\n\nMit freundlichen Grüßen\nMustapha Drif";
const GLOBAL_SUBJECT = "Bewerbung um eine Ausbildungsstelle";

/** Far-future schedule → durable attempt, never dispatched (no real email). */
const FUTURE = { timeZone: "Europe/Berlin", year: 2030, month: 6, day: 10, hour: 9, minute: 0 };

function extractFor(company: string, applicationEmail: string, jobTitle: string) {
  return {
    jobTitle,
    occupation: jobTitle,
    company,
    companyAddress: "",
    location: "",
    startDate: "",
    // NOTE: adExtractSchema types this as a STRING (default "") — null would
    // fail re-validation on read and silently null out the whole extract.
    applicationDeadline: "",
    requiredQualifications: [],
    preferredQualifications: [],
    technicalSkills: [],
    softSkills: [],
    languageRequirements: [],
    educationRequirement: "",
    responsibilities: [],
    requestedDocuments: [],
    applicationMethod: "",
    contactPerson: "",
    applicationEmail,
    companyNotes: [],
    missingOrAmbiguous: [],
  };
}

function companyRow(id: string, company: string, email: string, job: string, over: Record<string, unknown> = {}) {
  return {
    id,
    user_id: USER,
    company,
    company_key: company.toLowerCase().replace(/[^a-z0-9]+/g, " "),
    slot_no: 1,
    ad_raw: "x".repeat(40),
    ad_extracted: extractFor(company, email, job),
    ad_analysis: null,
    profile_snapshot: null,
    status: "ready" as const,
    // LEGACY per-company values — deliberately different from the global
    // configuration: none of them may win over the global settings.
    recipient_email: "legacy-" + email,
    email_subject: "Legacy-Betreff",
    email_body: "LEGACY OVERRIDETEXT — must never be sent",
    email_attach_cv: true,
    email_attach_letter: true,
    email_account_id: "00000000-0000-4000-8000-000000000000",
    idempotency_key: null,
    approved: true,
    approved_at: "2026-12-01T10:00:00.000Z",
    scheduled_at: null,
    schedule_timezone: null,
    sent_at: null,
    provider_message_id: null,
    last_failure_code: null,
    ad_confirmed_at: "2026-12-01T10:00:00.000Z",
    cv_reviewed_at: null,
    letter_reviewed_at: null,
    created_at: "2026-12-01T00:00:00.000Z",
    updated_at: "2026-12-01T00:00:00.000Z",
    ...over,
  };
}

let db: StudioDb;

function seed(template: Record<string, unknown>) {
  db = createStudioDb({
    auto_bewerb_profiles: [],
    auto_bewerb_companies: [
      companyRow(CO1, "Kältebau Nord GmbH", "jobs@kaltbau-nord.de", "Anlagenmechaniker SHK"),
      companyRow(CO2, "Tech Süd AG", "bewerbung@tech-sued.de", "Fachinformatiker"),
      companyRow(CO3, "Heizungsbau Ost GmbH", "hr@heizung-ost.de", "Anlagenmechaniker SHK"),
    ],
    auto_bewerb_documents: [],
    auto_bewerb_attachments: [
      {
        id: D1,
        user_id: USER,
        display_name: "Abiturzeugnis.pdf",
        doc_category: "school_certificate",
        mime_type: "application/pdf",
        size_bytes: 1024,
        storage_path: `${USER}/auto-bewerb/docs/${D1}.pdf`,
        file_hash: "h1",
        created_at: "2026-12-01T00:00:00.000Z",
        updated_at: "2026-12-01T00:00:00.000Z",
      },
    ],
    auto_bewerb_company_attachments: [],
    auto_bewerb_email_templates: [{ user_id: USER, ...template }],
    auto_bewerb_send_attempts: [],
    email_accounts: [{ id: ACCT_ID, user_id: USER, provider: "gmail", email: "mail@example.de", is_active: true, requires_reconnect: false }],
    activity_logs: [],
    profiles: [],
  });
  (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
}

function globalTemplate(over: Record<string, unknown> = {}) {
  return {
    body: GLOBAL_BODY,
    recipient: "",
    subject: GLOBAL_SUBJECT,
    account_id: ACCT_ID,
    attach_cv: false,
    attach_letter: false,
    ...over,
  };
}

function attempt(companyId: string) {
  const a = db.tables.auto_bewerb_send_attempts.find((r) => r.company_id === companyId) as
    | { payload: { text: string; html: string; attachments: Array<{ filename: string }> }; recipient_email: string; subject: string; scheduled_at: string | null }
    | undefined;
  expect(a, `attempt for ${companyId}`).toBeTruthy();
  return a!;
}

describe("one global configuration — functional (engine, fake DB, scheduled)", () => {
  it("3 companies (no manual recipient) → IDENTICAL subject/body/account; each keeps its VERIFIED ad address", async () => {
    seed(globalTemplate());
    // No manually stored recipient → the destination falls back to each
    // company's verified application email from its own ad:
    for (const r of db.tables.auto_bewerb_companies) r.recipient_email = null;
    for (const id of [CO1, CO2, CO3]) {
      const res = await prepareAutoBewerbSend(USER, { companyId: id, schedule: FUTURE });
      expect(res.ok, JSON.stringify(res)).toBe(true);
    }
    const a1 = attempt(CO1);
    const a2 = attempt(CO2);
    const a3 = attempt(CO3);
    // Identical shared content for everyone:
    expect(a1.payload.text).toBe(GLOBAL_BODY);
    expect(a2.payload.text).toBe(GLOBAL_BODY);
    expect(a3.payload.text).toBe(GLOBAL_BODY);
    expect(a1.subject).toBe(GLOBAL_SUBJECT);
    expect(a2.subject).toBe(GLOBAL_SUBJECT);
    expect(a3.subject).toBe(GLOBAL_SUBJECT);
    // The VERIFIED per-company delivery destination (from each ad):
    expect(a1.recipient_email).toBe("jobs@kaltbau-nord.de");
    expect(a2.recipient_email).toBe("bewerbung@tech-sued.de");
    expect(a3.recipient_email).toBe("hr@heizung-ost.de");
    // NEVER to one company's address:
    expect(a2.recipient_email).not.toBe(a1.recipient_email);
    // Shared attachment settings (global flags off → only the library doc):
    for (const a of [a1, a2, a3]) {
      expect(a.payload.attachments.map((x) => x.filename)).toEqual(["Abiturzeugnis.pdf"]);
    }
  });

  it("legacy per-company CONFIG values (subject/account/override) NEVER win over the global config", async () => {
    seed(globalTemplate());
    // The row carries legacy values (incl. a stored body override):
    expect(db.tables.auto_bewerb_companies[0].email_body).toBe("LEGACY OVERRIDETEXT — must never be sent");
    const res = await prepareAutoBewerbSend(USER, { companyId: CO1, schedule: FUTURE });
    expect(res.ok).toBe(true);
    const a = attempt(CO1);
    // Global content wins over every legacy config value:
    expect(a.subject).toBe(GLOBAL_SUBJECT);
    expect(a.subject).not.toBe("Legacy-Betreff");
    expect(a.payload.text).toBe(GLOBAL_BODY);
    expect(a.payload.text).not.toContain("LEGACY OVERRIDETEXT");
    // But the legacy recipient is a preserved per-company DELIVERY
    // destination (user-entered earlier) — it is honored, never overwritten:
    expect(a.recipient_email).toBe("legacy-jobs@kaltbau-nord.de");
    // The legacy override column is cleared on send preparation:
    const row = db.tables.auto_bewerb_companies.find((r) => r.id === CO1);
    expect(row?.email_body).toBeNull();
  });

  it("an EXPLICIT global recipient is delivered to ALL companies", async () => {
    seed(globalTemplate({ recipient: " Zentral@Postbox.de " }));
    for (const id of [CO1, CO2, CO3]) {
      const res = await prepareAutoBewerbSend(USER, { companyId: id, schedule: FUTURE });
      expect(res.ok).toBe(true);
    }
    for (const id of [CO1, CO2, CO3]) {
      expect(attempt(id).recipient_email).toBe("zentral@postbox.de");
    }
  });

  it("a NEWLY ADDED company uses the global configuration automatically", async () => {
    seed(globalTemplate());
    // The company joins AFTER the configuration was saved (no manual
    // recipient → its verified ad address is the destination):
    db.tables.auto_bewerb_companies.push(
      companyRow(CO_NEW, "Neu GmbH", "neu@neu-gmbh.de", "Elektroniker", { recipient_email: null }),
    );
    const res = await prepareAutoBewerbSend(USER, { companyId: CO_NEW, schedule: FUTURE });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const a = attempt(CO_NEW);
    expect(a.payload.text).toBe(GLOBAL_BODY);
    expect(a.subject).toBe(GLOBAL_SUBJECT);
    expect(a.recipient_email).toBe("neu@neu-gmbh.de");
  });

  it("a company WITHOUT any verifiable address is refused (nothing invented)", async () => {
    seed(globalTemplate());
    db.tables.auto_bewerb_companies.push(companyRow(CO_NEW, "OhneMail GmbH", "", "Elektroniker", { recipient_email: null }));
    const res = await prepareAutoBewerbSend(USER, { companyId: CO_NEW, schedule: FUTURE });
    expect(res.ok).toBe(false);
    expect((res as { code?: string }).code).toBe("invalid_recipient");
  });

  it("SCHEDULED sends carry the same global configuration (no separate path)", async () => {
    seed(globalTemplate());
    const res = await prepareAutoBewerbSend(USER, { companyId: CO2, schedule: FUTURE });
    expect(res.ok).toBe(true);
    const a = attempt(CO2);
    expect(a.scheduled_at).toBeTruthy();
    expect(a.payload.text).toBe(GLOBAL_BODY);
    expect(a.subject).toBe(GLOBAL_SUBJECT);
  });
});

// ---------------------------------------------------------------------------
// Pure recipient resolution — one global setting, N companies
// ---------------------------------------------------------------------------

describe("resolveAutoBewerbRecipient (pure)", () => {
  it("5 and 10 companies resolve deterministically — verified address per company", () => {
    const emails = Array.from({ length: 10 }, (_, i) => `a${i + 1}@firma-${i + 1}.de`);
    const resolved = emails.map((e) => resolveAutoBewerbRecipient("", null, extractFor("X", e, "Y")));
    expect(new Set(resolved).size).toBe(10);
    expect(resolved.slice(0, 5)).toEqual(emails.slice(0, 5));
  });
  it("a set global recipient → the same destination for all 10", () => {
    const resolved = Array.from({ length: 10 }, (_, i) =>
      resolveAutoBewerbRecipient("all@one.de", `legacy${i}@x.de`, extractFor("X", `a${i}@b.de`, "Y")),
    );
    expect(new Set(resolved).size).toBe(1);
    expect(resolved[0]).toBe("all@one.de");
  });
});

// ---------------------------------------------------------------------------
// Source contracts — exactly ONE source of truth, no substitution
// ---------------------------------------------------------------------------

describe("single global configuration (source contracts)", () => {
  it("the engine resolves EVERYTHING from the global settings (no client/company override)", () => {
    expect(ENGINE).toContain("const settings = await getAutoBewerbEmailSettings(userId);");
    expect(ENGINE).toContain("resolveAutoBewerbRecipient(settings.recipient, app.recipient_email, app.ad_extracted)");
    expect(ENGINE).toContain("subject = settings.subject.trim().slice(0, 200);");
    expect(ENGINE).toContain("accountId = settings.accountId;");
    expect(ENGINE).toContain("attachCv = settings.attachCv;");
    expect(ENGINE).toContain("attachLetter = settings.attachLetter;");
    // The legacy column is only ever written as null (never read):
    expect(ENGINE).toContain("email_body: null,");
    expect(ENGINE).not.toContain("app.email_body");
    // No per-company settings can come from the client:
    expect(ENGINE).not.toContain("input.recipientEmail");
    expect(ENGINE).not.toContain("input.emailAccountId");
    expect(ENGINE).not.toContain("input.subject");
    expect(ENGINE).not.toContain("input.attachCv");
    expect(ENGINE).not.toContain("bodyOverride");
    // No token substitution anywhere in the send path:
    expect(ENGINE).not.toContain("renderAutoBewerbEmailBody");
  });

  it("the schema no longer offers a token renderer or token list", () => {
    expect(SCHEMA).not.toContain("renderAutoBewerbEmailBody");
    expect(SCHEMA).not.toContain("AUTO_BEWERB_EMAIL_TOKENS");
    expect(SCHEMA).toContain("export function resolveAutoBewerbRecipient");
  });

  it("Step 6 UI: one global configuration + one Save; no token chips; legacy mode is read-only", () => {
    expect(STEP6).toContain("saveEmailSettingsAction");
    expect(STEP6).toContain("resolveAutoBewerbRecipient");
    expect(STEP6).toContain("ws.emailSettingsSupported");
    expect(STEP6).not.toContain("AUTO_BEWERB_EMAIL_TOKENS");
    expect(STEP6).not.toContain("renderAutoBewerbEmailBody");
    expect(STEP6).not.toContain("updateCompanyAction"); // no per-company email save path
    // The body is previewed verbatim (the template text itself):
    expect(STEP6).toContain("{templateText || t(\"autoBewerb.templateEmptyNote\")}");
  });

  it("Step 7: inputs are company ids + confirmation only; the modal shows the exact shared config + per-company destination", () => {
    expect(STEP7).toContain("selectedViews.map((v) => ({ companyId: v.company.id, confirmed: true }))");
    expect(STEP7).not.toContain("recipientEmail");
    expect(STEP7).not.toContain("emailAccountId");
    expect(STEP7).not.toContain("renderAutoBewerbEmailBody");
    // The confirmation shows the shared body VERBATIM + the resolved destination:
    expect(STEP7).toContain("resolveAutoBewerbRecipient(s.recipient, r.recipient_email, r.ad_extracted)");
    expect(STEP7).toContain("t(\"autoBewerb.globalPreviewTitle\")");
    expect(STEP7).toContain("t(\"autoBewerb.previewCount\"");
  });

  it("server actions: no per-company e-mail fields anywhere", () => {
    expect(ACTIONS).not.toContain("bodyOverride");
    expect(ACTIONS).not.toContain("emailBody");
    expect(ACTIONS).not.toContain("recipientEmail");
    expect(ACTIONS).not.toContain("emailAccountId");
    expect(ACTIONS).toContain("saveEmailSettingsAction");
    // Both the immediate and the scheduled path pass only companyId (+ schedule):
    expect(ACTIONS).toContain("companyId: input.companyId,\n      schedule: input.schedule ?? null,");
  });

  it("the i18n dictionaries have no token keys and document the global configuration", () => {
    expect(DICT).not.toContain("tokenCompany");
    expect(DICT).not.toContain("tokenPosition");
    expect(DICT).not.toContain("tokenContact");
    expect(DICT).toContain("emailSettingsTitle");
    expect(DICT).toContain("globalRecipientHint");
    expect(DICT).toContain("deliveryListTitle");
  });
});

// ---------------------------------------------------------------------------
// AI prompt — company-neutral, no tokens
// ---------------------------------------------------------------------------

describe("buildAutoBewerbEmailTemplatePrompt (company-neutral, no tokens)", () => {
  it("forbids tokens and company names — the text is sent UNCHANGED to everyone", () => {
    const p = buildAutoBewerbEmailTemplatePrompt({ sharedAttachmentNames: [] });
    expect(p).not.toContain("{company} →");
    expect(p).not.toContain("{position} →");
    expect(p).not.toContain("{contactName} →");
    expect(p).toContain("EXAKT denselben Text");
    expect(p).toContain("KEIN Firmenname");
    expect(p).toContain("KEIN Platzhalter");
  });

  it("keeps the no-invention rules and the attachment contract", () => {
    const p = buildAutoBewerbEmailTemplatePrompt({ sharedAttachmentNames: ["Abiturzeugnis.pdf"] });
    expect(p).toContain("Erfinde NIEMALS");
    expect(p).toContain("Lebenslauf als PDF");
    expect(p).toContain("Anschreiben als PDF");
    expect(p).toContain("Abiturzeugnis.pdf");
    expect(p).toContain('{ "subject": string, "body": string }');
  });
});

// ---------------------------------------------------------------------------
// The generate-email route (global, metered, honest)
// ---------------------------------------------------------------------------

const BASE = "http://localhost/api/auto-bewerb/generate-email";

const PROFILE = {
  fileName: "cv.pdf",
  mimeType: "application/pdf",
  sizeBytes: 1,
  cvHash: "x",
  analyzedAt: "2026-01-01T00:00:00.000Z",
  extracted: {
    candidate: { full_name: "Mustapha Drif", location: "Hamburg" },
    experience: [{ job_title: "Praktikant Kältetechnik", company: "Kältebau Nord GmbH" }],
    skills: { technical: ["Schaltpläne lesen"] },
  },
} as never;

const DRAFT_OK = JSON.stringify({
  subject: "Bewerbung um eine Ausbildungsstelle",
  body: "Sehr geehrte Damen und Herren,\n\nhiermit bewerbe ich mich um eine Ausbildungsstelle. Anbei erhalten Sie meinen Lebenslauf und mein Anschreiben als PDF.\n\nMit freundlichen Grüßen\nMustapha Drif",
});

const generateText = vi.fn(async () => DRAFT_OK);

const lastPrompt = (): string =>
  String(((generateText.mock.calls as unknown as unknown[][]).at(-1)?.[0] as Array<{ content: string }> | undefined)?.[0]
    ?.content);

beforeEach(() => {
  vi.clearAllMocks();
  generateText.mockClear();
  generateText.mockImplementation(async () => DRAFT_OK);
  (createClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: USER } } }) },
  } as never);
  (provider as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ generateText });
  (checkRateLimit as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    allowed: true,
    count: 1,
    limit: 30,
    retryAfterSeconds: 0,
  });
  (reserveFeatureOp as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ outcome: "reserved" });
  (completeFeatureOp as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ outcome: "completed" });
  (releaseFeatureOp as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ outcome: "released" });
  (getAutoBewerbProfile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(PROFILE);
});

const post = (body: Record<string, unknown> = {}) =>
  POST(
    new Request(BASE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

describe("generate-email route (global, metered)", () => {
  it("unauthenticated → 401, model never called", async () => {
    (createClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: null } }) },
    } as never);
    const res = await post();
    expect(res.status).toBe(401);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("rate limited → 429, model never called", async () => {
    (checkRateLimit as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      allowed: false,
      count: 31,
      limit: 30,
      retryAfterSeconds: 30,
    });
    const res = await post();
    expect(res.status).toBe(429);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("quota exhausted → 429 with code, model never called", async () => {
    (reserveFeatureOp as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ outcome: "quota_exhausted" });
    const res = await post();
    expect(res.status).toBe(429);
    expect(((await res.json()) as { code?: string }).code).toBe("quota_exhausted");
    expect(generateText).not.toHaveBeenCalled();
  });

  it("success → 200 {subject, body} + the reservation is COMPLETED", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    const data = (await res.json()) as { subject: string; body: string };
    expect(data.subject).toBe("Bewerbung um eine Ausbildungsstelle");
    expect(completeFeatureOp).toHaveBeenCalledTimes(1);
    expect(releaseFeatureOp).not.toHaveBeenCalled();
  });

  it("invalid model output → 502 + the reservation is RELEASED", async () => {
    generateText.mockImplementation(async () => "not json at all");
    const res = await post();
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code?: string }).code).toBe("invalid_ai_output");
    expect(releaseFeatureOp).toHaveBeenCalledTimes(1);
    expect(completeFeatureOp).not.toHaveBeenCalled();
  });

  it("NO company input needed — the prompt is global, token-free, profile-grounded", async () => {
    await post({ attachmentNames: ["Abiturzeugnis.pdf"] });
    const p = lastPrompt();
    expect(p).not.toContain("{company} →");
    expect(p).toContain("Erfinde NIEMALS");
    expect(p).toContain("Kältebau Nord GmbH"); // the verified profile grounds the motivation
    expect(p).toContain("Abiturzeugnis.pdf");
  });

  it("missing profile → the prompt marks it unavailable (never invents)", async () => {
    (getAutoBewerbProfile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await post();
    expect(lastPrompt()).toContain("KANDIDATENPROFIL: nicht verfügbar");
  });
});
