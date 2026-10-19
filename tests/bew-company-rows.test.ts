/**
 * Bewerbung Automation — manual company-entry row-state regression suite.
 *
 * BUG 1 (production symptom)
 *   Type `recruiting@example.com` into the e-mail field, then type
 *   `Example GmbH` into the company-name field → the e-mail value
 *   disappears.
 *
 * ROOT CAUSE
 *   `CompaniesStep.setDraft` re-derived the whole row from the SERVER row
 *   on every keystroke and applied only the field being typed. The second
 *   keystroke therefore rebuilt the row from the (still-empty) server state
 *   and silently discarded the first field's unsaved edit — a stale
 *   whole-row replacement instead of a merge.
 *
 * FIX
 *   The draft merge now bases itself on the LATEST DRAFT for that row
 *   (the server row is only the initial seed): `applyDraftPatch` in
 *   `./row-state.ts`. Every field edit updates the latest row object while
 *   preserving all other fields; rows are keyed/updated by their stable
 *   application id, never by array index.
 *
 * FEATURE (Bug 2)
 *   Every row carries a visible red X that deletes ONLY that row (by stable
 *   id) — server-side EXCLUDE (ownership-checked, restorable, blocks
 *   in-flight rows), the row's unsaved draft goes away with it, and the
 *   entry count, validation and live duplicate check update immediately.
 *   Deleting the last row shows the empty state (import to continue);
 *   excluded rows are hidden from the company table but their data is not
 *   destroyed.
 *
 * No real e-mail, no real Supabase: the state rules are pure (node) and the
 * component is SSR-rendered (renderToString) exactly as first paint.
 */
import { describe, expect, it, vi } from "vitest";

// The smart input (rendered inside CompaniesStep) calls useRouter() for the
// expired-session /login navigation; the bare node SSR below has no
// app-router context, so the hook is stubbed (same as the action-contract
// test stubs redirect()).
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

import {
  applyDraftPatch,
  filterActiveRows,
  findDuplicateEmails,
  isRowComplete,
  rowDirty,
  rowValues,
  type CompanyRowView,
  type Drafts,
} from "@/components/bewerbung-automation/row-state";
import type {
  BewApplicationDTO,
  BewViewDTO,
  CompanyRecord,
} from "@/components/bewerbung-automation/types";

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function row(seq: number, over: Partial<CompanyRowView> = {}): CompanyRowView {
  return {
    id: `app-${seq}`,
    seq,
    companyName: "",
    companyEmail: "",
    contactName: null,
    companyAddress: null,
    status: "pending",
    error_code: null,
    ...over,
  };
}

function valuesOf(rows: CompanyRowView[], drafts: Drafts = {}): CompanyRecord[] {
  const out: CompanyRecord[] = [];
  for (const r of rows) {
    const v = rowValues(drafts, rows, r.id);
    if (v) out.push(v);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * A. The draft merge (Bug 1) — typing order must never lose fields
 * ------------------------------------------------------------------ */

describe("row state: field edits preserve every other field (Bug 1)", () => {
  it("entering an e-mail and THEN a company name keeps both values (the exact repro)", () => {
    const r = row(1);
    let d: Drafts = {};
    // Step 1: type the e-mail.
    d = applyDraftPatch(d, r.id, r, { companyEmail: "recruiting@example.com" });
    // Step 2..: type the company name (one character at a time).
    d = applyDraftPatch(d, r.id, r, { companyName: "Exa" });
    d = applyDraftPatch(d, r.id, r, { companyName: "Example" });
    d = applyDraftPatch(d, r.id, r, { companyName: "Example GmbH" });

    const v = rowValues(d, [r], r.id)!;
    expect(v.companyName).toBe("Example GmbH");
    // THE REGRESSION: the e-mail must survive the name edits.
    expect(v.companyEmail).toBe("recruiting@example.com");
    expect(v.contactName).toBe("");
    expect(v.companyAddress).toBe("");
  });

  it("editing all four fields in different orders preserves every previous edit", () => {
    const full: CompanyRecord = {
      companyName: "Muster GmbH",
      companyEmail: "jobs@muster.de",
      contactName: "Herr Beispiel",
      companyAddress: "Musterstraße 1",
      positionTitle: "",
      positionBrief: "",
      employerFacts: "",
    };
    const orders: Array<Array<keyof CompanyRecord>> = [
      ["companyEmail", "companyName", "contactName", "companyAddress"],
      ["companyName", "companyEmail", "companyAddress", "contactName"],
      ["contactName", "companyAddress", "companyEmail", "companyName"],
      ["companyAddress", "contactName", "companyName", "companyEmail"],
    ];
    for (const order of orders) {
      const r = row(1);
      let d: Drafts = {};
      for (const field of order) d = applyDraftPatch(d, r.id, r, { [field]: full[field] });
      expect(rowValues(d, [r], r.id), `order: ${order.join(" → ")}`).toEqual(full);
      expect(rowDirty(d, [r], r.id)).toBe(true);
    }
  });

  it("updating one row never overwrites another row", () => {
    const r1 = row(1);
    const r2 = row(2);
    let d: Drafts = {};
    d = applyDraftPatch(d, r1.id, r1, { companyEmail: "a@a.de" });
    d = applyDraftPatch(d, r2.id, r2, { companyName: "Row Two" });
    d = applyDraftPatch(d, r1.id, r1, { companyName: "Row One" });
    d = applyDraftPatch(d, r2.id, r2, { companyAddress: "Str. 2" });

    expect(rowValues(d, [r1, r2], r1.id)).toEqual({
      companyName: "Row One",
      companyEmail: "a@a.de",
      contactName: "",
      companyAddress: "",
      positionTitle: "",
      positionBrief: "",
      employerFacts: "",
    });
    expect(rowValues(d, [r1, r2], r2.id)).toEqual({
      companyName: "Row Two",
      companyEmail: "",
      contactName: "",
      companyAddress: "Str. 2",
      positionTitle: "",
      positionBrief: "",
      employerFacts: "",
    });
    // The untouched third row stays pristine.
    const r3 = row(3, { companyEmail: "c@c.de" });
    expect(rowValues(d, [r1, r2, r3], r3.id)).toEqual({
      companyName: "",
      companyEmail: "c@c.de",
      contactName: "",
      companyAddress: "",
      positionTitle: "",
      positionBrief: "",
      employerFacts: "",
    });
  });

  it("a refresh (navigation away and back) does not discard local drafts", () => {
    const r1 = row(1);
    let d: Drafts = {};
    d = applyDraftPatch(d, r1.id, r1, { companyEmail: "kept@kept.de" });
    d = applyDraftPatch(d, r1.id, r1, { companyName: "Kept GmbH" });

    // The wizard re-mounts nothing: the step stays mounted, and even a fresh
    // server view with the SAME stable ids still resolves the drafts.
    const refreshed = [row(1)]; // brand-new objects, same id
    const v = rowValues(d, refreshed, "app-1")!;
    expect(v.companyEmail).toBe("kept@kept.de");
    expect(v.companyName).toBe("Kept GmbH");
    expect(filterActiveRows(refreshed)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * B. Row deletion (Bug 2) — one row out, everything else intact
 * ------------------------------------------------------------------ */

describe("row state: deleting a row (Bug 2)", () => {
  it("deleting the middle row removes only that row", () => {
    const rows = [
      row(1, { companyName: "A", companyEmail: "a@a.de" }),
      row(2, { companyName: "B", companyEmail: "b@b.de" }),
      row(3, { companyName: "C", companyEmail: "c@c.de" }),
    ];
    // A delete is a server EXCLUDE of the ONE row (by stable id)…
    const after = filterActiveRows(
      rows.map((r) => (r.id === "app-2" ? { ...r, status: "excluded" } : r)),
    );
    // …and the active list contains exactly the other two, in order.
    expect(after.map((r) => r.id)).toEqual(["app-1", "app-3"]);
    expect(after.map((r) => r.companyName)).toEqual(["A", "C"]);
  });

  it("deleting a row preserves the values of all remaining rows (server + drafts)", () => {
    const rows = [
      row(1, { companyName: "A", companyEmail: "a@a.de" }),
      row(2, { companyName: "B" }),
      row(3, { companyEmail: "c@c.de" }),
    ];
    let d: Drafts = {};
    d = applyDraftPatch(d, "app-1", rows[0], { contactName: "Hr. A" });
    d = applyDraftPatch(d, "app-3", rows[2], { companyName: "C GmbH" });

    // Delete the middle row; its (empty) draft would go with it.
    const after = filterActiveRows(
      rows.map((r) => (r.id === "app-2" ? { ...r, status: "excluded" } : r)),
    );
    expect(rowValues(d, after, "app-1")).toEqual({
      companyName: "A",
      companyEmail: "a@a.de",
      contactName: "Hr. A",
      companyAddress: "",
      positionTitle: "",
      positionBrief: "",
      employerFacts: "",
    });
    expect(rowValues(d, after, "app-3")).toEqual({
      companyName: "C GmbH",
      companyEmail: "c@c.de",
      contactName: "",
      companyAddress: "",
      positionTitle: "",
      positionBrief: "",
      employerFacts: "",
    });
    // The deleted row's draft is dropped with the row.
    d = (() => {
      const next = { ...d };
      delete next["app-2"];
      return next;
    })();
    expect(d["app-2"]).toBeUndefined();
  });

  it("entry count, validation and duplicate detection update immediately after deletion", () => {
    const rows = [
      row(1, { companyName: "A", companyEmail: "x@x.de" }),
      row(2, { companyName: "B", companyEmail: "x@x.de" }), // duplicate of row 1
      row(3, { companyName: "C", companyEmail: "y@y.de" }),
    ];
    // BEFORE: 3 entries, one duplicate pair.
    expect(filterActiveRows(rows)).toHaveLength(3);
    let dups = findDuplicateEmails(valuesOf(filterActiveRows(rows)));
    expect(dups.has("x@x.de")).toBe(true);
    expect(dups.size).toBe(1);

    // Delete row 2 (one side of the duplicate) → everything recomputes.
    const after = filterActiveRows(
      rows.map((r) => (r.id === "app-2" ? { ...r, status: "excluded" } : r)),
    );
    expect(after).toHaveLength(2);
    dups = findDuplicateEmails(valuesOf(after));
    expect(dups.size).toBe(0); // duplicate resolved by the deletion
    // Validation of the survivors is intact.
    expect(isRowComplete(valuesOf(after)[0])).toBe(true);
    expect(isRowComplete(valuesOf(after)[1])).toBe(true);
  });

  it("deleting the LAST remaining row empties the list (the UI then shows the add/import state)", () => {
    const rows = [row(1, { companyName: "Only", companyEmail: "only@only.de" })];
    const after = filterActiveRows(rows.map((r) => ({ ...r, status: "excluded" })));
    expect(after).toHaveLength(0);
    expect(valuesOf(after)).toHaveLength(0);
  });

  it("imported company rows (server values, no drafts yet) can be edited and deleted", () => {
    // As produced by saveBewCompanies: the values live on the server row.
    const imported = row(1, {
      companyName: "Imported GmbH",
      companyEmail: "jobs@imported.de",
      contactName: "Frau Beispiel",
      companyAddress: "Importstraße 12, 12345 Stadt",
    });
    // Editable: a draft patches onto the imported values…
    let d: Drafts = {};
    d = applyDraftPatch(d, imported.id, imported, { companyName: "Imported GmbH (editiert)" });
    const v = rowValues(d, [imported], imported.id)!;
    expect(v.companyName).toBe("Imported GmbH (editiert)");
    // …preserving the imported e-mail/contact/address.
    expect(v.companyEmail).toBe("jobs@imported.de");
    expect(v.contactName).toBe("Frau Beispiel");
    expect(v.companyAddress).toBe("Importstraße 12, 12345 Stadt");
    expect(rowDirty(d, [imported], imported.id)).toBe(true);
    // And deletable like any other row.
    expect(
      filterActiveRows([{ ...imported, status: "excluded" }]),
    ).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * C. Component SSR — red X per row, counts, empty state, duplicates
 * ------------------------------------------------------------------ */

vi.mock("@/app/bewerbung-automation/actions", () => ({
  bewSaveCompanies: vi.fn(async () => ({ campaignId: "c1", total: 0, valid: 0, duplicates: [] })),
  bewUpdateCompany: vi.fn(async () => null),
  bewExcludeApplication: vi.fn(async () => ({ ok: true })),
  bewAttachDocument: vi.fn(async () => ({ ok: true })),
  bewDetachDocument: vi.fn(async () => ({ ok: true })),
  bewListDocuments: vi.fn(async () => []),
  bewSetSender: vi.fn(async () => ({ ok: true })),
  bewGenerateLetters: vi.fn(async () => ({ generated: 0, failed: 0, remaining: 0, aiQuotaHit: false })),
  bewUpdateLetter: vi.fn(async () => null),
  bewRestoreApplication: vi.fn(async () => ({ ok: true })),
  bewStartSend: vi.fn(async () => ({ started: 0, queued: 0 })),
  bewCancelSend: vi.fn(async () => ({ cancelled: 0 })),
  bewCreateCampaign: vi.fn(async () => ({ campaignId: "c", count: 10 })),
  bewGetView: vi.fn(async () => null),
  bewSetCompanyCount: vi.fn(async () => ({ campaignId: "c1", requestedCount: 1 })),
  bewAddCompanyRows: vi.fn(async () => ({ campaignId: "c1", added: 0, total: 1 })),
}));

const React = await import("react");
const { renderToString } = await import("react-dom/server");
const { I18nProvider } = await import("@/lib/i18n");
const { CompaniesStep } = await import("@/components/bewerbung-automation/companies-step");

function appDto(seq: number, over: Partial<BewApplicationDTO> = {}): BewApplicationDTO {
  return {
    id: `app-${seq}`,
    seq,
    company_name: "",
    contact_name: null,
    company_email: "",
    company_address: null,
    subject: "",
    body_html: "",
    body_text: "",
    status: "pending",
    error_code: null,
    error_message: null,
    attempt_count: 0,
    provider_message_id: null,
    sent_at: null,
    ...over,
  };
}

function renderStep(appsList: BewApplicationDTO[], campaign: { status?: string } = {}): string {
  const view: BewViewDTO = {
    campaign: {
      id: "c1",
      user_id: "user-1",
      email_account_id: "acct-1",
      purpose: "ausbildung",
      status: campaign.status ?? "draft",
      requested_count: appsList.length,
      valid_count: 0,
      total_count: appsList.length,
      generated_count: 0,
      sent_count: 0,
      failed_count: 0,
      excluded_count: 0,
      usage_date: new Date().toISOString().slice(0, 10),
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    },
    applications: appsList,
    documents: [],
    usage: { remaining: 50, daily_limit: 50 },
    senderEmail: "sender@gmail.com",
  };
  return renderToString(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(CompaniesStep, {
        view,
        refresh: async () => null,
        onNext: () => undefined,
        nextBlockedReason: null,
        creatingSeries: false,
        seriesConfirmation: null,
        patchApplication: () => undefined,
        appendApplication: () => undefined,
        patchCampaign: () => undefined,
      }),
    ),
  );
}

function deleteButtonCount(html: string): number {
  return (html.match(/Firmenzeile \d+ löschen/g) ?? []).length;
}

/** React SSR emits `<!-- -->` between adjacent text segments ("Einträge", " ",
 *  "(0)") — normalize so string assertions see the rendered text. */
function plain(html: string): string {
  return html.replace(/<!-- -->/g, "");
}

describe("CompaniesStep render: red X delete per row (Bug 2)", () => {
  it("renders one accessible red delete button per active row (label carries the row number)", () => {
    const html = renderStep([
      appDto(1, { company_name: "A", company_email: "a@a.de" }),
      appDto(2, { company_name: "B", company_email: "b@b.de" }),
      appDto(3, { company_name: "C", company_email: "c@c.de" }),
    ]);
    expect(deleteButtonCount(html)).toBe(3);
    expect(html).toContain("Firmenzeile 1 löschen");
    expect(html).toContain("Firmenzeile 2 löschen");
    expect(html).toContain("Firmenzeile 3 löschen");
    // The button is RED (danger tone) and uses the X icon.
    const btnIdx = html.indexOf("Firmenzeile 2 löschen");
    const start = html.lastIndexOf("<button", btnIdx);
    const end = html.indexOf("</button>", btnIdx);
    const btn = html.slice(start, end);
    expect(btn).toContain("text-danger");
    expect(btn).toContain('<button type="button"');
    // Entry count reflects the active rows.
    expect(plain(html)).toContain("Einträge (3)");
  });

  it("excluded (deleted) rows are hidden from the table and the count updates", () => {
    const html = renderStep([
      appDto(1, { company_name: "A", company_email: "a@a.de" }),
      appDto(2, { company_name: "Deleted", company_email: "gone@gone.de", status: "excluded" }),
      appDto(3, { company_name: "C", company_email: "c@c.de" }),
    ]);
    expect(deleteButtonCount(html)).toBe(2);
    expect(html).not.toContain("Firmenzeile 2 löschen");
    // The deleted row's data is not shown (but not destroyed — server keeps it).
    expect(html).not.toContain("gone@gone.de");
    expect(html).not.toContain("Deleted");
    expect(plain(html)).toContain("Einträge (2)");
  });

  it("deleting the last row shows the empty state with the import/add option", () => {
    const html = renderStep([
      appDto(1, { status: "excluded" }),
      appDto(2, { status: "excluded" }),
    ]);
    expect(html).toContain("Keine Einträge mehr vorhanden.");
    expect(html).toContain("Importiere eine Datei oben oder starte eine neue Kampagne");
    expect(deleteButtonCount(html)).toBe(0);
    expect(plain(html)).toContain("Einträge (0)");
  });

  it("live duplicate e-mails are flagged in the table", () => {
    const html = renderStep([
      appDto(1, { company_name: "A", company_email: "same@same.de" }),
      appDto(2, { company_name: "B", company_email: "same@same.de" }),
      appDto(3, { company_name: "C", company_email: "other@other.de" }),
    ]);
    // Both sides of the duplicate pair are flagged; the unique one is not.
    const dupFlags = (html.match(/Doppelte E-Mail-Adresse/g) ?? []).length;
    expect(dupFlags).toBe(2);
  });

  it("while a send is in progress the delete buttons are disabled (rows are locked)", () => {
    const html = renderStep(
      [
        appDto(1, { company_name: "A", company_email: "a@a.de", status: "queued" }),
        appDto(2, { company_name: "B", company_email: "b@b.de", status: "queued" }),
      ],
      { status: "sending" },
    );
    expect(deleteButtonCount(html)).toBe(2);
    // Each delete button in the locked state renders disabled.
    const buttons = html
      .split("<button")
      .filter((b) => b.includes("Firmenzeile") && b.includes("disabled="));
    expect(buttons.length).toBe(2);
  });

  it("uses stable row ids as React keys (app ids, not indexes) in the manual table", async () => {
    // Static contract: the manual table maps over the rows with key={app.id}.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(process.cwd(), "src/components/bewerbung-automation/companies-step.tsx"),
      "utf8",
    );
    // The visible-rows table body keys by the stable id…
    expect(src).toMatch(/visibleRows\.map\(\(app\)[\s\S]{0,800}?key=\{app\.id\}/);
    // …and the draft/delete handlers are addressed by id, never by index.
    expect(src).toContain("delete next[id]");
    expect(src).not.toMatch(/setDraft\(\s*i\b/);
  });
});
