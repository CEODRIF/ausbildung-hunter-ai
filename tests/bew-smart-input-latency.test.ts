/**
 * Issue 2 — Smart Input analysis latency.
 *
 * Pins the server-side concurrency fix in `checkBewSmartInput`: the campaign
 * rows snapshot (needed only for the duplicate/cap checks) must be fetched
 * CONCURRENTLY with the (slow) AI extraction, not serially after it. Without
 * this overlap every analysis pays one extra serial DB round trip on top of
 * the Gemini call.
 *
 * The AI is driven by a controllable promise so the test can assert that the
 * rows SELECT has already been issued while the AI is still in flight — which
 * is impossible under the old sequential code (rows read only after the AI
 * resolved).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseAdvertisement } from "@/lib/bew-ad-parser";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
interface DB {
  bew_campaigns: Row[];
  bew_applications: Row[];
  /** Counts every SELECT issued on bew_applications. */
  appSelects: number;
}
let db: DB;

const USER = "user-1";
const CAMPAIGN = "camp-1";

/* Minimal in-memory Supabase-style builder (select + maybeSingle only). */
function makeFrom(table: string) {
  const state = {
    filters: [] as Array<{ col: string; val: any }>,
    selectCols: undefined as any,
    terminal: undefined as "single" | "maybeSingle" | undefined,
  };
  const bucket = (): Row[] => (db as unknown as Record<string, Row[]>)[table] ?? [];
  function rows(): Row[] {
    let out = bucket().slice();
    for (const f of state.filters) out = out.filter((r) => r[f.col] === f.val);
    return out;
  }
  function run(): Promise<any> {
    if (table === "bew_applications") db.appSelects += 1;
    const matched = rows();
    return Promise.resolve({
      data: state.terminal ? matched[0] ?? null : matched,
      error: null,
    });
  }
  const chain: any = {
    eq: (col: string, val: any) => (state.filters.push({ col, val }), chain),
    select: (cols?: any) => ((state.selectCols = cols), chain),
    maybeSingle: () => ((state.terminal = "maybeSingle"), chain),
    single: () => ((state.terminal = "single"), chain),
    then: (onF?: any, onR?: any) => run().then(onF, onR),
  };
  return chain;
}

/* Controlled AI extraction: resolves only when the test calls resolveAI(). */
let aiStarted = false;
let aiPromise: Promise<any>;
let resolveAI: (v: any) => void = () => {};
const flush = () => new Promise((r) => setTimeout(r, 0));

vi.doMock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (t: string) => makeFrom(t),
    rpc: () => Promise.resolve({ data: null, error: null }),
    storage: {
      from: () => ({
        download: async () => ({
          data: { arrayBuffer: async () => new Uint8Array([1]).buffer },
          error: null,
        }),
        upload: async () => ({ error: null }),
        remove: async () => ({ error: null }),
      }),
    },
  }),
}));
vi.doMock("@/lib/bew-ad-ai", () => ({
  extractSmartAd: () => {
    aiStarted = true;
    return aiPromise;
  },
  validateReviewedFields: (x: any) => x,
}));
vi.doMock("@/lib/ai-provider", () => ({
  createAIProvider: () => ({ generateText: async () => "x" }),
}));
vi.doMock("@/lib/ai-service", () => ({
  reserveAIUsage: async () => {},
  storagePath: () => "x",
}));
vi.doMock("@/lib/pdf-extract", () => ({ extractPdfText: async () => "" }));
vi.doMock("@/lib/application-drafts", () => ({
  sanitizeEmailHtml: (h: string) => h,
  htmlToText: (h: string) => h,
}));
vi.doMock("@/lib/email-campaigns", () => ({
  getUsageSnapshot: async () => ({ remaining: 10, daily_limit: 50 }),
  reserveSenderSlot: async () => true,
}));
vi.doMock("@/lib/email-providers", () => ({
  createEmailProvider: async () => ({
    sendEmail: async () => ({ ok: true, id: "m" }),
  }),
}));
vi.doMock("@/lib/bew-letter-pdf", () => ({
  BEW_ATTACHMENT_BUCKET: "b",
  ensureLetterPdf: async () => {},
  deleteLetterPdf: async () => {},
  letterPdfStoragePath: () => "p",
}));
vi.doMock("mammoth", () => ({
  default: { extractRawText: async () => ({ value: "docx" }) },
}));
vi.doMock("@/lib/contact-name-support", () => ({
  hasApplicantProfileColumns: () => Promise.resolve(true),
}));

const {
  checkBewSmartInput,
  resetBewPositionColumnsProbe,
  resetBewSmartColumnsProbe,
  resetBewAdDateColumnsProbe,
} = await import("@/lib/bewerbung-engine");

beforeEach(() => {
  db = { bew_campaigns: [], bew_applications: [], appSelects: 0 };
  db.bew_campaigns.push({
    id: CAMPAIGN,
    user_id: USER,
    status: "draft",
    purpose: "ausbildung",
  });
  db.bew_applications.push({
    id: "a1",
    campaign_id: CAMPAIGN,
    user_id: USER,
    seq: 1,
    status: "generated",
    company_email: "x@y.de",
  });
  resetBewPositionColumnsProbe();
  resetBewSmartColumnsProbe();
  resetBewAdDateColumnsProbe();
  aiStarted = false;
  aiPromise = new Promise((r) => {
    resolveAI = r;
  });
});

describe("checkBewSmartInput — analysis latency", () => {
  it("reads the campaign rows snapshot CONCURRENTLY with the AI (not after it)", async () => {
    const text = "Ausbildung: Mechatroniker\nMuster GmbH\nE-Mail: a@muster.de";
    const pending = checkBewSmartInput(USER, CAMPAIGN, text);
    // Flush microtasks so the ownership check resolves and the Promise.all
    // (AI + rows snapshot) has been set up. The AI promise is still pending.
    await flush();
    expect(aiStarted).toBe(true);
    // PROOF OF CONCURRENCY: the rows SELECT already ran while the AI is in
    // flight. Under the old sequential code this would be 0 until the AI
    // resolved.
    expect(db.appSelects).toBeGreaterThanOrEqual(1);
    expect(aiPromise).toBeInstanceOf(Promise);
    // Now let the (slow) AI finish; the result must be intact.
    resolveAI({
      parsed: parseAdvertisement(text),
      diagnostic: null,
      diagnosticDetail: null,
    });
    const result = await pending;
    expect(result.parsed).toBeInstanceOf(Object);
    expect(result.diagnostic).toBe(null);
    expect(result.issues).toEqual(expect.any(Array));
  });

  it("still returns the deterministic parse + issue list (regression)", async () => {
    const text = "Ausbildung: Fachkraft\nMuster GmbH\nE-Mail: a@muster.de";
    const parsed = parseAdvertisement(text);
    const pending = checkBewSmartInput(USER, CAMPAIGN, text);
    await flush();
    resolveAI({ parsed, diagnostic: null, diagnosticDetail: null });
    const result = await pending;
    expect(result.parsed).toBe(parsed);
  });
});
