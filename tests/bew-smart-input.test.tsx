/**
 * Smart-input "Auto-organize" — UI orchestration + render tests.
 *
 * Part 1 (pure): runSmartAdd / precheckSmartAdd / appendRowToView /
 *   toApplicationDTO — the safety contract:
 *     - precheck failures never call the persistence layer (no request,
 *       no write, input preserved);
 *     - onRowAdded (the input-clear hook) runs ONLY after a confirmed
 *       insert, and is never called on failure;
 *     - the claim guard makes rapid double clicks a silent no-op;
 *     - appending a row never mutates the other rows or the previous view.
 *
 * Part 2 (SSR): the smart input section renders inside CompaniesStep with
 *   the expected labels/controls, the new Position title + Job description
 *   columns exist, and the pre-existing delete/count behavior is intact.
 */
import React from "react";
import { describe, expect, it } from "vitest";

import {
  appendRowToView,
  precheckSmartAdd,
  runSmartAdd,
  toApplicationDTO,
  type SmartAddDeps,
  type SmartAddRow,
} from "@/components/bewerbung-automation/smart-input-state";
import { parseAdvertisement } from "@/lib/bew-ad-parser";
import type { BewApplicationDTO, BewViewDTO } from "@/components/bewerbung-automation/types";

const { renderToString } = await import("react-dom/server");
const { I18nProvider } = await import("@/lib/i18n");
const { CompaniesStep } = await import(
  "@/components/bewerbung-automation/companies-step"
);

/* ----------------------------- fixtures ----------------------------- */

const AD = [
  "Amberger Kühltechnik GmbH",
  "E-Mail: bernklaustefanie@amberger-kuehltechnik.de",
  "Ausbildung: Mechatroniker/in - Kältetechnik",
  "Beschreibung: Als Mechatroniker für Kältetechnik planst du Anlagen.",
].join("\n");

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

const SERVER_ROW: SmartAddRow = {
  id: "app-new",
  seq: 2,
  company_name: "Amberger Kühltechnik GmbH",
  contact_name: "Frau Bernklau",
  company_email: "bernklaustefanie@amberger-kuehltechnik.de",
  company_address: "Dr.-Aigner-Str. 15, 92224 Amberg, Oberpfalz",
  subject: "Bewerbung um einen Ausbildungsplatz bei Amberger Kühltechnik GmbH",
  body_html: "",
  body_text: "",
  status: "pending",
  error_code: null,
  error_message: null,
  attempt_count: 0,
  provider_message_id: null,
  sent_at: null,
  position_title: "Mechatroniker/in - Kältetechnik",
  position_brief:
    "Als Mechatroniker für Kältetechnik planst du Anlagen.",
  employer_facts: null,
};

function makeView(apps: BewApplicationDTO[]): BewViewDTO {
  return {
    campaign: {
      id: "c1",
      user_id: "user-1",
      email_account_id: "acct-1",
      purpose: "ausbildung",
      status: "draft",
      requested_count: apps.length,
      valid_count: 0,
      total_count: apps.length,
      generated_count: 0,
      sent_count: 0,
      failed_count: 0,
      excluded_count: 0,
      usage_date: "2026-01-01",
      created_at: "2026-01-01T00:00:00Z",
      started_at: null,
      completed_at: null,
    },
    applications: apps,
    documents: [],
    usage: { remaining: 50, daily_limit: 50 },
    senderEmail: "sender@gmail.com",
  };
}

/** Claim-guard machinery for the orchestration tests. */
function makeGuard() {
  let held = false;
  return {
    get held() {
      return held;
    },
    claim: () => {
      if (held) return false;
      held = true;
      return true;
    },
    release: () => {
      held = false;
    },
  };
}

function makeDeps(over: Partial<Omit<SmartAddDeps, "claim" | "release">> & { guard?: ReturnType<typeof makeGuard> } = {}): {
  deps: SmartAddDeps;
  calls: string[];
  /** Raw texts handed to the persistence layer (one entry per real call). */
  addTexts: string[];
  guard: ReturnType<typeof makeGuard>;
} {
  const calls: string[] = [];
  const addTexts: string[] = [];
  const guard = over.guard ?? makeGuard();
  const deps: SmartAddDeps = {
    claim: guard.claim,
    release: guard.release,
    add: over.add ?? (async (raw) => {
      calls.push("add");
      addTexts.push(raw);
      return SERVER_ROW;
    }),
    onRowAdded: over.onRowAdded ?? ((row) => calls.push(`onRowAdded:${row.id}`)),
  };
  return { deps, calls, addTexts, guard };
}

/* ------------------- Part 1: orchestration (pure) ------------------- */

describe("runSmartAdd — safety contract", () => {
  it("success: add is called with the RAW text, onRowAdded after the insert, outcome ok", async () => {
    const { deps, calls, addTexts } = makeDeps();
    const outcome = await runSmartAdd(AD, [], deps);
    expect(outcome).toMatchObject({ ok: true, row: { id: "app-new", seq: 2 } });
    expect(calls).toEqual(["add", "onRowAdded:app-new"]); // insert confirmed BEFORE clear
    expect(addTexts).toEqual([AD]); // the raw pasted text, not a preview parse
  });

  it("empty input: EMPTY_INPUT, add is NEVER called (test 10/11)", async () => {
    for (const text of ["", "   \n  "]) {
      const { deps, calls } = makeDeps();
      const outcome = await runSmartAdd(text, [], deps);
      expect(outcome).toEqual({ ok: false, code: "EMPTY_INPUT", busy: false });
      expect(calls).toEqual([]);
    }
  });

  it("parse failure (no company / no e-mail / invalid e-mail): stable codes, add never called", async () => {
    const cases: Array<[string, string]> = [
      ["jobs@nowhere.de", "PARSE_NO_COMPANY"],
      ["NoMail GmbH\nKein Kontakt.", "PARSE_NO_EMAIL"],
      ["Bad GmbH\nE-Mail: info@bad", "PARSE_INVALID_EMAIL"],
    ];
    for (const [text, code] of cases) {
      const { deps, calls } = makeDeps();
      const outcome = await runSmartAdd(text, [], deps);
      expect(outcome, text).toEqual({ ok: false, code, busy: false });
      expect(calls).toEqual([]);
    }
  });

  it("over-limit brief: POSITION_TOO_LONG, add never called (input stays for the user)", async () => {
    const text = `Big GmbH\nbig@big.de\nBeschreibung: ${"x".repeat(4001)}`;
    const { deps, calls } = makeDeps();
    const outcome = await runSmartAdd(text, [], deps);
    expect(outcome).toEqual({ ok: false, code: "POSITION_TOO_LONG", busy: false });
    expect(calls).toEqual([]);
  });

  it("oversized paste: INVALID_PAYLOAD, add never called", async () => {
    const { deps, calls } = makeDeps();
    const outcome = await runSmartAdd("A".repeat(20_001), [], deps);
    expect(outcome).toEqual({ ok: false, code: "INVALID_PAYLOAD", busy: false });
    expect(calls).toEqual([]);
  });

  it("duplicate e-mail on an ACTIVE row: DUPLICATE_COMPANY, add never called (test 14)", async () => {
    const apps = [appDto(1, { company_email: "same@same.de" })];
    const { deps, calls } = makeDeps();
    const outcome = await runSmartAdd("Dup GmbH\nsame@same.de", apps, deps);
    expect(outcome).toEqual({ ok: false, code: "DUPLICATE_COMPANY", busy: false });
    expect(calls).toEqual([]);
  });

  it("the same e-mail on an EXCLUDED row is allowed (restorable rows don't block)", async () => {
    const apps = [appDto(1, { company_email: "same@same.de", status: "excluded" })];
    const { deps, calls } = makeDeps();
    const outcome = await runSmartAdd("Dup GmbH\nsame@same.de", apps, deps);
    expect(outcome.ok).toBe(true);
    expect(calls).toEqual(["add", "onRowAdded:app-new"]);
  });

  it("the 100-row cap: COUNT_EXCEEDED, add never called", async () => {
    const apps = Array.from({ length: 100 }, (_, i) =>
      appDto(i + 1, { company_email: `r${i}@r.de` }),
    );
    const { deps, calls } = makeDeps();
    const outcome = await runSmartAdd("Full GmbH\nfull@full.de", apps, deps);
    expect(outcome).toEqual({ ok: false, code: "COUNT_EXCEEDED", busy: false });
    expect(calls).toEqual([]);
  });

  it("FAILED persistence: the server code passes through, onRowAdded is NEVER called (test 12)", async () => {
    const { deps, calls } = makeDeps({
      add: async () => {
        calls.push("add");
        throw new Error("DUPLICATE_COMPANY"); // e.g. a race the precheck missed
      },
    });
    const outcome = await runSmartAdd(AD, [], deps);
    expect(outcome).toEqual({ ok: false, code: "DUPLICATE_COMPANY", busy: false });
    expect(calls).toEqual(["add"]); // add ran, onRowAdded (clear) did NOT
  });

  it("unknown server error: falls back to the EXISTING UNKNOWN code (no new generic path)", async () => {
    const { deps } = makeDeps({
      add: async () => {
        throw new Error("500: unexpected db text");
      },
    });
    const outcome = await runSmartAdd(AD, [], deps);
    expect(outcome).toEqual({ ok: false, code: "UNKNOWN", busy: false });
  });

  it("rapid double click: the second call is a silent no-op, add runs ONCE (test 14)", async () => {
    const guard = makeGuard();
    const { deps, calls } = makeDeps({ guard });
    let resolveAdd!: (row: SmartAddRow) => void;
    deps.add = () => {
      calls.push("add");
      return new Promise<SmartAddRow>((r) => (resolveAdd = r));
    };
    const first = runSmartAdd(AD, [], deps);
    const second = await runSmartAdd(AD, [], deps); // while the first is in flight
    expect(second).toEqual({ ok: false, code: "UNKNOWN", busy: true });
    resolveAdd(SERVER_ROW);
    const outcome = await first;
    expect(outcome.ok).toBe(true);
    expect(calls.filter((c) => c === "add")).toHaveLength(1);
    expect(guard.held).toBe(false); // released → the next paste can proceed
  });

  it("the claim is released after a failure too (the user can retry)", async () => {
    const guard = makeGuard();
    const { deps } = makeDeps({ guard, add: async () => { throw new Error("SAVE_FAILED"); } });
    const outcome = await runSmartAdd(AD, [], deps);
    expect(outcome).toMatchObject({ ok: false, code: "SAVE_FAILED" });
    expect(guard.held).toBe(false);
  });

  it("two SEQUENTIAL ads → two independent adds (test 9, client side)", async () => {
    const added: string[] = [];
    const run = (apps: BewApplicationDTO[]) => {
      const { deps } = makeDeps({
        onRowAdded: (dto) => added.push(dto.id),
      });
      return runSmartAdd(AD, apps, deps);
    };
    const first = await run([]);
    const second = await run([appDto(2, { id: "app-new", company_email: "bernklaustefanie@amberger-kuehltechnik.de" })]);
    // The first row now exists in the list → the SAME ad is a duplicate.
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, code: "DUPLICATE_COMPANY", busy: false });
    expect(added).toEqual(["app-new"]);
  });
});

describe("precheckSmartAdd — mirrors the server rules client-side", () => {
  it("passes a clean parse with no conflicts", () => {
    const parsed = parseAdvertisement(AD);
    expect(precheckSmartAdd(parsed, [])).toEqual({ ok: true });
  });

  it("null parse (empty input) → EMPTY_INPUT", () => {
    expect(precheckSmartAdd(null, [])).toEqual({ ok: false, code: "EMPTY_INPUT" });
  });
});

describe("appendRowToView — the append is the ONLY mutation", () => {
  it("appends the new row and re-derives the counters (test 13: previous rows untouched)", () => {
    const view = makeView([
      appDto(1, { company_name: "Alpha GmbH", company_email: "a@a.de" }),
      appDto(2),
    ]);
    const beforeFirst = view.applications[0];

    const next = appendRowToView(view, toApplicationDTO(SERVER_ROW));

    expect(next.applications).toHaveLength(3);
    expect(next.applications[0]).toBe(beforeFirst); // same reference — untouched
    expect(next.applications[1]).toBe(view.applications[1]);
    expect(next.applications[2]).toMatchObject({
      id: "app-new",
      seq: 2,
      company_name: "Amberger Kühltechnik GmbH",
      position_brief: "Als Mechatroniker für Kältetechnik planst du Anlagen.",
    });
    // Counters re-derived with the engine's row rule (2 valid rows).
    expect(next.campaign.total_count).toBe(3);
    expect(next.campaign.valid_count).toBe(2);
    // The PREVIOUS view object is not mutated.
    expect(view.applications).toHaveLength(2);
    expect(view.campaign.total_count).toBe(2);
  });

  it("updates IN PLACE when the id already exists (stale-read convergence)", () => {
    const existing = appDto(9, { company_name: "Old", company_email: "o@o.de" });
    const view = makeView([existing]);
    const next = appendRowToView(view, {
      ...existing,
      company_name: "New Name",
      status: "generated",
    });
    expect(next.applications).toHaveLength(1);
    expect(next.applications[0]).toMatchObject({ company_name: "New Name", status: "generated" });
  });
});

describe("toApplicationDTO — the persisted row maps to the view shape", () => {
  it("keeps the DTO fields and drops the extra server columns", () => {
    // The real persisted row carries extra columns (next_attempt_at, …) that
    // must not leak into the client view shape.
    const rowWithExtras = {
      ...SERVER_ROW,
      next_attempt_at: null,
      created_at: "2026-01-01T00:00:00Z",
    } as unknown as SmartAddRow;
    const dto = toApplicationDTO(rowWithExtras);
    expect(dto).toMatchObject({
      id: "app-new",
      seq: 2,
      position_title: "Mechatroniker/in - Kältetechnik",
      position_brief: "Als Mechatroniker für Kältetechnik planst du Anlagen.",
      employer_facts: null,
    });
    expect("next_attempt_at" in dto).toBe(false);
    expect("created_at" in dto).toBe(false);
  });
});

/* ------------------- Part 2: SSR render (CompaniesStep) ------------------- */

describe("CompaniesStep render — smart input section (test 15–17, 18)", () => {
  /** React SSR emits `<!-- -->` between adjacent text segments — normalize
   *  so string assertions see the rendered text. */
  function plain(html: string): string {
    return html.replace(/<!-- -->/g, "");
  }

  function renderStep(appsList: BewApplicationDTO[]): string {
    const view = makeView(appsList);
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
        }),
      ),
    );
  }

  it("renders the labelled smart input, the preview panel and both action buttons", () => {
    const html = renderStep([appDto(1, { company_name: "A", company_email: "a@a.de" })]);
    expect(html).toContain("Firmen hinzufügen (Smart-Eingabe)");
    expect(html).toContain("die verfügbaren Firmen- und Stellendetails");
    expect(html).toContain("Erkannte Informationen");
    expect(html).toContain("Live-Vorschau");
    expect(html).toContain("Automatisch organisieren");
    expect(html).toContain("Eingabe leeren");
    // The textarea is a real, labelled, length-capped input (not a static mock).
    expect(html).toContain('id="bew-smart-input"');
    expect(html).toContain('maxLength="20000"');
    expect(html).toContain('aria-describedby="bew-smart-input-hint"');
  });

  it("adds the Position title + Job description COLUMNS and the full-text affordance per row", () => {
    const html = renderStep([
      appDto(1, { company_name: "A", company_email: "a@a.de" }),
      appDto(2, {
        company_name: "B",
        company_email: "b@b.de",
        position_title: "Mechatroniker:in",
        position_brief: "Eine längere Stellenbeschreibung, die im Tabellenfeld abgeschnitten wird.",
      }),
    ]);
    // Column headers.
    expect(html).toContain("Stellentitel");
    expect(html).toContain("Stellenbeschreibung");
    // The job description cell is a compact preview WITH a way to the full text.
    expect(html).toContain("Vollständige Stellenbeschreibung anzeigen");
    // The long brief is shown (and its full text is reachable via the modal).
    expect(html).toContain("Eine längere Stellenbeschreibung");
    // The position title is editable in its own column.
    expect(html).toContain("Mechatroniker:in");
  });

  it("keeps ALL pre-existing controls intact (import, template, rows, delete, counters)", () => {
    const html = renderStep([
      appDto(1, { company_name: "A", company_email: "a@a.de" }),
      appDto(2, { company_name: "B", company_email: "b@b.de" }),
    ]);
    // Smart input did not remove anything: file import, template, per-row
    // editing, per-row delete with the numbered accessible label, count.
    expect(html).toContain("Datei-Import (CSV, Excel, PDF)");
    expect(html).toContain("Vorlage (CSV)");
    expect(html).toContain("Firmenzeile 1 löschen");
    expect(html).toContain("Firmenzeile 2 löschen");
    expect(plain(html)).toContain("Einträge (2)");
    // The verified employer facts stay in the per-row edit block.
    expect(html).toContain("Überprüfte Unternehmens-Fakten");
    // Continue-to-documents is still the footer action.
    expect(html).toContain("Zu den Dokumenten");
  });

  it("the verified employer facts field is NOT auto-filled and stays user-only", async () => {
    // Static contract: the engine's smart-add path always inserts
    // employer_facts: null (behavior checked in bew-add-company.test.ts);
    // here the field remains in the per-row UI for manual entry only.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(process.cwd(), "src/lib/bewerbung-engine.ts"),
      "utf8",
    );
    expect(src).toContain("employer_facts: null");
  });
});
