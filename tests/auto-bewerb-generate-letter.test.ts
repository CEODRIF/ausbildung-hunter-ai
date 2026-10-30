/**
 * AUTO BEWERB — /api/auto-bewerb/generate-letter route contract.
 *
 * The route generates the individualized Anschreiben for ONE company from
 * the verified profile + the company's stored ad context (full extraction
 * + match analysis + fenced ad text). Pinned here:
 *   1. auth + per-company preconditions (401 / no_company / no_extract /
 *      profile_required),
 *   2. the `cover_letter` quota meter (reserve before the model call,
 *      complete on success, release on failure — denials never call the
 *      model),
 *   3. SINGLE-FLIGHT per (user, company): identical concurrent requests
 *      share ONE paid provider call (duplicate concurrent generation is
 *      prevented),
 *   4. the prompt reaches the provider with the company-specific context
 *      (company A's letter never embeds company B's ad facts),
 *   5. invalid model output → honest 502 + quota release.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
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
vi.mock("@/lib/auto-bewerb/engine", () => ({
  getAutoBewerbCompany: vi.fn(),
  getAutoBewerbProfile: vi.fn(),
}));

const { createClient } = await import("@/lib/supabase/server");
const { createAdminClient } = await import("@/lib/supabase/admin");
const { provider } = await import("@/lib/ai-service");
const {
  reserveFeatureOp,
  completeFeatureOp,
  releaseFeatureOp,
} = await import("@/lib/billing/entitlement-service");
const { checkRateLimit } = await import("@/lib/rate-limit");
const {
  getAutoBewerbCompany,
  getAutoBewerbProfile,
} = await import("@/lib/auto-bewerb/engine");
const { POST } = await import("@/app/api/auto-bewerb/generate-letter/route");

const USER = "11111111-1111-4111-8111-111111111111";
const BASE = "http://localhost/api/auto-bewerb/generate-letter";

const EXTRACT_A = {
  jobTitle: "Auszubildende:r Anlagenmechaniker SHK",
  occupation: "Anlagenmechaniker SHK",
  company: "Kältebau Nord GmbH",
  companyAddress: "Hafenstraße 1, 20457 Hamburg",
  location: "Hamburg",
  startDate: "01.08.2026",
  applicationDeadline: "",
  requiredQualifications: ["Schaltpläne lesen"],
  preferredQualifications: [],
  technicalSkills: ["Kälteanlagen"],
  softSkills: ["Teamfähigkeit"],
  languageRequirements: ["Deutsch B1"],
  educationRequirement: "",
  responsibilities: [],
  requestedDocuments: [],
  applicationMethod: "",
  contactPerson: "Frau Schneider",
  applicationEmail: "",
  companyNotes: [],
  missingOrAmbiguous: [],
};
const EXTRACT_B = {
  ...EXTRACT_A,
  jobTitle: "Fachinformatiker — Systemintegration",
  occupation: "Fachinformatiker",
  company: "Tech Süd AG",
  location: "Stuttgart",
  technicalSkills: ["Kubernetes"],
  softSkills: [],
  languageRequirements: [],
  contactPerson: "",
};

function bundle(extract: Record<string, unknown> | null, analysis: Record<string, unknown> | null = null) {
  return {
    company: {
      id: "comp-x",
      ad_raw: "Ausbildung gesucht — vollständige Anzeigetextprobe.",
      ad_extracted: extract,
      ad_analysis: analysis,
    },
    documents: [],
    attempts: [],
  } as never;
}

const ANALYSIS_A = {
  matched: [{ requirement: "Schaltpläne lesen", note: "Praktikum" }],
  transferable: [{ requirement: "Teamfähigkeit" }],
  missing: [{ requirement: "Führerschein Klasse B" }],
};

const PROFILE = {
  fileName: "cv.pdf",
  mimeType: "application/pdf",
  sizeBytes: 1,
  cvHash: "x",
  analyzedAt: "2026-01-01T00:00:00.000Z",
  extracted: {
    candidate: { full_name: "Mustapha Drif", location: "Hamburg", country: "Deutschland" },
    experience: [{ job_title: "Praktikant Kältetechnik", company: "Kältebau Nord GmbH" }],
    skills: { technical: ["Schaltpläne lesen"] },
  },
} as never;

const LETTER_OK =
  "Sehr geehrte Frau Schneider,\n\nmit großem Interesse bewerbe ich mich um die Ausbildungsstelle als Anlagenmechaniker SHK. In meinem Praktikum bei Kältebau Nord habe ich Montage und Instandhaltung von Kälteanlagen mitverfolgt.\n\nMit freundlichen Grüßen\nMustapha Drif";

const generateText = vi.fn(async () => LETTER_OK);

beforeEach(() => {
  vi.clearAllMocks();
  generateText.mockClear();
  generateText.mockImplementation(async () => LETTER_OK);
  (createClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: USER } } }) },
  } as never);
  (createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { full_name: "Mustapha Drif" } }) }),
      }),
    }),
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
  (getAutoBewerbCompany as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(bundle(EXTRACT_A, ANALYSIS_A));
  (getAutoBewerbProfile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(PROFILE);
});

const post = (companyId = "comp-x", currentText?: string) =>
  POST(
    new Request(BASE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ companyId, currentText }),
    }),
  );

/** The prompt text handed to the provider (last call, first message). */
const lastPrompt = (): string =>
  String(((generateText.mock.calls as unknown as unknown[][]).at(-1)?.[0] as Array<{ content: string }> | undefined)?.[0]
    ?.content);

describe("auth + preconditions", () => {
  it("unauthenticated → 401, model never called", async () => {
    (createClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: null } }) },
    } as never);
    const res = await post();
    expect(res.status).toBe(401);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("unknown / foreign company → 400 no_company", async () => {
    (getAutoBewerbCompany as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await post();
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe("no_company");
    expect(generateText).not.toHaveBeenCalled();
  });

  it("company without an ad analysis → 400 no_extract", async () => {
    (getAutoBewerbCompany as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(bundle(null));
    const res = await post();
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe("no_extract");
    expect(generateText).not.toHaveBeenCalled();
  });

  it("missing extracted profile → 400 profile_required", async () => {
    (getAutoBewerbProfile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ extracted: null });
    const res = await post();
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe("profile_required");
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
});

describe("cover_letter quota metering", () => {
  it("quota exhausted → 429 with code, model never called", async () => {
    (reserveFeatureOp as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ outcome: "quota_exhausted" });
    const res = await post();
    expect(res.status).toBe(429);
    expect(((await res.json()) as { code?: string }).code).toBe("quota_exhausted");
    expect(generateText).not.toHaveBeenCalled();
  });

  it("feature disabled → 403, model never called", async () => {
    (reserveFeatureOp as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ outcome: "feature_disabled" });
    const res = await post();
    expect(res.status).toBe(403);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("success → the operation is COMPLETED (quota charged)", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(completeFeatureOp).toHaveBeenCalledTimes(1);
    expect(releaseFeatureOp).not.toHaveBeenCalled();
    expect(((await res.json()) as { letter?: { text: string } }).letter?.text).toContain("Anlagenmechaniker SHK");
  });

  it("invalid model output (too short) → 502 invalid_ai_output + the reservation is RELEASED", async () => {
    generateText.mockImplementation(async () => "Zu kurz.");
    const res = await post();
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code?: string }).code).toBe("invalid_ai_output");
    expect(releaseFeatureOp).toHaveBeenCalledTimes(1);
    expect(completeFeatureOp).not.toHaveBeenCalled();
  });

  it("provider failure → the reservation is RELEASED (never charged)", async () => {
    generateText.mockImplementation(async () => {
      throw new Error("provider down");
    });
    const res = await post();
    expect(res.status).toBe(400);
    expect(releaseFeatureOp).toHaveBeenCalledTimes(1);
    expect(completeFeatureOp).not.toHaveBeenCalled();
  });
});

describe("single-flight + per-company prompt isolation", () => {
  it("identical CONCURRENT requests share ONE provider call (duplicate generation prevented)", async () => {
    // Gate the provider so both requests overlap in time.
    let release: (v: string) => void = () => undefined;
    generateText.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    // Both requests in flight — awaited only AFTER the provider is released.
    const pair = Promise.all([post(), post()]);
    try {
      // The route reaches the provider after several awaited mock hops —
      // poll until the (single) provider call is in flight.
      await vi.waitFor(() => expect(generateText).toHaveBeenCalledTimes(1));
    } finally {
      release(LETTER_OK); // always settle — a pending entry would poison later tests
    }
    const [a, b] = await pair;
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });

  it("company A's prompt carries A's ad facts + analysis — never company B's", async () => {
    await post("comp-x");
    const p = lastPrompt();
    expect(p).toContain("Kältebau Nord GmbH");
    expect(p).toContain("Auszubildende:r Anlagenmechaniker SHK");
    expect(p).toContain("Frau Schneider");
    expect(p).toContain("vorhanden und passend: Schaltpläne lesen");
    expect(p).toContain("NICHT abgedeckt (niemals als vorhanden behaupten): Führerschein Klasse B");
    expect(p).toContain("Praktikant Kältetechnik"); // verified profile fact
    expect(p).not.toContain("Tech Süd AG");
    expect(p).not.toContain("Kubernetes");
  });

  it("company B gets B's own prompt (sequential, per-company isolation)", async () => {
    await post("comp-x");
    (getAutoBewerbCompany as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(bundle(EXTRACT_B, null));
    await post("comp-y");
    const p = lastPrompt();
    expect(p).toContain("Tech Süd AG");
    expect(p).toContain("Kubernetes");
    // Company A's AD-SPECIFIC facts must not leak into B's prompt.
    // ("Kältebau Nord GmbH" may appear legitimately via the candidate's
    // real internship in the verified profile.)
    expect(p).not.toContain("Auszubildende:r Anlagenmechaniker SHK");
    expect(p).not.toContain("Frau Schneider");
    expect(p).not.toContain("Kälteanlagen");
  });

  it("the user's current wording is passed as the improvement anchor", async () => {
    await post("comp-x", "Mein aktueller Entwurfsatz für die Verbesserung.");
    expect(lastPrompt()).toContain("AKTUELLER ENTWURF");
    expect(lastPrompt()).toContain("Mein aktueller Entwurfsatz für die Verbesserung.");
  });
});
