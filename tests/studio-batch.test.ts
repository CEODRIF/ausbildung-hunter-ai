/**
 * AI Bewerbung Studio — batch workspace engine tests.
 *
 * Covers the acceptance criteria that live server-side:
 *   - batch limit of 10 (enforced on create)
 *   - the seven-requirement completion model (explicit confirmations)
 *   - strict sequential unlocking (slot N+1 needs slot N complete + saved)
 *   - earlier applications stay editable; edits invalidate completion
 *   - delete: cancels scheduled attempts, refuses mid-send, ownership
 *   - batch view: ownership isolation, slot order, blocking app + exact
 *     missing list, per-app document payloads (no cross-company reuse)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createStudioDb, type StudioDb } from "./helpers-studio";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
const mockAuthUsers = {
  "user-a": { id: "user-a", email: "a@example.de" } as never,
  "user-b": { id: "user-b", email: "b@example.de" } as never,
};
vi.mock("@/lib/auth", () => ({
  getCurrentUserAndProfile: vi.fn(async () => ({
    user: mockAuthUsers["user-a"],
    profile: null,
  })),
}));

import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentUserAndProfile } from "@/lib/auth";
import {
  computeStudioCompletion,
  docsChecklistCovered,
  studioUnlockStates,
  STUDIO_BATCH_LIMIT,
  type StudioCompletion,
} from "@/lib/studio/completion";

let db: StudioDb;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CV_CONTENT = {
  templateId: "classic",
  personal: { fullName: "Test User", email: "test@example.de" },
  summary: "Engagierte Fachkraft.",
  education: [],
  experience: [],
  skills: [],
  languages: [],
  certificates: [],
  projects: [],
  interests: [],
};

function appRow(over: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    user_id: "user-a",
    ad_raw: "x".repeat(60),
    ad_extracted: null,
    ad_analysis: null,
    profile_snapshot: null,
    status: "draft",
    ad_confirmed_at: null,
    profile_confirmed_at: null,
    cv_reviewed_at: null,
    letter_reviewed_at: null,
    checklist_ack_at: null,
    slot_no: 0,
    email_account_id: null,
    recipient_email: null,
    idempotency_key: null,
    approved: false,
    approved_at: null,
    scheduled_at: null,
    schedule_timezone: null,
    sent_at: null,
    provider_message_id: null,
    last_failure_code: null,
    created_at: "2026-12-01T00:00:00.000Z",
    updated_at: "2026-12-01T00:00:00.000Z",
    ...over,
  };
}

/** An app that satisfies every completion requirement (server-side). */
function completeAppRow(over: Record<string, unknown> = {}) {
  return appRow({
    ad_extracted: {
      company: "Tech GmbH",
      jobTitle: "Fachinformatiker",
      location: "Berlin",
      requestedDocuments: ["Schulzeugnis"],
    },
    ad_confirmed_at: "2026-12-01T01:00:00.000Z",
    profile_confirmed_at: "2026-12-01T01:00:00.000Z",
    cv_reviewed_at: "2026-12-01T01:00:00.000Z",
    letter_reviewed_at: "2026-12-01T01:00:00.000Z",
    recipient_email: "hr@tech.de",
    ...over,
  });
}

function completeDocs(appId: string) {
  return [
    { id: "doc-cv", application_id: appId, user_id: "user-a", doc_type: "cv", version: 2, content: CV_CONTENT },
    {
      id: "doc-letter",
      application_id: appId,
      user_id: "user-a",
      doc_type: "cover_letter",
      version: 3,
      content: { text: "Sehr geehrte Damen und Herren, ich bewerbe mich als Fachinformatiker bei Tech GmbH.", tone: "professional" },
    },
    {
      id: "doc-email",
      application_id: appId,
      user_id: "user-a",
      doc_type: "email",
      version: 1,
      content: { subject: "Bewerbung als Fachinformatiker", body: "anbei meine vollständige Bewerbung.", attachmentIds: ["att-1"] },
    },
  ];
}

function attRow(appId: string, name: string, category: string) {
  return {
    id: "att-1",
    application_id: appId,
    user_id: "user-a",
    display_name: name,
    doc_category: category,
    mime_type: "application/pdf",
    size_bytes: 123,
    storage_path: `user-a/studio/att-1-${name}`,
    required: false,
    created_at: "2026-12-01T00:00:00.000Z",
  };
}

const FULL_EXTRACT = {
  jobTitle: "Fachinformatiker",
  occupation: "",
  company: "Tech GmbH",
  companyAddress: "",
  location: "Berlin",
  startDate: "",
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
  applicationEmail: "",
  companyNotes: [],
  missingOrAmbiguous: [],
};

function completionInput(app: Record<string, unknown>, over: Partial<{ docs: boolean; atts: boolean; blocking: boolean }> = {}) {
  const docs = over.docs === false ? { cv: null, letter: null, email: null } : {
    cv: completeDocs("x")[0] as never,
    letter: completeDocs("x")[1] as never,
    email: completeDocs("x")[2] as never,
  };
  return {
    app: app as never,
    docs: docs as never,
    attachments: over.atts === false ? [] : [attRow("x", "Schulzeugnis.pdf", "school_certificate")] as never,
    blockingIssues: over.blocking ? [{ key: "x", severity: "blocking", section: "general", detail: "d" }] : [],
  } as never;
}

// ---------------------------------------------------------------------------
// Pure completion model
// ---------------------------------------------------------------------------

describe("completion model (pure)", () => {
  it("a fully prepared, reviewed and saved app is COMPLETE (no send required)", () => {
    const c = computeStudioCompletion(completionInput(completeAppRow()));
    expect(c.complete).toBe(true);
    expect(c.missing).toEqual([]);
    expect(c.progress).toBe(1);
  });

  it.each([
    ["ad", { ad_confirmed_at: null }],
    ["profile", { profile_confirmed_at: null }],
    ["letter", { letter_reviewed_at: null }],
    ["docs", { checklist_ack_at: null }],
  ] as const)("%s requirement missing → exactly that key is reported", (key, patch) => {
    const c = computeStudioCompletion(
      key === "docs"
        ? completionInput(completeAppRow(patch), { atts: false })
        : completionInput(completeAppRow(patch)),
    );
    expect(c.complete).toBe(false);
    expect(c.missing).toContain(key);
  });

  it("missing CV (no stored document) → cv requirement", () => {
    const c = computeStudioCompletion(completionInput(completeAppRow(), { docs: false }));
    expect(c.missing).toContain("cv");
    expect(c.missing).toContain("letter");
    expect(c.missing).toContain("email");
  });

  it("invalid recipient → email requirement", () => {
    const c = computeStudioCompletion(completionInput(completeAppRow({ recipient_email: "not-an-email" })));
    expect(c.missing).toContain("email");
  });

  it("blocking quality issues → quality requirement", () => {
    const c = computeStudioCompletion(completionInput(completeAppRow(), { blocking: true }));
    expect(c.complete).toBe(false);
    expect(c.missing).toEqual(["quality"]);
  });

  it("sent / scheduled / sending apps are treated as complete (package was validated before dispatch)", () => {
    for (const status of ["sent", "scheduled", "sending"]) {
      const c = computeStudioCompletion(completionInput(appRow({ status })));
      expect(c.complete).toBe(true);
    }
  });

  it("strict sequential unlock: slot N+1 locked until slot N is complete (pairwise)", () => {
    const notComplete: StudioCompletion = { done: {} as never, missing: ["cv"], complete: false, progress: 0.5 };
    const complete: StudioCompletion = { done: {} as never, missing: [], complete: true, progress: 1 };
    // slot 0 always unlocked; slot 1 locked (slot 0 incomplete); slot 2
    // unlocked — its immediate predecessor (slot 1) is complete.
    const slots = studioUnlockStates([notComplete, complete, complete]);
    expect(slots.map((s) => s.unlocked)).toEqual([true, false, true]);
    expect(slots.map((s) => s.complete)).toEqual([false, true, true]);
    // a fully complete chain unlocks everything
    expect(studioUnlockStates([complete, notComplete, complete]).map((s) => s.unlocked)).toEqual([true, true, false]);
  });

  it("all complete → all slots unlocked", () => {
    const complete: StudioCompletion = { done: {} as never, missing: [], complete: true, progress: 1 };
    const slots = studioUnlockStates([complete, complete, complete]);
    expect(slots.every((s) => s.unlocked)).toBe(true);
  });

  it("docs checklist: empty request is trivially covered; a matching upload covers; a gap does not", () => {
    expect(docsChecklistCovered(null, [])).toBe(true);
    expect(docsChecklistCovered({ requestedDocuments: ["Schulzeugnis"] } as never, [attRow("a", "Schulzeugnis 2026.pdf", "other")])).toBe(true);
    expect(docsChecklistCovered({ requestedDocuments: ["Sprachzertifikat"] } as never, [attRow("a", "Schulzeugnis.pdf", "school_certificate")])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Engine (in-memory db)
// ---------------------------------------------------------------------------

function studio() {
  vi.resetModules();
  return import("@/lib/studio");
}

beforeEach(() => {
  db = createStudioDb({
    studio_applications: [appRow()],
    email_accounts: [
      { id: "acct-1", user_id: "user-a", provider: "gmail", email: "a@gmail.com", is_active: true, requires_reconnect: false },
    ],
  });
  (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
  vi.mocked(getCurrentUserAndProfile).mockReset();
  vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
    user: mockAuthUsers["user-a"],
    profile: null,
  });
});

describe("batch limit (server-enforced)", () => {
  it(`refuses the 11th application with batch_full (${STUDIO_BATCH_LIMIT} is the cap)`, async () => {
    db.tables.studio_applications = Array.from({ length: STUDIO_BATCH_LIMIT }, (_, i) =>
      appRow({ id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`, created_at: `2026-12-0${(i % 9) + 1}T00:00:00.000Z` }),
    );
    const { createStudioApplication } = await studio();
    const res = await createStudioApplication("user-a", { adRaw: "x".repeat(60) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("batch_full");
    expect(db.tables.studio_applications.length).toBe(STUDIO_BATCH_LIMIT);
  });

  it("allows creation while below the cap", async () => {
    db.tables.studio_applications = Array.from({ length: STUDIO_BATCH_LIMIT - 1 }, (_, i) =>
      appRow({ id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}` }),
    );
    const { createStudioApplication } = await studio();
    const res = await createStudioApplication("user-a", { adRaw: "x".repeat(60) });
    expect(res.ok).toBe(true);
    expect(db.tables.studio_applications.length).toBe(STUDIO_BATCH_LIMIT);
  });

  it("creates the FIRST application into slot 1", async () => {
    db.tables.studio_applications = [];
    const { createStudioApplication } = await studio();
    const res = await createStudioApplication("user-a", { adRaw: "x".repeat(60) });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value?.slot_no).toBe(1);
  });

  it("fills to exactly 10 active applications (smallest-free-slot assignment)", async () => {
    db.tables.studio_applications = Array.from({ length: STUDIO_BATCH_LIMIT - 1 }, (_, i) =>
      appRow({ id: `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, "0")}`, slot_no: i + 1 }),
    );
    const { createStudioApplication } = await studio();
    const res = await createStudioApplication("user-a", { adRaw: "x".repeat(60) });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value?.slot_no).toBe(STUDIO_BATCH_LIMIT);
    // the 11th is refused on the server
    const again = await createStudioApplication("user-a", { adRaw: "y".repeat(60) });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe("batch_full");
    expect(db.tables.studio_applications.length).toBe(STUDIO_BATCH_LIMIT);
  });

  it("deleting one frees its slot: a replacement succeeds, then the cap applies again (ACTIVE count, not lifetime)", async () => {
    db.tables.studio_applications = Array.from({ length: STUDIO_BATCH_LIMIT }, (_, i) =>
      appRow({ id: `cccccccc-0000-4000-8000-${String(i).padStart(12, "0")}`, slot_no: i + 1 }),
    );
    const { createStudioApplication, deleteStudioApplication } = await studio();
    expect((await createStudioApplication("user-a", { adRaw: "x".repeat(60) })).ok).toBe(false);
    // delete the application holding slot 3
    const victim = db.tables.studio_applications.find((r) => r.slot_no === 3)!;
    const del = await deleteStudioApplication("user-a", victim.id as string);
    expect(del.ok).toBe(true);
    // replacement reuses the freed slot
    const replacement = await createStudioApplication("user-a", { adRaw: "y".repeat(60) });
    expect(replacement.ok).toBe(true);
    if (replacement.ok) expect(replacement.value?.slot_no).toBe(3);
    expect(db.tables.studio_applications.length).toBe(STUDIO_BATCH_LIMIT);
    // …and the cap holds again
    const stillFull = await createStudioApplication("user-a", { adRaw: "z".repeat(60) });
    expect(stillFull.ok).toBe(false);
    if (!stillFull.ok) expect(stillFull.code).toBe("batch_full");
  });

  it("a concurrent create that loses the slot race (unique violation) maps to batch_full", async () => {
    db.tables.studio_applications = Array.from({ length: STUDIO_BATCH_LIMIT - 1 }, (_, i) =>
      appRow({ id: `dddddddd-0000-4000-8000-${String(i).padStart(12, "0")}`, slot_no: i + 1 }),
    );
    // Simulates the race: the rival request already took the last free slot,
    // so our insert hits the partial unique index.
    db.failInsert(
      "studio_applications",
      'duplicate key value violates unique constraint "studio_applications_user_slot_unique"',
    );
    const { createStudioApplication } = await studio();
    const res = await createStudioApplication("user-a", { adRaw: "x".repeat(60) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("batch_full");
    expect(db.tables.studio_applications.length).toBe(STUDIO_BATCH_LIMIT - 1);
  });

  it("the migration defines the partial unique index (the production race backstop)", () => {
    const sql = readFileSync(
      new URL("../supabase/migrations/20261212000000_studio_slot_no.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toMatch(/create unique index if not exists studio_applications_user_slot_unique/i);
    expect(sql).toMatch(/where slot_no > 0/i);
  });

  it("deleting one application leaves another application's documents and attachments intact", async () => {
    const aId = "aaaaaaaa-0000-4000-8000-000000000001";
    const bId = "bbbbbbbb-0000-4000-8000-000000000002";
    db.tables.studio_applications = [appRow({ id: aId, slot_no: 1 }), appRow({ id: bId, slot_no: 2 })];
    for (const id of [aId, bId]) {
      for (const d of completeDocs(id)) db.tables.studio_documents.push(d);
      db.tables.studio_attachments.push(attRow(id, "Zeugnis.pdf", "school_certificate"));
    }
    const { deleteStudioApplication } = await studio();
    const del = await deleteStudioApplication("user-a", aId);
    expect(del.ok).toBe(true);
    expect(db.tables.studio_applications.map((r) => r.id)).toEqual([bId]);
    // B's data untouched
    expect(db.tables.studio_documents.filter((r) => r.application_id === bId).length).toBeGreaterThan(0);
    expect(db.tables.studio_attachments.filter((r) => r.application_id === bId).length).toBe(1);
    // A's data gone
    expect(db.tables.studio_documents.some((r) => r.application_id === aId)).toBe(false);
    expect(db.tables.studio_attachments.some((r) => r.application_id === aId)).toBe(false);
  });

  it("deletion does not corrupt ordering or accidentally unlock incomplete apps (chain recomputed)", async () => {
    const aId = "aaaaaaaa-0000-4000-8000-000000000001";
    const bId = "bbbbbbbb-0000-4000-8000-000000000002";
    const cId = "cccccccc-0000-4000-8000-000000000003";
    // A incomplete (slot 1), B + C complete (slots 2, 3)
    db.tables.studio_applications = [
      appRow({ id: aId, slot_no: 1, created_at: "2026-12-01T00:00:00.000Z" }),
      completeAppRow({ id: bId, slot_no: 2, created_at: "2026-12-02T00:00:00.000Z" }),
      completeAppRow({ id: cId, slot_no: 3, created_at: "2026-12-03T00:00:00.000Z" }),
    ];
    for (const id of [bId, cId]) {
      for (const d of completeDocs(id)) db.tables.studio_documents.push(d);
      db.tables.studio_attachments.push(attRow(id, "Schulzeugnis.pdf", "school_certificate"));
    }
    const { getStudioBatchView, deleteStudioApplication } = await studio();
    const before = (await getStudioBatchView("user-a"))!;
    expect(before.apps.map((v) => v.app.id)).toEqual([aId, bId, cId]);
    const unlocked = (view: NonNullable<Awaited<ReturnType<typeof getStudioBatchView>>>, id: string) =>
      view.apps.find((v) => v.app.id === id)!.slot.unlocked;
    expect(unlocked(before, aId)).toBe(true);
    expect(unlocked(before, bId)).toBe(false); // A is incomplete
    expect(unlocked(before, cId)).toBe(true); // B is complete (pairwise rule)

    await deleteStudioApplication("user-a", bId);
    const after = (await getStudioBatchView("user-a"))!;
    expect(after.apps.map((v) => v.app.id)).toEqual([aId, cId]); // order preserved
    expect(unlocked(after, aId)).toBe(true);
    expect(unlocked(after, cId)).toBe(false); // C now sits behind incomplete A — no accidental unlock
  });
});

describe("explicit confirmations", () => {
  it("markStudioStepConfirmed stamps the matching timestamp (server-owned)", async () => {
    const { markStudioStepConfirmed } = await studio();
    const res = await markStudioStepConfirmed("user-a", "11111111-1111-4111-8111-111111111111", "cv");
    expect(res.ok).toBe(true);
    const row = db.tables.studio_applications[0] as ReturnType<typeof appRow>;
    expect(row.cv_reviewed_at).toBeTruthy();
  });

  it("cross-user confirmation is impossible (not_found, no side effect)", async () => {
    const { markStudioStepConfirmed } = await studio();
    const res = await markStudioStepConfirmed("user-b", "11111111-1111-4111-8111-111111111111", "ad");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("not_found");
    expect((db.tables.studio_applications[0] as ReturnType<typeof appRow>).ad_confirmed_at).toBeNull();
  });
});

describe("completion invalidation on edit", () => {
  it("re-saving the extraction re-opens the 'ad' confirmation", async () => {
    db.tables.studio_applications = [completeAppRow()];
    const { updateStudioApplication } = await studio();
    const res = await updateStudioApplication("user-a", "11111111-1111-4111-8111-111111111111", {
      ad_extracted: { ...FULL_EXTRACT, company: "Neu AG", jobTitle: "Bürokaufmann" },
    });
    expect(res.ok).toBe(true);
    const row = db.tables.studio_applications[0] as ReturnType<typeof completeAppRow>;
    expect(row.ad_confirmed_at).toBeNull();
    expect(row.profile_confirmed_at).not.toBeNull(); // untouched requirement
  });

  it("a new CV document version re-opens the 'cv' review", async () => {
    db.tables.studio_applications = [completeAppRow()];
    const { saveStudioDocument } = await studio();
    const res = await saveStudioDocument("user-a", "11111111-1111-4111-8111-111111111111", "cv", CV_CONTENT);
    expect(res.ok).toBe(true);
    const row = db.tables.studio_applications[0] as ReturnType<typeof completeAppRow>;
    expect(row.cv_reviewed_at).toBeNull();
    expect(row.letter_reviewed_at).not.toBeNull();
  });

  it("a new letter version re-opens the 'letter' review", async () => {
    db.tables.studio_applications = [completeAppRow()];
    const { saveStudioDocument } = await studio();
    const res = await saveStudioDocument(
      "user-a",
      "11111111-1111-4111-8111-111111111111",
      "cover_letter",
      { text: "Neues Anschreiben für Tech GmbH.", tone: "professional" },
    );
    expect(res.ok).toBe(true);
    const row = db.tables.studio_applications[0] as ReturnType<typeof completeAppRow>;
    expect(row.letter_reviewed_at).toBeNull();
  });
});

describe("delete application", () => {
  it("cannot be deleted while a send is in flight (not_deletable)", async () => {
    db.tables.studio_applications = [appRow({ status: "sending" })];
    const { deleteStudioApplication } = await studio();
    const res = await deleteStudioApplication("user-a", "11111111-1111-4111-8111-111111111111");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("not_deletable");
    expect(db.tables.studio_applications.length).toBe(1);
  });

  it("cancels the scheduled attempt BEFORE deleting (never sends after deletion)", async () => {
    db.tables.studio_applications = [appRow({ status: "scheduled", scheduled_at: "2026-12-31T09:00:00.000Z" })];
    db.tables.studio_send_attempts = [
      {
        id: "att-1",
        application_id: "11111111-1111-4111-8111-111111111111",
        user_id: "user-a",
        idempotency_key: "ik-1",
        recipient_email: "hr@tech.de",
        subject: "Bewerbung",
        payload: { html: "", text: "x", attachments: [] },
        status: "queued",
        scheduled_at: "2026-12-31T09:00:00.000Z",
        attempt_count: 0,
        next_attempt_at: null,
        provider_message_id: null,
        failure_code: null,
        failure_message: null,
        sent_at: null,
      },
    ];
    db.tables.studio_attachments = [attRow("11111111-1111-4111-8111-111111111111", "Schulzeugnis.pdf", "school_certificate")];
    const { deleteStudioApplication } = await studio();
    const res = await deleteStudioApplication("user-a", "11111111-1111-4111-8111-111111111111");
    expect(res.ok).toBe(true);
    expect(db.tables.studio_applications.length).toBe(0);
    // The attempt row is cancelled (it would cascade with the app, but the
    // explicit cancel must have happened first — verify via the recorded
    // update call on the attempt).
    const cancelCall = db.calls.find(
      (c) => c.table === "studio_send_attempts" && c.op === "update" && (c.args[0] as { status?: string }).status === "cancelled",
    );
    expect(cancelCall).toBeTruthy();
    // Private file removal was attempted.
    const storageRemoval = db.calls.some((c) => c.op === "storage" && Array.isArray((c.filters as { remove?: unknown[] }).remove));
    expect(storageRemoval).toBe(true);
  });

  it("cross-user delete is impossible", async () => {
    const { deleteStudioApplication } = await studio();
    const res = await deleteStudioApplication("user-b", "11111111-1111-4111-8111-111111111111");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("not_found");
    expect(db.tables.studio_applications.length).toBe(1);
  });
});

describe("batch view (getStudioBatchView)", () => {
  it("isolates by owner, orders slots by created_at, and reports the exact blocking app + missing list", async () => {
    db.tables.studio_applications = [
      // user-b's app must NEVER appear in user-a's batch view.
      appRow({ id: "bbbbbbbb-0000-4000-8000-00000000000b", user_id: "user-b", created_at: "2026-11-30T00:00:00.000Z" }),
      // slot 1 (older): incomplete — missing ad + profile + cv + letter + email + quality
      appRow({ id: "aaaaaaaa-0000-4000-8000-000000000001", created_at: "2026-12-01T00:00:00.000Z" }),
      // slot 2 (newer): would be complete, but is LOCKED behind slot 1
      completeAppRow({ id: "aaaaaaaa-0000-4000-8000-000000000002", created_at: "2026-12-02T00:00:00.000Z" }),
    ];
    db.tables.studio_documents = [...completeDocs("aaaaaaaa-0000-4000-8000-000000000002")];
    db.tables.studio_attachments = [attRow("aaaaaaaa-0000-4000-8000-000000000002", "Schulzeugnis.pdf", "school_certificate")];

    const { getStudioBatchView } = await studio();
    const view = await getStudioBatchView("user-a");
    expect(view).not.toBeNull();
    if (!view) return;
    expect(view.apps.length).toBe(2); // user-b's row excluded
    expect(view.apps.map((v) => v.app.id)).toEqual([
      "aaaaaaaa-0000-4000-8000-000000000001",
      "aaaaaaaa-0000-4000-8000-000000000002",
    ]);
    // slot 1 unlocked but incomplete → blocks slot 2 (unlock rule preserved:
    // slot 2 stays LOCKED even though its own data is complete)
    expect(view.apps[0].slot.unlocked).toBe(true);
    expect(view.apps[0].slot.complete).toBe(false);
    expect(view.apps[1].slot.unlocked).toBe(false);
    // CREATION is cap-gated, NOT completion-gated (bug fix: the Add button
    // must work while apps are incomplete). The blocking app is still
    // reported — the navigator uses it for the ghost-slot lock hint.
    expect(view.canAdd).toBe(true);
    expect(view.blockingAppId).toBe("aaaaaaaa-0000-4000-8000-000000000001");
    expect(view.missingForBlockingApp.length).toBeGreaterThan(0);
    // the locked slot 2 is COMPLETE (its data is done) — counting ≠ unlocked
    expect(view.completeCount).toBe(1);
  });

  it("canAdd is false at the 10-app cap (and only then), regardless of completion", async () => {
    const nine = Array.from({ length: STUDIO_BATCH_LIMIT - 1 }, (_, i) =>
      appRow({ id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`, created_at: `2026-12-0${(i % 8) + 1}T0${i % 10}:00:00.000Z` }),
    );
    db.tables.studio_applications = nine;
    const { getStudioBatchView } = await studio();
    let view = (await getStudioBatchView("user-a"))!;
    expect(view.apps.length).toBe(STUDIO_BATCH_LIMIT - 1);
    expect(view.apps[0].slot.complete).toBe(false); // all nine are incomplete drafts
    expect(view.canAdd).toBe(true); // 9 < 10 → Add must be available

    // the 10th app (complete this time) → cap reached → canAdd false
    db.tables.studio_applications = [
      ...nine,
      completeAppRow({ id: "aaaaaaaa-0000-4000-8000-000000000009", created_at: "2026-12-09T09:00:00.000Z" }),
    ];
    db.tables.studio_documents = completeDocs("aaaaaaaa-0000-4000-8000-000000000009");
    db.tables.studio_attachments = [attRow("aaaaaaaa-0000-4000-8000-000000000009", "Schulzeugnis.pdf", "school_certificate")];
    view = (await getStudioBatchView("user-a"))!;
    expect(view.apps.length).toBe(STUDIO_BATCH_LIMIT);
    expect(view.canAdd).toBe(false);
  });

  it("bulk-loads child rows: exactly ONE query per child table for the whole batch (no N+1)", async () => {
    const a1 = completeAppRow({ id: "aaaaaaaa-0000-4000-8000-000000000001", created_at: "2026-12-01T00:00:00.000Z" });
    const a2 = completeAppRow({ id: "aaaaaaaa-0000-4000-8000-000000000002", created_at: "2026-12-02T00:00:00.000Z" });
    db.tables.studio_applications = [a1, a2];
    db.tables.studio_documents = [
      ...completeDocs(a1.id as string).map((d) => ({ ...d, id: `${d.id}-1` })),
      ...completeDocs(a2.id as string).map((d) => ({ ...d, id: `${d.id}-2` })),
    ];
    db.tables.studio_attachments = [
      { ...attRow(a1.id as string, "Schulzeugnis.pdf", "school_certificate"), id: "att-1" },
      { ...attRow(a2.id as string, "Schulzeugnis.pdf", "school_certificate"), id: "att-2" },
    ];
    const { getStudioBatchView } = await studio();
    await getStudioBatchView("user-a");
    for (const table of ["studio_documents", "studio_attachments", "studio_send_attempts"]) {
      // child-row selects only (hasStudioSchema's table probe is unrelated)
      const childSelects = db.calls.filter(
        (c) => c.table === table && c.op === "select" && (c.filters["in:application_id"] || c.filters["eq:application_id"]),
      );
      // exactly ONE bulk query for the whole batch (was 2 per app before)
      expect(childSelects.length, `${table} queried ${childSelects.length}×`).toBe(1);
      // …keyed by IN (…all batch ids…), never one eq per app
      expect(childSelects[0].filters["in:application_id"]).toEqual(
        expect.arrayContaining([a1.id, a2.id]),
      );
      expect(childSelects[0].filters["eq:application_id"]).toBeUndefined();
    }
  });

  it("all complete → every slot unlocked and canAdd=true (no send required)", async () => {
    const a1 = completeAppRow({ id: "aaaaaaaa-0000-4000-8000-000000000001", created_at: "2026-12-01T00:00:00.000Z" });
    const a2 = completeAppRow({ id: "aaaaaaaa-0000-4000-8000-000000000002", created_at: "2026-12-02T00:00:00.000Z" });
    db.tables.studio_applications = [a1, a2];
    db.tables.studio_documents = [
      ...completeDocs(a1.id as string).map((d) => ({ ...d, id: `${d.id}-1` })),
      ...completeDocs(a2.id as string).map((d) => ({ ...d, id: `${d.id}-2` })),
    ];
    db.tables.studio_attachments = [
      { ...attRow(a1.id as string, "Schulzeugnis.pdf", "school_certificate"), id: "att-1" },
      { ...attRow(a2.id as string, "Schulzeugnis.pdf", "school_certificate"), id: "att-2" },
    ];
    const { getStudioBatchView } = await studio();
    const view = await getStudioBatchView("user-a");
    expect(view).not.toBeNull();
    if (!view) return;
    expect(view.apps.every((v) => v.slot.complete)).toBe(true);
    expect(view.apps.every((v) => v.slot.unlocked)).toBe(true);
    expect(view.canAdd).toBe(true);
    expect(view.blockingAppId).toBeNull();
    // per-app payload separation: each app carries its OWN stored email
    expect(view.apps[0].emailSubject).toBe("Bewerbung als Fachinformatiker");
    expect(view.apps[0].emailBody).toContain("anbei");
    expect(view.apps[1].emailSubject).toBe("Bewerbung als Fachinformatiker");
    expect(view.apps[0].docVersions).toEqual({ cv: 2, letter: 3, email: 1 });
  });

  it("returns null when the schema is pending (graceful, not an error)", async () => {
    db.failTables(["studio_applications", "studio_documents", "studio_attachments", "studio_send_attempts"]);
    const { getStudioBatchView } = await studio();
    const view = await getStudioBatchView("user-a");
    expect(view).toBeNull();
  });
});

describe("actions layer (ownership re-resolved from the session)", () => {
  it("confirmStepAction rejects fields outside the whitelist", async () => {
    vi.resetModules();
    const actions = await import("@/app/bewerbung-studio/actions");
    const res = await actions.confirmStepAction("11111111-1111-4111-8111-111111111111", "recipient_email");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("invalid_field");
  });

  it("deleteApplicationAction refuses a cross-user target (session identity wins)", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValueOnce({
      user: mockAuthUsers["user-b"],
      profile: null,
    });
    vi.resetModules();
    const actions = await import("@/app/bewerbung-studio/actions");
    const res = await actions.deleteApplicationAction("11111111-1111-4111-8111-111111111111");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("not_found");
    expect(db.tables.studio_applications.length).toBe(1);
  });
});
