/**
 * AUTO BEWERB — Step 2: compact company cards + automatic confirmation.
 *
 * The manual "Anzeige bestätigen" step is gone: the server stamps
 * `ad_confirmed_at` INSIDE the successful company insert (a failed insert
 * creates no row, so a company can never be confirmed without existing)
 * and RE-STAMPS it whenever the ad content (extraction / raw text) is
 * saved through updateAutoBewerbCompany. Unrelated patches (email fields,
 * review marks) leave the timestamp untouched.
 *
 * Covers:
 *  - engine auto-confirmation semantics (in-memory admin client),
 *  - duplicate prevention + the 10-company limit (unchanged),
 *  - zero residue of the removed manual confirmation (actions, engine,
 *    Step 2 component, i18n keys in all four languages),
 *  - the Step 2 component contract: collapsed-by-default cards with an
 *    independent per-card expand state, the green confirmed indicator,
 *    and the spec-mandated German labels.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStudioDb, type StudioDb } from "./helpers-studio";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/email-providers", () => ({ createEmailProvider: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin";
import {
  createAutoBewerbCompany,
  updateAutoBewerbCompany,
} from "@/lib/auto-bewerb/engine";
import { AUTO_BEWERB_COMPANY_LIMIT, AUTO_BEWERB_TABLES } from "@/lib/auto-bewerb/schema";
import { adExtractSchema, type AdExtract } from "@/lib/studio/schema";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string) => readFileSync(resolve(root, relative), "utf8");

const USER = "11111111-1111-4111-8111-111111111111";
const AD_RAW =
  "Auszubildende:r Anlagenmechaniker SHK (m/w/d) — wir suchen zum 01.09. eine:n Azubi " +
  "für Sanitär, Heizung und Klima. Aufgaben: Installation und Wartung von Anlagen.";

const extractFor = (company: string): AdExtract =>
  adExtractSchema.parse({
    company,
    jobTitle: "Auszubildende:r Anlagenmechaniker SHK",
    occupation: "Anlagenmechaniker/in Sanitär-Heizung-Klima",
    location: "Hamburg",
    applicationDeadline: "15.08.2026",
    requiredQualifications: ["Guter Hauptschulabschluss"],
  });

describe("engine — automatic confirmation on company save", () => {
  let db: StudioDb;

  beforeEach(() => {
    const seed: Record<string, Record<string, unknown>[]> = {
      ...Object.fromEntries(AUTO_BEWERB_TABLES.map((t) => [t, []])),
      activity_logs: [],
    };
    db = createStudioDb(seed);
    (createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
  });

  it("stamps ad_confirmed_at INSIDE the successful insert (server-owned, not client-faked)", async () => {
    const res = await createAutoBewerbCompany(USER, {
      adRaw: AD_RAW,
      company: "Kältebau Nord GmbH",
      extract: extractFor("Kältebau Nord GmbH"),
      analysis: null,
    });
    expect(res.ok).toBe(true);
    const row = db.tables.auto_bewerb_companies[0];
    const stamped = row.ad_confirmed_at as string;
    expect(stamped).toBeTruthy();
    expect(Number.isNaN(Date.parse(stamped))).toBe(false);
    // The returned row and the persisted row agree.
    expect((res as { ok: true; value: { ad_confirmed_at: string } }).value.ad_confirmed_at).toBe(stamped);
  });

  it("a FAILED insert (duplicate) creates no row and thus no fake confirmation", async () => {
    await createAutoBewerbCompany(USER, { adRaw: AD_RAW, company: "Kältebau Nord GmbH", extract: extractFor("Kältebau Nord GmbH"), analysis: null });
    const dup = await createAutoBewerbCompany(USER, { adRaw: AD_RAW, company: "Kältebau Nord GmbH ", extract: extractFor("Kältebau Nord GmbH"), analysis: null });
    expect(dup).toMatchObject({ ok: false, code: "company_duplicate" });
    expect(db.tables.auto_bewerb_companies).toHaveLength(1);
  });

  it("saving the ad content again RE-STAMPS the confirmation (edit never leaves a company unconfirmed)", async () => {
    const created = await createAutoBewerbCompany(USER, { adRaw: AD_RAW, company: "Kältebau Nord GmbH", extract: extractFor("Kältebau Nord GmbH"), analysis: null });
    expect(created.ok).toBe(true);
    const id = (created as { ok: true; value: { id: string } }).value.id;
    const before = db.tables.auto_bewerb_companies[0].ad_confirmed_at as string;

    // Edit the extraction (the edit modal always persists ad_extracted).
    const edited = await updateAutoBewerbCompany(USER, id, {
      ad_extracted: { ...extractFor("Kältebau Nord GmbH"), applicationDeadline: "30.08.2026" },
    });
    expect(edited.ok).toBe(true);
    const afterEdit = db.tables.auto_bewerb_companies[0].ad_confirmed_at as string;
    expect(afterEdit).toBeTruthy();
    expect(Date.parse(afterEdit) >= Date.parse(before)).toBe(true);

    // Edit the raw ad text — re-stamped as well.
    const raw = await updateAutoBewerbCompany(USER, id, { ad_raw: AD_RAW + " Bewerbung bis 30.08.2026." });
    expect(raw.ok).toBe(true);
    expect(db.tables.auto_bewerb_companies[0].ad_confirmed_at).toBeTruthy();
  });

  it("unrelated patches preserve the existing confirmation timestamp", async () => {
    const created = await createAutoBewerbCompany(USER, { adRaw: AD_RAW, company: "ThermoTech Süd AG", extract: extractFor("ThermoTech Süd AG"), analysis: null });
    const id = (created as { ok: true; value: { id: string } }).value.id;
    const before = db.tables.auto_bewerb_companies[0].ad_confirmed_at as string;

    const patched = await updateAutoBewerbCompany(USER, id, { company: "ThermoTech Süd GmbH" });
    expect(patched.ok).toBe(true);
    expect(db.tables.auto_bewerb_companies[0].ad_confirmed_at).toBe(before);
  });

  it("keeps the 100-company global limit (server-enforced)", async () => {
    for (let i = 1; i <= AUTO_BEWERB_COMPANY_LIMIT; i += 1) {
      const res = await createAutoBewerbCompany(USER, { adRaw: AD_RAW, company: `Firma ${i} GmbH`, extract: extractFor(`Firma ${i} GmbH`), analysis: null });
      expect(res.ok, `company ${i}`).toBe(true);
    }
    const overflow = await createAutoBewerbCompany(USER, { adRaw: AD_RAW, company: `Firma ${AUTO_BEWERB_COMPANY_LIMIT + 1} GmbH`, extract: extractFor(`Firma ${AUTO_BEWERB_COMPANY_LIMIT + 1} GmbH`), analysis: null });
    expect(overflow).toMatchObject({ ok: false, code: "workflow_full" });
    expect(db.tables.auto_bewerb_companies).toHaveLength(AUTO_BEWERB_COMPANY_LIMIT);
    // Every created company is confirmed.
    expect(db.tables.auto_bewerb_companies.every((r) => typeof r.ad_confirmed_at === "string" && r.ad_confirmed_at.length > 0)).toBe(true);
  });
});

describe("zero residue of the removed manual confirmation", () => {
  it("no action, no engine function, no UI control, no i18n key remains", () => {
    const actions = read("src/app/auto-bewerb/actions.ts");
    expect(actions).not.toContain("confirmAdAction");
    expect(actions).not.toContain("markAutoBewerbAdConfirmed");

    const engine = read("src/lib/auto-bewerb/engine.ts");
    expect(engine).not.toContain("markAutoBewerbAdConfirmed");
    // The insert carries the server-owned auto-confirmation stamp.
    expect(engine).toContain("AUTO-CONFIRMATION");
    expect(engine).toContain("ad_confirmed_at: new Date().toISOString()");
    // Editing content re-stamps instead of invalidating.
    expect(engine).not.toContain("extended.ad_confirmed_at = null");

    const dict = read("src/lib/i18n/dictionaries.ts");
    expect(dict.split("confirmAdButton").length - 1).toBe(0);
    expect(dict.split("adConfirmedNote").length - 1).toBe(0);
  });
});

describe("Step 2 component — compact collapsed cards with independent expand state", () => {
  const step2 = read("src/components/auto-bewerb/step2-companies.tsx");

  it("renders full-width stacked compact cards (no 2-column grid)", () => {
    expect(step2).toContain("flex flex-col gap-4");
    expect(step2).not.toContain("grid gap-5 lg:grid-cols-2");
  });

  it("each card owns its expand state (per-card useState + aria-expanded)", () => {
    expect(step2).toContain("const [expanded, setExpanded] = useState(false);");
    expect(step2).toContain("setExpanded((v) => !v)");
    expect(step2).toContain("aria-expanded={expanded}");
  });

  it("collapsed row shows name, job, status, edit and delete — no full details by default", () => {
    // The details section is rendered ONLY when expanded.
    expect(step2).toContain("{expanded && (");
    // The green confirmed indicator + fallback workflow pill.
    expect(step2).toContain("c.ad_confirmed_at ? (");
    expect(step2).toContain("confirmedLabel");
    expect(step2).toContain("statusPill(c.status, t)");
  });

  it("uses the spec-mandated German labels and the wrap-friendly detail fields", () => {
    const dict = read("src/lib/i18n/dictionaries.ts");
    expect(dict).toContain('detailsHide: "Details ausblenden"');
    expect(dict).toContain('detailsToggle: "Details anzeigen"');
    expect(dict).toContain('confirmedLabel: "Bestätigt"');
    expect(dict).toContain('deleteCompany: "Unternehmen löschen"');
    expect(dict).toContain('editCompany: "Unternehmen bearbeiten"');
    expect(dict).toContain('addCompanyButton: "Unternehmen hinzufügen"');
    // New keys exist in all four languages.
    for (const key of ["detailsHide:", "confirmedLabel:", "deleteCompany:"]) {
      const count = dict.split(key).length - 1;
      expect(count, `i18n key "${key}" must exist in de+en+fr+ar (found ${count})`).toBeGreaterThanOrEqual(4);
    }
    // Long values wrap instead of truncating in the expanded details.
    expect(step2).toContain("break-words");
  });

  it("clears the form only after a server-confirmed save (never on failure)", () => {
    // Anchor on the addCompany handler's result branch (the first
    // "if (res.ok)" in the file) and search RELATIVE to it — the analyze
    // block's "} else {" sits earlier in the source.
    const okIdx = step2.indexOf("if (res.ok)");
    const elseIdx = step2.indexOf("} else {", okIdx);
    expect(okIdx).toBeGreaterThanOrEqual(0);
    expect(elseIdx).toBeGreaterThan(okIdx);
    // Success path: text + preview cleared, then a refresh from the server.
    const successBlock = step2.slice(okIdx, elseIdx);
    expect(successBlock).toContain('setAdText("")');
    expect(successBlock).toContain("setPending(null)");
    expect(successBlock).toContain("await refresh()");
    // Failure path: only the error note is set — the text is kept.
    const failureBlock = step2.slice(elseIdx, step2.indexOf("};", elseIdx));
    expect(failureBlock).toContain("setAddError");
    expect(failureBlock).not.toContain('setAdText("")');
  });
});
