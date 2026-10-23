/**
 * Mandatory applicant profile fields + Anschreiben PDF integration.
 *
 * Covers:
 *  - the pure seven-field validator (missing / whitespace / invalid /
 *    normalization — no country-specific assumptions),
 *  - the fixed PDF header order + right alignment + one-line "PLZ City",
 *    long-content wrapping, Unicode,
 *  - the generation gate (PROFILE_INCOMPLETE, server-side, before any
 *    claim/AI/quota),
 *  - ensureLetterPdf: blocked without the full profile; existing stored
 *    PDFs are NOT rewritten after a profile update,
 *  - the settings action: save/retrieve all seven, all-or-nothing,
 *    ownership-scoped, columns_pending degradation.
 */
// The in-memory fake below mimics a DYNAMIC Supabase proxy builder; its
// rows are intentionally loosely typed (like the other engine harnesses).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;
type TableKey =
  | "bew_campaigns"
  | "bew_applications"
  | "bew_documents"
  | "bew_campaign_documents"
  | "email_accounts"
  | "daily_usage"
  | "profiles";

interface DB {
  bew_campaigns: Row[];
  bew_applications: Row[];
  bew_documents: Row[];
  bew_campaign_documents: Row[];
  email_accounts: Row[];
  daily_usage: Row[];
  profiles: Row[];
  aiRemaining: number;
  aiScripts: Array<string | (() => Error)>;
  sendScripts: Array<() => { ok: true; id: string }>;
  sendLog: Array<{ to: string; subject: string; html: string }>;
  storage: {
    objects: Map<string, Uint8Array>;
    lastBucket: string | null;
    uploadCount: number;
    removedPaths: string[];
  };
  /** When true, unfiltered `profiles` SELECTs (the migration probes) fail
   *  with 42703 — simulating a database that missed the migration. */
  probeFail: boolean;
  slotFree: boolean;
}

const TODAY = new Date().toISOString().slice(0, 10);
const USER = "user-1";
const OTHER = "user-2";
const CAMPAIGN = "camp-1";

function freshDb(): DB {
  return {
    bew_campaigns: [],
    bew_applications: [],
    bew_documents: [],
    bew_campaign_documents: [],
    email_accounts: [
      { id: "acct-1", user_id: USER, email: "sender@gmail.com", is_active: true, requires_reconnect: false },
    ],
    daily_usage: [
      { user_id: USER, date: TODAY, emails_sent: 0, emails_reserved: 0, daily_limit: 50 },
    ],
    profiles: [
      {
        id: USER,
        full_name: "Max Mustermann",
        email: "max@example.de",
        street: "Musterstraße 12",
        postal_code: "12345",
        city: "Berlin",
        country: "Deutschland",
        phone: "+49 151 2345678",
      },
      {
        // A second user, to prove ownership isolation on every write.
        id: OTHER,
        full_name: "Other Person",
        email: "other@example.de",
        street: "",
        postal_code: "",
        city: "",
        country: "",
        phone: "",
      },
    ],
    aiRemaining: 100,
    aiScripts: [],
    sendScripts: [],
    sendLog: [],
    storage: { objects: new Map(), lastBucket: null, uploadCount: 0, removedPaths: [] },
    probeFail: false,
    slotFree: true,
  };
}

let db: DB;

function makeFrom(database: DB, table: TableKey) {
  const state = {
    op: "select" as string,
    payload: undefined as any,
    filters: [] as Array<{ col: string; val: any }>,
    inFilters: [] as Array<{ col: string; values: any[] }>,
    orderBy: [] as Array<{ col: string; ascending: boolean }>,
    limitN: undefined as number | undefined,
    selectCols: "*",
    selectOpts: undefined as any,
    terminal: undefined as "single" | "maybeSingle" | undefined,
  };
  function rows(): Row[] {
    let out = (database[table] ?? []).slice();
    for (const f of state.filters) out = out.filter((r) => r[f.col] === f.val);
    for (const f of state.inFilters) out = out.filter((r) => f.values.includes(r[f.col]));
    if (state.orderBy.length) {
      out.sort((a, b) => {
        for (const o of state.orderBy) {
          const dir = o.ascending ? 1 : -1;
          if (a[o.col] < b[o.col]) return -1 * dir;
          if (a[o.col] > b[o.col]) return 1 * dir;
        }
        return 0;
      });
    }
    if (state.limitN != null) out = out.slice(0, state.limitN);
    return out;
  }
  async function run(): Promise<any> {
    // The migration probes are unfiltered SELECTs — fail them on demand to
    // simulate a database that has not received 20261114000000 yet.
    if (
      state.op === "select" &&
      table === "profiles" &&
      state.filters.length === 0 &&
      database.probeFail
    ) {
      return { data: null, error: { message: "column does not exist (42703)" } };
    }
    if (state.op === "insert") {
      const items = Array.isArray(state.payload) ? state.payload : [state.payload];
      const inserted = items.map((r) => ({ ...r, id: r.id ?? `id-${Math.random()}` }));
      (database[table] ??= []).push(...inserted);
      if (state.terminal === "single") return { data: inserted[0], error: null };
      return { data: inserted, error: null };
    }
    if (state.op === "update") {
      const matched = rows();
      for (const m of matched) Object.assign(m, state.payload);
      if (state.terminal === "single" || state.terminal === "maybeSingle")
        return { data: matched[0] ?? null, error: null };
      return { data: matched, error: null };
    }
    if (state.op === "delete") {
      const matched = rows();
      (database[table] as Row[]) = (database[table] ?? []).filter((r) => !matched.includes(r));
      return { data: null, error: null };
    }
    const matched = rows();
    if (state.selectOpts?.count)
      return { data: state.selectOpts.head ? null : matched, error: null, count: matched.length };
    if (state.terminal === "single") return { data: matched[0] ?? null, error: null };
    if (state.terminal === "maybeSingle") return { data: matched[0] ?? null, error: null };
    return { data: matched, error: null };
  }
  const chain: any = {
    eq(col: string, val: any) {
      state.filters.push({ col, val });
      return chain;
    },
    in(col: string, values: any[]) {
      state.inFilters.push({ col, values });
      return chain;
    },
    order(col: string, o?: { ascending?: boolean }) {
      state.orderBy.push({ col, ascending: o?.ascending ?? true });
      return chain;
    },
    limit(n: number) {
      state.limitN = n;
      return chain;
    },
    select(cols?: string, opts?: any) {
      state.selectCols = cols ?? "*";
      state.selectOpts = opts;
      return chain;
    },
    insert(payload: any) {
      state.op = "insert";
      state.payload = payload;
      return chain;
    },
    update(payload: any) {
      state.op = "update";
      state.payload = payload;
      return chain;
    },
    delete() {
      state.op = "delete";
      return chain;
    },
    single() {
      state.terminal = "single";
      return chain;
    },
    maybeSingle() {
      state.terminal = "maybeSingle";
      return chain;
    },
    then(onF?: any, onR?: any) {
      return run().then(onF, onR);
    },
  };
  return chain;
}

function rpc(database: DB, name: string, args: any): Promise<{ data: any; error: any }> {
  void database;
  void name;
  void args;
  return Promise.resolve({ data: null, error: null });
}

function installMocks() {
  vi.doMock("@/lib/supabase/admin", () => ({
    createAdminClient: () => ({
      from: (table: string) => makeFrom(db, table as TableKey),
      rpc: (name: string, args: any) => rpc(db, name, args),
      storage: {
        from: (bucket: string) => ({
          download: async (objPath: string) => {
            const bytes = db.storage.objects.get(objPath);
            return bytes
              ? { data: { arrayBuffer: async () => bytes.buffer }, error: null }
              : { data: null, error: { message: "not found" } };
          },
          upload: async (objPath: string, bytes: Uint8Array) => {
            db.storage.lastBucket = bucket;
            db.storage.uploadCount += 1;
            db.storage.objects.set(objPath, bytes);
            return { error: null };
          },
          remove: async (paths: string[]) => {
            for (const p of paths ?? []) {
              db.storage.objects.delete(p);
              db.storage.removedPaths.push(p);
            }
            return { error: null };
          },
        }),
      },
    }),
  }));
  // Entitlements: fully permissive — the profile-resolution contract under
  // test is independent of the automation meter (covered by the entitlement
  // tests).
  vi.doMock("@/lib/billing/entitlement-service", () => ({
    checkFeature: async () => ({
      allowed: true,
      reason: "ok",
      limit: null,
      used: 0,
      remaining: null,
      resetsAt: null,
    }),
    reserveFeatureOp: async () => ({ outcome: "reserved" }),
    completeFeatureOp: async () => ({ outcome: "completed" }),
    releaseFeatureOp: async () => ({ outcome: "released" }),
    // Plan upload cap: 10 MB = the universal hard ceiling, so every
    // pre-existing size assertion in this suite keeps its meaning.
    effectiveUploadLimitBytes: async () => 10 * 1024 * 1024,
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: () => ({
      auth: {
        getUser: async () => ({ data: { user: { id: USER } }, error: null }),
      },
    }),
  }));
  vi.doMock("@/lib/email-campaigns", () => ({
    getUsageSnapshot: async () => ({
      date: TODAY,
      emails_sent: 0,
      emails_reserved: 0,
      daily_limit: 50,
      remaining: 50,
    }),
    reserveSenderSlot: async () => db.slotFree,
  }));
  vi.doMock("@/lib/email-providers", () => ({
    createEmailProvider: async () => ({
      sendEmail: async (input: any) => {
        const script = db.sendScripts.shift();
        if (!script) throw Object.assign(new Error("no provider script"), { code: "provider_rejected", temporary: false });
        db.sendLog.push({ to: input.to, subject: input.subject, html: input.html });
        const result = script();
        if (result && (result as { ok?: boolean }).ok) return { providerMessageId: (result as { id: string }).id };
        throw new Error("script should be handled");
      },
    }),
  }));
  vi.doMock("@/lib/ai-provider", () => ({
    createAIProvider: () => ({
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      generateText: async (_messages: any) => {
        const script = db.aiScripts.shift();
        if (typeof script === "function") throw script();
        return script ?? "Generischer Text.";
      },
    }),
  }));
  vi.doMock("@/lib/ai-service", () => ({
    reserveAIUsage: async () => {
      if (db.aiRemaining <= 0) throw new Error("AI daily request limit reached.");
      db.aiRemaining -= 1;
    },
    storagePath: (userId: string, filename: string) => `${userId}/doc-${filename}`,
  }));
  vi.doMock("mammoth", () => ({ default: { extractRawText: async () => ({ value: "docx" }) } }));
}

installMocks();

const {
  APPLICANT_FIELD_MAX,
  applicantAddressLines,
  applicantProfileFromRow,
  formatGermanDate,
  validateApplicantProfile,
} = await import("@/lib/bewerbung-automation");
const {
  buildLetterFolio,
  ensureLetterPdf,
  generateLetterPdf,
  letterPdfStoragePath,
} = await import("@/lib/bew-letter-pdf");
const {
  hasApplicantProfileColumns,
  resetApplicantProfileColumnsProbe,
} = await import("@/lib/contact-name-support");
const { extractPdfText } = await import("@/lib/pdf-extract");

beforeEach(() => {
  db = freshDb();
  resetApplicantProfileColumnsProbe();
});

/** The complete, valid fixture profile (camelCase field record). */
const COMPLETE = {
  fullName: "Max Mustermann",
  street: "Musterstraße 12",
  postalCode: "12345",
  city: "Berlin",
  country: "Deutschland",
  email: "max@example.de",
  phone: "+49 151 2345678",
};

/* ------------------------------------------------------------------ *
 * A. Pure validator
 * ------------------------------------------------------------------ */

describe("validateApplicantProfile (pure)", () => {
  it("accepts the complete profile and normalizes whitespace", () => {
    const res = validateApplicantProfile({
      ...COMPLETE,
      fullName: "  Max   Mustermann ",
      street: "\n Musterstraße\t12\n",
    } as any);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.fullName).toBe("Max Mustermann");
      expect(res.value.street).toBe("Musterstraße 12");
    }
  });

  it("reports every missing / whitespace-only field", () => {
    const res = validateApplicantProfile({
      ...COMPLETE,
      street: "   ",
      city: "",
      phone: null,
    } as any);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.missing.sort()).toEqual(["city", "phone", "street"]);
      expect(res.invalid).toEqual([]);
    }
  });

  it("rejects an invalid e-mail but not a valid one", () => {
    const bad = validateApplicantProfile({ ...COMPLETE, email: "max example de" } as any);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.invalid).toEqual(["email"]);
    const good = validateApplicantProfile({ ...COMPLETE, email: "Max.Name+Aus@Beispiel.DE" } as any);
    expect(good.ok).toBe(true);
  });

  it("accepts international phone formats, rejects gibberish (no country assumptions)", () => {
    for (const phone of ["+49 151 2345678", "0171 1234567", "+33 6 12 34 56 78", "+1 (415) 555-0132", "0043/1/2345678"]) {
      expect(validateApplicantProfile({ ...COMPLETE, phone } as any).ok).toBe(true);
    }
    for (const phone of ["abc", "12", "1 2 3", "+", "Tel: 123"]) {
      const res = validateApplicantProfile({ ...COMPLETE, phone } as any);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.invalid).toContain("phone");
    }
  });

  it("rejects overlong values per field bound", () => {
    const res = validateApplicantProfile({
      ...COMPLETE,
      street: "a".repeat(APPLICANT_FIELD_MAX.street + 1),
    } as any);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.invalid).toEqual(["street"]);
  });

  it("maps a stored row (snake_case, nullable) — never fabricates values", () => {
    const mapped = applicantProfileFromRow({
      full_name: "  A B  ",
      email: "a@b.de",
      street: null,
      postal_code: "",
      city: undefined,
      country: null,
      phone: null,
    });
    expect(mapped).toEqual({
      fullName: "A B",
      street: "",
      postalCode: "",
      city: "",
      country: "",
      email: "a@b.de",
      phone: "",
    });
  });

  it("applicantAddressLines: fixed order, PLZ+city on ONE line, empties omitted", () => {
    expect(applicantAddressLines(COMPLETE)).toEqual([
      "Musterstraße 12",
      "12345 Berlin",
      "Deutschland",
      "max@example.de",
      "+49 151 2345678",
    ]);
    // Historical shape (name + email only) stays compatible.
    expect(
      applicantAddressLines({
        fullName: "X",
        street: "",
        postalCode: "",
        city: "",
        country: "",
        email: "only@x.de",
        phone: "",
      }),
    ).toEqual(["only@x.de"]);
  });
});

/* ------------------------------------------------------------------ *
 * B. PDF header — order, alignment, wrapping, Unicode
 * ------------------------------------------------------------------ */

const FIX_DATE = new Date(Date.UTC(2026, 0, 15));
const DATE_TEXT = formatGermanDate(FIX_DATE);
const A4_RIGHT = 595.28 - 65;

/** Text items of page 1 with their position (pdf.js — the project's parser). */
async function pdfTextItems(bytes: Uint8Array): Promise<Array<{ str: string; x: number; y: number }>> {
  await import("@napi-rs/canvas");
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  try {
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    return (content.items as any[]).map((it) => ({
      str: it.str,
      x: it.transform[4],
      y: it.transform[5],
    }));
  } finally {
    await doc.destroy();
  }
}

function folioInput(over: Partial<Record<string, string>> = {}) {
  return {
    applicantName: "Max Mustermann",
    applicantEmail: "max@example.de",
    applicantStreet: "Musterstraße 12",
    applicantPostalCode: "12345",
    applicantCity: "Berlin",
    applicantCountry: "Deutschland",
    applicantPhone: "+49 151 2345678",
    companyName: "MusterTech GmbH",
    companyContactName: "Herr Weber",
    companyAddress: "Firmenweg 3\n10115 Berlin",
    subject: "Bewerbung um einen Ausbildungsplatz",
    bodyHtml:
      "<p>Sehr geehrter Herr Weber,</p><p>Hier ist der Brief.</p><p>Mit freundlichen Grüßen</p><p>Max Mustermann</p>",
    date: FIX_DATE,
    ...over,
  };
}

describe("Anschreiben PDF — the applicant header", () => {
  it("buildLetterFolio: all seven fields, fixed order, PLZ + city on one line", () => {
    const folio = buildLetterFolio(folioInput());
    expect(folio.senderName).toBe("Max Mustermann");
    expect(folio.senderLines).toEqual([
      "Musterstraße 12",
      "12345 Berlin",
      "Deutschland",
      "max@example.de",
      "+49 151 2345678",
    ]);
    // Everything else of the classic layout is preserved.
    expect(folio.dateText).toBe(DATE_TEXT);
    expect(folio.greeting).toBe("Sehr geehrter Herr Weber,");
    expect(folio.bodyParagraphs).toEqual(["Hier ist der Brief."]);
    expect(folio.closing).toBe("Mit freundlichen Grüßen");
    expect(folio.signature).toBe("Max Mustermann");
  });

  it("renders name → street → PLZ City → country → email → phone → date, right-aligned", async () => {
    const folio = buildLetterFolio(folioInput());
    const bytes = await generateLetterPdf(folio);
    // pdf.js emits empty marker items between lines — keep real text only.
    const items = (await pdfTextItems(bytes)).filter((i) => i.str.length > 0);
    // The TOP of the page (descending y) must be exactly the sender block.
    const top = items.slice().sort((a, b) => b.y - a.y).slice(0, 7);
    expect(top.map((i) => i.str)).toEqual([
      "MAX MUSTERMANN",
      "Musterstraße 12",
      "12345 Berlin",
      "Deutschland",
      "max@example.de",
      "+49 151 2345678",
      DATE_TEXT,
    ]);
    // Right alignment: every sender line ends at the right margin
    // (x + width ≈ A4_RIGHT) — and none flows past the left margin.
    const { PDFDocument, StandardFonts } = await import("pdf-lib");
    const probe = await PDFDocument.create();
    const regular = await probe.embedFont(StandardFonts.Helvetica);
    const bold = await probe.embedFont(StandardFonts.HelveticaBold);
    for (const it of top) {
      const isBold = it.str === "MAX MUSTERMANN" || it.str === DATE_TEXT;
      const size = it.str === "MAX MUSTERMANN" ? 11 : it.str === DATE_TEXT ? 10.5 : 10;
      const font = isBold ? bold : regular;
      const endX = it.x + font.widthOfTextAtSize(it.str, size);
      expect(Math.abs(endX - A4_RIGHT)).toBeLessThan(1.5);
      expect(it.x).toBeGreaterThan(65 - 1.5);
    }
    // The recipient block stays LEFT-aligned at the margin (unchanged).
    const company = items.find((i) => i.str === "MusterTech GmbH")!;
    expect(company).toBeDefined();
    expect(Math.abs(company.x - 65)).toBeLessThan(0.5);
    // The classic body layout (subject, greeting, closing, signature) survives.
    for (const expected of [
      "Bewerbung um einen Ausbildungsplatz",
      "Sehr geehrter Herr Weber,",
      "Mit freundlichen Grüßen",
      "Max Mustermann",
    ]) {
      expect(items.map((i) => i.str)).toContain(expected);
    }
  }, 60000);

  it("long streets wrap and stay right-aligned (no clipping past the left margin)", async () => {
    const folio = buildLetterFolio(
      folioInput({
        applicantStreet:
          "Besonders lange internationale Forschungsstraße mit noch weiteren Wörtern und weiteren Ziffern sowie Buchstaben 12345",
      }),
    );
    expect(folio.senderLines[0]).toContain("Forschungsstraße");
    const bytes = await generateLetterPdf(folio);
    const items = (await pdfTextItems(bytes)).filter((i) => i.str.length > 0);
    const { PDFDocument, StandardFonts } = await import("pdf-lib");
    const probe = await PDFDocument.create();
    const regular = await probe.embedFont(StandardFonts.Helvetica);
    // Every line of the wrapped street (all items above the date) is
    // right-aligned and inside the margins.
    const dateItem = items.find((i) => i.str === DATE_TEXT)!;
    const senderItems = items.filter((i) => i.y > dateItem.y);
    // name + (at least 2) wrapped street lines + PLZ-city + country + e-mail + phone
    expect(senderItems.length).toBeGreaterThanOrEqual(7);
    const streetLines = senderItems.filter((i) => i.str.includes("Forschungsstraße") || i.str.includes("12345"));
    expect(streetLines.length).toBeGreaterThanOrEqual(2); // it actually wrapped
    for (const it of senderItems) {
      if (it.str === "MAX MUSTERMANN") continue; // bold, checked in the other test
      const endX = it.x + regular.widthOfTextAtSize(it.str, 10);
      expect(Math.abs(endX - A4_RIGHT)).toBeLessThan(1.5);
      expect(it.x).toBeGreaterThan(65 - 1.5);
    }
    // The whole street is still present in the extracted text.
    const flat = (await extractPdfText(bytes)).replace(/\s+/g, " ");
    expect(flat).toContain("Besonders lange internationale Forschungsstraße");
    expect(flat).toContain("sowie Buchstaben 12345"); // end of the wrapped street
  }, 60000);

  it("renders Unicode / international addresses correctly", async () => {
    const folio = buildLetterFolio(
      folioInput({
        applicantName: "José Müller",
        applicantStreet: "Fürstenfelder Straße 3",
        applicantPostalCode: "80331",
        applicantCity: "München",
        applicantCountry: "Österreich",
        applicantPhone: "+43 1 234 56 78",
      }),
    );
    const bytes = await generateLetterPdf(folio);
    const flat = (await extractPdfText(bytes)).replace(/\s+/g, " ");
    expect(flat).toContain("JOSÉ MÜLLER");
    expect(flat).toContain("Fürstenfelder Straße");
    expect(flat).toContain("80331 München");
    expect(flat).toContain("Österreich");
    expect(flat).toContain("+43 1 234 56 78");
  }, 60000);
});

/* ------------------------------------------------------------------ *
 * C. ensureLetterPdf — full-profile gate + historical immutability
 * ------------------------------------------------------------------ */

describe("ensureLetterPdf — full-profile gate, historical immutability", () => {
  const REF_APP = {
    id: "app-1",
    company_name: "MusterTech GmbH",
    contact_name: "Herr Weber",
    company_address: null,
    subject: "Bewerbung um einen Ausbildungsplatz bei MusterTech GmbH",
    body_html:
      "<p>Sehr geehrter Herr Weber,</p><p>Hier ist der Brief.</p><p>Mit freundlichen Grüßen</p><p>Max Mustermann</p>",
  };
  const FULL = {
    name: "Max Mustermann",
    email: "max@example.de",
    street: "Musterstraße 12",
    postalCode: "12345",
    city: "Berlin",
    country: "Deutschland",
    phone: "+49 151 2345678",
  };

  it("blocks generation when ANY of the seven fields is missing (no silent name+email fallback)", async () => {
    for (const field of ["name", "street", "postalCode", "city", "country", "email", "phone"]) {
      db = freshDb();
      const applicant = { ...FULL, [field]: "" };
      const ref = await ensureLetterPdf({ userId: USER, app: REF_APP, applicant });
      expect(ref, `missing ${field} must block the PDF`).toBeNull();
      expect(db.storage.uploadCount).toBe(0);
    }
  });

  it("generates with the full header for a complete profile", async () => {
    const ref = await ensureLetterPdf({ userId: USER, app: REF_APP, applicant: FULL });
    expect(ref).not.toBeNull();
    expect(ref!.storagePath).toBe(`${USER}/bew-anschreiben/app-1.pdf`);
    expect(db.storage.uploadCount).toBe(1);
    const flat = (await extractPdfText(db.storage.objects.get(ref!.storagePath)!)).replace(/\s+/g, " ");
    expect(flat).toContain("Musterstraße 12");
    expect(flat).toContain("12345 Berlin");
    expect(flat).toContain("Deutschland");
    expect(flat).toContain("max@example.de");
    expect(flat).toContain("+49 151 2345678");
  }, 60000);

  it("an existing stored PDF is NOT rewritten after a profile update", async () => {
    const ref = await ensureLetterPdf({ userId: USER, app: REF_APP, applicant: FULL });
    const path = letterPdfStoragePath(USER, "app-1");
    expect(ref!.storagePath).toBe(path);
    const original = db.storage.objects.get(path)!;
    // The user edits their profile afterwards…
    const profile = db.profiles.find((p) => p.id === USER)!;
    profile.street = "Neue Straße 1";
    profile.city = "Hamburg";
    // …but the stored artifact is returned as-is (no regeneration, no force).
    const again = await ensureLetterPdf({ userId: USER, app: REF_APP, applicant: FULL });
    expect(again!.storagePath).toBe(path);
    expect(db.storage.uploadCount).toBe(1);
    expect(db.storage.objects.get(path)).toBe(original); // identical bytes
  }, 60000);

  it("force (letter edited) regenerates with the CURRENT profile values", async () => {
    await ensureLetterPdf({ userId: USER, app: REF_APP, applicant: FULL });
    await ensureLetterPdf({
      userId: USER,
      app: REF_APP,
      applicant: { ...FULL, street: "Neue Straße 1" },
      force: true,
    });
    expect(db.storage.uploadCount).toBe(2);
    const flat = (await extractPdfText(db.storage.objects.get(letterPdfStoragePath(USER, "app-1"))!)).replace(/\s+/g, " ");
    expect(flat).toContain("Neue Straße 1");
  }, 60000);
});

/* ------------------------------------------------------------------ *
 * D. Engine — server-side enforcement of the mandatory profile
 * ------------------------------------------------------------------ */

const { generateBewLetters, processBewSendBatch } = await import("@/lib/bewerbung-engine");
const { updateApplicantProfile } = await import("@/app/settings/profile/actions");

function seedCampaign(over: Partial<Row> = {}) {
  db.bew_campaigns.push({
    id: CAMPAIGN,
    user_id: USER,
    email_account_id: "acct-1",
    purpose: "ausbildung",
    status: "draft",
    requested_count: 1,
    usage_date: TODAY,
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    email_subject: "Bewerbung bei {{company_name}}",
    email_body_html: "<p>Meine Bewerbung.</p>",
    ...over,
  });
}

function seedApp(seq: number, over: Partial<Row> = {}) {
  db.bew_applications.push({
    id: `app-${seq}`,
    campaign_id: CAMPAIGN,
    user_id: USER,
    seq,
    company_name: `Firma ${seq}`,
    contact_name: null,
    company_email: `jobs${seq}@firma${seq}.de`,
    company_address: null,
    subject: "",
    body_html: "",
    body_text: "",
    status: "pending",
    error_code: null,
    error_message: null,
    attempt_count: 0,
    next_attempt_at: null,
    provider_message_id: null,
    sent_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  });
}

function profileObject(): any {
  const row = db.profiles.find((p) => p.id === USER)!;
  return {
    id: USER,
    full_name: row.full_name,
    email: row.email,
    street: row.street,
    postal_code: row.postal_code,
    city: row.city,
    country: row.country,
    phone: row.phone,
    account_status: "active",
  };
}

describe("engine gates — the mandatory profile is enforced server-side", () => {
  it("generateBewLetters BLOCKS with PROFILE_INCOMPLETE: no claim, no AI, no PDF", async () => {
    seedCampaign();
    seedApp(1);
    db.profiles.find((p) => p.id === USER)!.city = "";
    const aiBefore = db.aiRemaining;
    await expect(generateBewLetters(USER, CAMPAIGN, profileObject())).rejects.toThrow(
      "PROFILE_INCOMPLETE",
    );
    expect(db.bew_applications[0].status).toBe("pending"); // never claimed
    expect(db.aiRemaining).toBe(aiBefore); // no AI call
    expect(db.storage.uploadCount).toBe(0); // no PDF
  });

  it("generateBewLetters proceeds with a complete profile — the PDF carries the full header", async () => {
    seedCampaign();
    seedApp(1);
    db.aiScripts = ["Mein KI-Text für die Firma."];
    const result = await generateBewLetters(USER, CAMPAIGN, profileObject());
    expect(result.generated).toBe(1);
    expect(result.failed).toBe(0);
    expect(db.bew_applications[0].status).toBe("generated");
    const bytes = db.storage.objects.get(letterPdfStoragePath(USER, "app-1"));
    expect(bytes).toBeDefined();
    const flat = (await extractPdfText(bytes!)).replace(/\s+/g, " ");
    expect(flat).toContain("MAX MUSTERMANN");
    expect(flat).toContain("Musterstraße 12");
    expect(flat).toContain("12345 Berlin");
    expect(flat).toContain("Deutschland");
    expect(flat).toContain("max@example.de");
    expect(flat).toContain("+49 151 2345678");
  }, 60000);

  it("a send drain stops with profile-incomplete (no claim, no quota move, no send)", async () => {
    seedCampaign({ status: "sending", started_at: new Date().toISOString() });
    seedApp(1, { status: "queued" });
    db.bew_applications[0].body_html = "<p>Sehr geehrte Damen und Herren,</p><p>Text.</p><p>Mit freundlichen Grüßen</p><p>Max Mustermann</p>";
    db.profiles.find((p) => p.id === USER)!.phone = " ";
    db.daily_usage[0].emails_reserved = 1;
    db.sendScripts = [() => ({ ok: true as const, id: "must-not-send" })];
    const result = await processBewSendBatch(USER, CAMPAIGN, 5);
    expect(result.stop).toBe("profile-incomplete");
    expect(result.processed).toBe(0);
    expect(db.sendLog).toHaveLength(0);
    expect(db.bew_applications[0].status).toBe("queued"); // never claimed
    expect(db.daily_usage[0].emails_reserved).toBe(1); // untouched
  });
});

/* ------------------------------------------------------------------ *
 * E. Settings action — save/retrieve, all-or-nothing, ownership
 * ------------------------------------------------------------------ */

describe("updateApplicantProfile — the settings server action", () => {
  const V = {
    fullName: "Max Mustermann",
    street: "Musterstraße 12",
    postalCode: "12345",
    city: "Berlin",
    country: "Deutschland",
    email: "max@example.de",
    phone: "+49 151 2345678",
  };
  const form = (values: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(values)) fd.set(k, v);
    return fd;
  };

  it("saves all seven fields (normalized) — and they can be read back", async () => {
    const res = await updateApplicantProfile(
      form({ ...V, fullName: "  Max   Mustermann ", street: "\n Musterstraße\t12\n" }),
    );
    expect(res).toEqual({ ok: true });
    const row = db.profiles.find((p) => p.id === USER)!;
    expect(row.full_name).toBe("Max Mustermann");
    expect(row.street).toBe("Musterstraße 12");
    expect(row.postal_code).toBe("12345");
    expect(row.city).toBe("Berlin");
    expect(row.country).toBe("Deutschland");
    expect(row.email).toBe("max@example.de");
    expect(row.phone).toBe("+49 151 2345678");
  });

  it("rejects missing / whitespace-only fields — the existing row is UNCHANGED (all-or-nothing)", async () => {
    const before = { ...db.profiles.find((p) => p.id === USER)! };
    const res = await updateApplicantProfile(form({ ...V, city: "   " }));
    expect(res).toEqual({ ok: false, error: "invalid_profile" });
    expect(db.profiles.find((p) => p.id === USER)).toEqual(before);
  });

  it("rejects invalid e-mail / phone server-side (client bypass is useless)", async () => {
    expect(await updateApplicantProfile(form({ ...V, email: "nope" }))).toEqual({
      ok: false,
      error: "invalid_profile",
    });
    expect(await updateApplicantProfile(form({ ...V, phone: "hallo" }))).toEqual({
      ok: false,
      error: "invalid_profile",
    });
  });

  it("is owner-scoped: another user's profile is never touched", async () => {
    const otherBefore = { ...db.profiles.find((p) => p.id === OTHER)! };
    const res = await updateApplicantProfile(form(V));
    expect(res).toEqual({ ok: true });
    expect(db.profiles.find((p) => p.id === OTHER)).toEqual(otherBefore);
  });

  it("reports columns_pending (and writes nothing) while the migration is missing", async () => {
    db.probeFail = true;
    resetApplicantProfileColumnsProbe();
    const before = { ...db.profiles.find((p) => p.id === USER)! };
    const res = await updateApplicantProfile(form(V));
    expect(res).toEqual({ ok: false, error: "columns_pending" });
    expect(db.profiles.find((p) => p.id === USER)).toEqual(before);
    expect(await hasApplicantProfileColumns()).toBe(false);
  });
});
