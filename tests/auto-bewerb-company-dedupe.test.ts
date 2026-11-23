/**
 * AUTO BEWERB — Step 2 company management: the "only one company gets added"
 * regression (frontend + engine + action boundary).
 *
 * ROOT CAUSE (fixed): the dedupe key (company_key) was derived from a DISPLAY
 * name that fell back to the JOB TITLE whenever the AI extraction had no
 * company name. Portal ads usually name no employer, and job titles are
 * common position names shared by hundreds of employers — so the SECOND ad
 * with the same position collided as "company_duplicate" and the add was
 * refused. The database design exempts unknown companies from name-dedupe
 * (empty keys are NOT deduped — migration 20261215000000); the job title is a
 * display fallback only, and an IDENTICAL ad text is still a duplicate
 * (same employer + position + recipient would receive a second, identical
 * application).
 *
 * Contract verified here (in-memory admin client, production constraint
 * mirrors enabled):
 *  - 5 different companies are addable — including ads that share the same
 *    job title and name no employer;
 *  - all companies persist and a fresh read (page refresh) sees them all;
 *  - adding a new company never overwrites previously added companies;
 *  - true duplicates (same known employer / identical ad text) are refused
 *    with a friendly code and no row is created;
 *  - edit (rename) and delete work; a rename into an owned name is refused
 *    and leaves the row untouched;
 *  - users are isolated (another user's companies never block or leak);
 *  - the action boundary: auth (session user only) + invalid ad text.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStudioDb, type StudioDb } from "./helpers-studio";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/email-providers", () => ({ createEmailProvider: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUserAndProfile: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentUserAndProfile } from "@/lib/auth";
import {
  createAutoBewerbCompany,
  deleteAutoBewerbCompany,
  listAutoBewerbCompanies,
  updateAutoBewerbCompany,
} from "@/lib/auto-bewerb/engine";
import { addCompanyAction } from "@/app/auto-bewerb/actions";
import { AUTO_BEWERB_TABLES } from "@/lib/auto-bewerb/schema";
import { adExtractSchema, type AdExtract } from "@/lib/studio/schema";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

/** A COMMON job title — the real-world collision trigger. */
const JOB = "Auszubildende:r Fachinformatiker (m/w/d)";

/** Distinct ad texts (≥ 40 chars) that share the same job title. */
const adText = (n: number) =>
  `${JOB} — Wir suchen zum 01.09.2026 Verstärkung für unser Team (Stelle ${n}). ` +
  "Aufgaben: Analyse, Entwicklung und Wartung moderner IT-Systeme. Feste Vergütung, 30 Tage Urlaub, moderne Werkzeuge, tolles Team.";

/** Unknown-employer extraction (company empty — the usual portal case). */
const extractUnknown = (): AdExtract =>
  adExtractSchema.parse({ jobTitle: JOB, occupation: "Fachinformatiker/in", location: "München" });

/** Known-employer extraction. */
const extractKnown = (company: string): AdExtract =>
  adExtractSchema.parse({ company, jobTitle: JOB, occupation: "Fachinformatiker/in", location: "München" });

let db: StudioDb;

function newDb(): StudioDb {
  const d = createStudioDb({
    ...Object.fromEntries(AUTO_BEWERB_TABLES.map((t) => [t, []])),
    activity_logs: [],
  });
  // The production database arbiter for "same employer twice" — without it a
  // rename into an owned name would silently succeed in the harness.
  d.enableCompanyKeyUnique("auto_bewerb_companies");
  (createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(d.admin);
  return d;
}

const rows = () => db.tables.auto_bewerb_companies as Array<Record<string, unknown>>;
const ids = () => new Set(rows().map((r) => r.id as string));

beforeEach(() => {
  db = newDb();
  vi.mocked(getCurrentUserAndProfile).mockReset();
  vi.mocked(getCurrentUserAndProfile).mockResolvedValue({ user: { id: USER } as never, profile: null });
});

describe("adding multiple companies (regression: only one company was added)", () => {
  it("adds 5 different companies even when the ads share the SAME job title and name no employer", async () => {
    for (let i = 1; i <= 5; i += 1) {
      const res = await createAutoBewerbCompany(USER, { adRaw: adText(i), company: null, extract: extractUnknown(), analysis: null });
      expect(res.ok, `company ${i} must be addable`).toBe(true);
    }
    expect(rows()).toHaveLength(5);
    // All five persist for a FRESH read — the page refresh case.
    const listed = await listAutoBewerbCompanies(USER);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.companies).toHaveLength(5);
    expect(ids().size).toBe(5);
  });

  it("unknown-employer companies store an EMPTY dedupe key (DB design) with the job title as display name only", async () => {
    const res = await createAutoBewerbCompany(USER, { adRaw: adText(1), company: null, extract: extractUnknown(), analysis: null });
    expect(res.ok).toBe(true);
    const row = rows()[0];
    expect(row.company_key).toBe("");
    expect(row.company).toBe(JOB); // display fallback — never the key
  });

  it("adding a second company never overwrites the first one", async () => {
    const a = await createAutoBewerbCompany(USER, { adRaw: adText(1), company: "Alpha GmbH", extract: extractKnown("Alpha GmbH"), analysis: null });
    expect(a.ok).toBe(true);
    const first = rows()[0];
    const before = { ...first };
    const b = await createAutoBewerbCompany(USER, { adRaw: adText(2), company: "Beta AG", extract: extractKnown("Beta AG"), analysis: null });
    expect(b.ok).toBe(true);
    expect(rows()).toHaveLength(2);
    const now = rows()[0];
    expect(now.id).toBe(before.id);
    expect(now.company).toBe(before.company);
    expect(now.ad_raw).toBe(before.ad_raw);
    expect(now.company_key).toBe(before.company_key);
  });

  it("a genuinely unknown employer with a DIFFERENT ad (same title) is a second company, not a duplicate", async () => {
    expect((await createAutoBewerbCompany(USER, { adRaw: adText(1), company: null, extract: extractUnknown(), analysis: null })).ok).toBe(true);
    const second = await createAutoBewerbCompany(USER, { adRaw: adText(2), company: null, extract: extractUnknown(), analysis: null });
    expect(second.ok).toBe(true);
    expect(rows()).toHaveLength(2);
  });
});

describe("duplicate handling", () => {
  it("refuses the same known employer twice (case/punctuation variants) — no second row", async () => {
    expect((await createAutoBewerbCompany(USER, { adRaw: adText(1), company: "Alpha GmbH", extract: extractKnown("Alpha GmbH"), analysis: null })).ok).toBe(true);
    const dup = await createAutoBewerbCompany(USER, { adRaw: adText(2), company: "alpha gmbh", extract: extractKnown("alpha gmbh"), analysis: null });
    expect(dup).toMatchObject({ ok: false, code: "company_duplicate" });
    expect(rows()).toHaveLength(1);
  });

  it("refuses the IDENTICAL ad text for an unknown employer (same recipient would get a double application)", async () => {
    expect((await createAutoBewerbCompany(USER, { adRaw: adText(1), company: null, extract: extractUnknown(), analysis: null })).ok).toBe(true);
    const dup = await createAutoBewerbCompany(USER, { adRaw: `${adText(1)}  `, company: null, extract: extractUnknown(), analysis: null });
    expect(dup).toMatchObject({ ok: false, code: "company_duplicate" });
    expect(rows()).toHaveLength(1);
  });

  it("two different users may add the same employer (per-user isolation)", async () => {
    expect((await createAutoBewerbCompany(USER, { adRaw: adText(1), company: "Gamma GmbH", extract: extractKnown("Gamma GmbH"), analysis: null })).ok).toBe(true);
    const other = await createAutoBewerbCompany(OTHER, { adRaw: adText(2), company: "Gamma GmbH", extract: extractKnown("Gamma GmbH"), analysis: null });
    expect(other.ok).toBe(true);
    const listed = await listAutoBewerbCompanies(OTHER);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.companies).toHaveLength(1);
    expect(listed.companies[0].user_id).toBe(OTHER);
  });
});

describe("editing and deleting companies", () => {
  it("renaming to a NEW name updates the dedupe key and keeps the row", async () => {
    const res = await createAutoBewerbCompany(USER, { adRaw: adText(1), company: "Alpha GmbH", extract: extractKnown("Alpha GmbH"), analysis: null });
    expect(res.ok).toBe(true);
    const id = (res as { ok: true; value: { id: string } }).value.id;
    const edited = await updateAutoBewerbCompany(USER, id, { company: "Alpha Systeme GmbH" });
    expect(edited.ok).toBe(true);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].company).toBe("Alpha Systeme GmbH");
    expect(rows()[0].company_key).toBe("alpha systeme gmbh");
    expect(rows()[0].ad_raw).toBe(adText(1));
  });

  it("renaming INTO an already-owned name is refused and leaves the row untouched (DB constraint, not just a check)", async () => {
    const a = await createAutoBewerbCompany(USER, { adRaw: adText(1), company: "Alpha GmbH", extract: extractKnown("Alpha GmbH"), analysis: null });
    expect(a.ok).toBe(true);
    const b = await createAutoBewerbCompany(USER, { adRaw: adText(2), company: "Beta AG", extract: extractKnown("Beta AG"), analysis: null });
    expect(b.ok).toBe(true);
    const idA = (a as { ok: true; value: { id: string } }).value.id;
    const before = { ...rows()[0] };
    const clash = await updateAutoBewerbCompany(USER, idA, { company: "Beta AG" });
    expect(clash).toMatchObject({ ok: false, code: "company_duplicate" });
    expect(rows()[0].id).toBe(before.id);
    expect(rows()[0].company).toBe(before.company);
    expect(rows()[0].company_key).toBe(before.company_key);
  });

  it("deleting one company leaves all the others intact (persistence of the rest)", async () => {
    const added = [];
    for (let i = 1; i <= 3; i += 1) {
      const res = await createAutoBewerbCompany(USER, { adRaw: adText(i), company: `Firma ${i} GmbH`, extract: extractKnown(`Firma ${i} GmbH`), analysis: null });
      expect(res.ok).toBe(true);
      added.push((res as { ok: true; value: { id: string } }).value.id);
    }
    const del = await deleteAutoBewerbCompany(USER, added[1]);
    expect(del.ok).toBe(true);
    const listed = await listAutoBewerbCompanies(USER);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.companies).toHaveLength(2);
    expect(new Set(listed.companies.map((c) => c.id))).toEqual(new Set([added[0], added[2]]));
  });
});

describe("action boundary — auth and invalid data", () => {
  it("an unauthenticated add is refused (the user comes from the session, never the client)", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue({ user: null, profile: null });
    const res = await addCompanyAction({ adRaw: adText(1), company: "Alpha GmbH", extract: extractKnown("Alpha GmbH") });
    expect(res).toMatchObject({ ok: false, code: "unauthorized" });
    expect(rows()).toHaveLength(0);
  });

  it("invalid company data (ad text below 40 chars) is refused before any database write", async () => {
    const res = await addCompanyAction({ adRaw: "zu kurz", company: "Alpha GmbH", extract: extractKnown("Alpha GmbH") });
    expect(res).toMatchObject({ ok: false, code: "invalid_ad_text" });
    expect(rows()).toHaveLength(0);
  });

  it("a valid authenticated add persists exactly one owned row", async () => {
    const res = await addCompanyAction({ adRaw: adText(1), company: "Alpha GmbH", extract: extractKnown("Alpha GmbH") });
    expect(res.ok).toBe(true);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].user_id).toBe(USER);
    // A duplicate submission of the same ad is refused (no second row).
    const dup = await addCompanyAction({ adRaw: adText(1), company: "Alpha GmbH", extract: extractKnown("Alpha GmbH") });
    expect(dup).toMatchObject({ ok: false, code: "company_duplicate" });
    expect(rows()).toHaveLength(1);
  });
});
