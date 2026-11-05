/**
 * AUTO BEWERB — Step 2 analyze-ad: PROVIDER FAILURE REGRESSION SUITE.
 *
 * Pins the full request lifecycle from the route to a real HTTP provider and
 * back: the REAL `createAIProvider()` (real fetch, real payload, real
 * OpenAI-compatible /chat/completions call) pointed at a local mock server.
 * Only the Supabase/entitlement/rate-limit boundaries are mocked — the
 * provider integration itself is never mocked here.
 *
 * The production incident ("The AI provider is temporarily unavailable."
 * for every Analyze click, no server-side evidence, HTTP 400 to the browser)
 * is prevented by these contracts:
 *   1.  successful analysis returns the structured company + vacancy data,
 *   2.  every provider failure category maps to the correct HTTP status +
 *       stable machine code + retryable flag (auth 401/403, rate limit 429,
 *       provider quota 402/429-credits, timeout, 500/503, network, invalid
 *       JSON, unexpected schema, missing configuration),
 *   3.  the failed request is released from the quota (never charged),
 *   4.  transient failures are RETRYABLE: an identical second request goes
 *       through (the single-flight table does not cache the failure),
 *   5.  concurrent identical requests still share ONE provider call — even
 *       on failure (no duplicate AI requests, no duplicate quota settlement),
 *   6.  the provider's error detail (status body) is classified and logged
 *       server-side with credentials REDACTED — and never forwarded to the
 *       browser,
 *   7.  app-side gating is untouched: unauthenticated 401, feature_disabled
 *       403, quota_exhausted 429 — none of them reach the provider.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/rate-limit", async () => {
  const { NextResponse } = await import("next/server");
  return {
    checkRateLimit: vi.fn(async () => ({ allowed: true, count: 1, limit: 10, retryAfterSeconds: 0 })),
    rateLimitHeaders: vi.fn(() => ({})),
    tooManyRequests: vi.fn(() => NextResponse.json({ error: "RATE_LIMITED_MARKER" }, { status: 429 })),
  };
});
vi.mock("@/lib/billing/entitlement-service", () => ({
  reserveFeatureOp: vi.fn(),
  completeFeatureOp: vi.fn(),
  releaseFeatureOp: vi.fn(),
}));
vi.mock("@/lib/auto-bewerb/engine", () => ({
  getAutoBewerbCompany: vi.fn(),
  getAutoBewerbProfile: vi.fn(),
}));

const { createClient } = await import("@/lib/supabase/server");
const { createAdminClient } = await import("@/lib/supabase/admin");
const {
  reserveFeatureOp,
  completeFeatureOp,
  releaseFeatureOp,
} = await import("@/lib/billing/entitlement-service");
const { getAutoBewerbCompany, getAutoBewerbProfile } = await import("@/lib/auto-bewerb/engine");
const { POST } = await import("@/app/api/auto-bewerb/analyze-ad/route");
const {
  AIProviderError,
  createAIProvider,
  sanitizeProviderDetail,
} = await import("@/lib/ai-provider");
const { AD_ANALYSIS_SYSTEM_PROMPT } = await import("@/lib/studio/prompts");

const USER = "11111111-1111-4111-8111-111111111111";
const API_KEY = "test-api-key-never-logged";

// ---------------------------------------------------------------------------
// The fictional ShopVision test vacancy (never a real company / real data).
// ---------------------------------------------------------------------------
const SHOPVISION_AD = [
  "Kaufmann / Kauffrau im E-Commerce (m/w/d)",
  "",
  "ShopVision Digital GmbH",
  "Hamburg, Vollzeit, Ausbildungsstart 01.08.2027",
  "",
  "Wir suchen zum Ausbildungsstart 2027 eine:n Auszubildende:n als Kaufmann bzw. Kauffrau im E-Commerce (m/w/d) für unser Team in Hamburg.",
  "",
  "Ihre Aufgaben:",
  "- Unterstützung im Online-Marketing (SEO, Google Ads, Social Media)",
  "- Pflege und Weiterentwicklung unseres Web-Shops (Shopware)",
  "- Auswertung von Sales-Reports und KPIs in Excel",
  "- Kundenbetreuung per E-Mail und Telefon",
  "",
  "Ihr Profil:",
  "- Guten Schulabschluss",
  "- Erste Erfahrungen im Online-Handel oder Marketing von Vorteil",
  "- Sicherer Umgang mit Excel und dem MS Office Paket",
  "- Deutsch auf muttersprachlichem Niveau, Englisch mindestens B1",
  "- Teamfähigkeit, Eigeninitiative und analytisches Denken",
  "",
  "Wir bieten:",
  "- 36 Monate Ausbildung mit Übernahmeoption",
  "- Team-Events und Weiterbildungsbudget",
  "",
  "Bewerbung:",
  "Bitte senden Sie Ihre vollständigen Bewerbungsunterlagen (Lebenslauf, die beiden letzten Zeugnisse) per E-Mail bis zum 30.09.2026 an Frau Anna Weber, karriere@shopvision-digital.de.",
].join("\n");

/** The structured answer a healthy provider returns for the ShopVision ad. */
const SUCCESS_PAYLOAD = {
  extract: {
    jobTitle: "Kaufmann / Kauffrau im E-Commerce (m/w/d)",
    occupation: "Kaufmann im E-Commerce",
    company: "ShopVision Digital GmbH",
    companyAddress: "",
    location: "Hamburg",
    startDate: "01.08.2027",
    applicationDeadline: "30.09.2026",
    requiredQualifications: [
      "Guten Schulabschluss",
      "Deutsch auf muttersprachlichem Niveau",
      "Sicherer Umgang mit Excel und dem MS Office Paket",
    ],
    preferredQualifications: ["Erste Erfahrungen im Online-Handel oder Marketing"],
    technicalSkills: ["SEO", "Google Ads", "Social Media", "Shopware", "Excel"],
    softSkills: ["Teamfähigkeit", "Eigeninitiative", "analytisches Denken"],
    languageRequirements: ["Deutsch muttersprachlich", "Englisch mindestens B1"],
    educationRequirement: "Guter Schulabschluss",
    responsibilities: [
      "Unterstützung im Online-Marketing (SEO, Google Ads, Social Media)",
      "Pflege und Weiterentwicklung des Web-Shops (Shopware)",
      "Auswertung von Sales-Reports und KPIs in Excel",
      "Kundenbetreuung per E-Mail und Telefon",
    ],
    requestedDocuments: ["Lebenslauf", "die beiden letzten Zeugnisse"],
    applicationMethod: "per E-Mail bis zum 30.09.2026",
    contactPerson: "Frau Anna Weber",
    applicationEmail: "karriere@shopvision-digital.de",
    companyNotes: ["36 Monate Ausbildung mit Übernahmeoption"],
    missingOrAmbiguous: [],
  },
  analysis: {
    matchScore: 72,
    matched: [
      {
        requirement: "Sicherer Umgang mit Excel und dem MS Office Paket",
        status: "matched",
        note: "Excel im Lebenslauf belegt",
      },
    ],
    missing: [
      {
        requirement: "Erste Erfahrungen im Online-Handel",
        status: "missing",
        note: "keine Erfahrung vorhanden",
      },
    ],
    transferable: [
      {
        requirement: "SEO",
        status: "transferable",
        note: "Grundlagen vorhanden",
      },
    ],
    weaknesses: ["Keine E-Commerce-Erfahrung"],
    recommendations: ["Kurzen Online-Shop-Kurs belegen"],
    questions: ["Ist ein Praktikum möglich?"],
  },
};

// ---------------------------------------------------------------------------
// Mock OpenAI-compatible provider.
// ---------------------------------------------------------------------------
type Scenario = {
  status?: number;
  body?: string;
  contentType?: string;
  delayMs?: number;
  /** Destroy the socket mid-request (network failure, e.g. ECONNRESET). */
  networkError?: boolean;
};
type RecordedRequest = {
  url: string | null;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown> | null;
};

/** Wrap an assistant `content` string in the OpenAI chat-completion envelope. */
function openaiEnvelope(content: string): string {
  return JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion",
    model: "test-model",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

let server: ReturnType<typeof createServer> | null = null;
let providerBaseUrl = "";
let queue: Scenario[] = [];
let fallback: Scenario = { status: 200, body: openaiEnvelope(JSON.stringify(SUCCESS_PAYLOAD)) };
let requests: RecordedRequest[] = [];

async function startMockProvider() {
  requests = [];
  queue = [];
  fallback = { status: 200, body: openaiEnvelope(JSON.stringify(SUCCESS_PAYLOAD)) };
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
      requests.push({ url: req.url ?? null, headers: req.headers, body: parsed });
      const scenario = queue.length > 0 ? queue.shift()! : fallback;
      if (scenario.networkError) {
        req.socket.destroy();
        return;
      }
      const respond = () => {
        res.writeHead(scenario.status ?? 200, {
          "content-type": scenario.contentType ?? "application/json",
        });
        res.end(scenario.body ?? "");
      };
      if (scenario.delayMs) setTimeout(respond, scenario.delayMs);
      else respond();
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  providerBaseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`;
  process.env.AI_API_URL = providerBaseUrl;
}

function postRoute(adText: string, extra: Record<string, unknown> = {}) {
  const request = new Request("http://localhost/api/auto-bewerb/analyze-ad", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adText, ...extra }),
  });
  return POST(request);
}

function lastProviderBody(): Record<string, unknown> {
  expect(requests.length).toBeGreaterThan(0);
  const body = requests[requests.length - 1].body;
  expect(body).not.toBeNull();
  return body!;
}

beforeEach(async () => {
  vi.clearAllMocks();
  (createClient as ReturnType<typeof vi.fn>).mockReturnValue({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: USER } }, error: null })),
    },
  });
  (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue({});
  (reserveFeatureOp as ReturnType<typeof vi.fn>).mockResolvedValue({ outcome: "reserved" });
  (completeFeatureOp as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (releaseFeatureOp as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (getAutoBewerbProfile as ReturnType<typeof vi.fn>).mockResolvedValue({
    cv_hash: "test-cv-hash",
    extracted: null,
  });
  (getAutoBewerbCompany as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  process.env.AI_API_KEY = API_KEY;
  process.env.AI_MODEL = "test-model";
  process.env.AI_VISION_MODEL = "test-vision-model";
  await startMockProvider();
});

afterEach(async () => {
  if (server) {
    const s = server;
    server = null;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  delete process.env.AI_API_KEY;
  delete process.env.AI_API_URL;
  delete process.env.AI_MODEL;
  delete process.env.AI_VISION_MODEL;
});

// ---------------------------------------------------------------------------
// 1. success
// ---------------------------------------------------------------------------
describe("successful analysis", () => {
  it("returns the structured company + vacancy data for the ShopVision ad", async () => {
    const res = await postRoute(SHOPVISION_AD);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      extract: Record<string, unknown>;
      analysis: Record<string, unknown>;
      reused: boolean;
      profileHash: string | null;
    };
    expect(data.reused).toBe(false);
    expect(data.profileHash).toBe("test-cv-hash");
    expect(data.extract.company).toBe("ShopVision Digital GmbH");
    expect(data.extract.jobTitle).toBe("Kaufmann / Kauffrau im E-Commerce (m/w/d)");
    expect(data.extract.location).toBe("Hamburg");
    expect(data.extract.applicationEmail).toBe("karriere@shopvision-digital.de");
    expect(data.analysis.matchScore).toBe(72);
    expect(data.analysis.matched).toHaveLength(1);
    // The successful op is COMPLETED (charged exactly once), never released.
    const completeMock = completeFeatureOp as unknown as ReturnType<typeof vi.fn>;
    expect(completeFeatureOp).toHaveBeenCalledTimes(1);
    expect(completeMock.mock.calls[0][0]).toBe(USER);
    expect(completeMock.mock.calls[0][1]).toBe("ai_assistant");
    expect(releaseFeatureOp).not.toHaveBeenCalled();
  });

  it("sends the correct request to the provider (model, temperature 0, fenced ad, auth header)", async () => {
    await postRoute(SHOPVISION_AD);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("/v1/chat/completions");
    expect(requests[0].headers.authorization).toBe(`Bearer ${API_KEY}`);
    const body = lastProviderBody();
    expect(body.model).toBe("test-model");
    expect(body.temperature).toBe(0);
    expect(body.stream).toBe(false);
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toBe(AD_ANALYSIS_SYSTEM_PROMPT);
    expect(messages[1].role).toBe("user");
    // The untrusted ad is fenced + reaches the model verbatim enough to analyze.
    expect(messages[1].content).toContain("ShopVision Digital GmbH");
    expect(messages[1].content).toContain("STELLENANZEIGE");
  });
});

// ---------------------------------------------------------------------------
// 2–7. provider HTTP failure categories
// ---------------------------------------------------------------------------
describe("provider HTTP failures are classified (status, code, retryable)", () => {
  it("HTTP 401 → 502 provider_auth (not retryable) + quota RELEASED", async () => {
    fallback = { status: 401, body: JSON.stringify({ error: { message: "Invalid API key", code: "invalid_api_key" } }) };
    const res = await postRoute(SHOPVISION_AD);
    const data = await res.json();
    expect(res.status).toBe(502);
    expect(data.code).toBe("provider_auth");
    expect(data.retryable).toBe(false);
    expect(releaseFeatureOp).toHaveBeenCalledTimes(1);
    expect(completeFeatureOp).not.toHaveBeenCalled();
  });

  it("HTTP 403 → 502 provider_auth", async () => {
    fallback = { status: 403, body: JSON.stringify({ error: { message: "Access denied" } }) };
    const res = await postRoute(SHOPVISION_AD);
    const data = await res.json();
    expect(res.status).toBe(502);
    expect(data.code).toBe("provider_auth");
    expect(data.retryable).toBe(false);
  });

  it("HTTP 429 (throttling) → 429 provider_rate_limited (retryable)", async () => {
    fallback = { status: 429, body: JSON.stringify({ error: { message: "Rate limit reached" } }) };
    const res = await postRoute(SHOPVISION_AD);
    const data = await res.json();
    expect(res.status).toBe(429);
    expect(data.code).toBe("provider_rate_limited");
    expect(data.retryable).toBe(true);
  });

  it("provider quota exhaustion (HTTP 402 credits) → 502 provider_quota (not retryable)", async () => {
    fallback = { status: 402, body: JSON.stringify({ error: { message: "insufficient credits", code: "billing" } }) };
    const res = await postRoute(SHOPVISION_AD);
    const data = await res.json();
    expect(res.status).toBe(502);
    expect(data.code).toBe("provider_quota");
    expect(data.retryable).toBe(false);
  });

  it("HTTP 429 with credit-exhaustion wording → provider_quota (a user retry would not help → 502, not retryable)", async () => {
    fallback = { status: 429, body: JSON.stringify({ error: { message: "You have run out of credits" } }) };
    const res = await postRoute(SHOPVISION_AD);
    const data = await res.json();
    expect(res.status).toBe(502);
    expect(data.code).toBe("provider_quota");
    expect(data.retryable).toBe(false);
  });

  it("HTTP 500 → 503 provider_unavailable (retryable)", async () => {
    fallback = { status: 500, body: JSON.stringify({ error: { message: "internal error" } }) };
    const res = await postRoute(SHOPVISION_AD);
    const data = await res.json();
    expect(res.status).toBe(503);
    expect(data.code).toBe("provider_unavailable");
    expect(data.retryable).toBe(true);
    expect(releaseFeatureOp).toHaveBeenCalledTimes(1);
  });

  it("HTTP 503 → 503 provider_unavailable (retryable)", async () => {
    fallback = { status: 503, body: JSON.stringify({ error: { message: "upstream unavailable" } }) };
    const res = await postRoute(SHOPVISION_AD);
    const data = await res.json();
    expect(res.status).toBe(503);
    expect(data.code).toBe("provider_unavailable");
    expect(data.retryable).toBe(true);
  });

  it("HTTP 400/404 (bad model id / payload) → 502 provider_request_rejected (not retryable)", async () => {
    fallback = { status: 404, body: JSON.stringify({ error: { message: "model not found" } }) };
    const res = await postRoute(SHOPVISION_AD);
    const data = await res.json();
    expect(res.status).toBe(502);
    expect(data.code).toBe("provider_request_rejected");
    expect(data.retryable).toBe(false);
  });

  it("network failure (connection destroyed) → 503 provider_network (retryable)", async () => {
    fallback = { networkError: true };
    const res = await postRoute(SHOPVISION_AD);
    const data = await res.json();
    expect(res.status).toBe(503);
    expect(data.code).toBe("provider_network");
    expect(data.retryable).toBe(true);
    expect(releaseFeatureOp).toHaveBeenCalledTimes(1);
  });

  it("provider timeout is classified at the provider layer (small budget vs slow mock)", async () => {
    fallback = { status: 200, body: openaiEnvelope(JSON.stringify(SUCCESS_PAYLOAD)), delayMs: 1200 };
    await expect(
      createAIProvider().generateText([{ role: "user", content: "ping" }], 300),
    ).rejects.toMatchObject({ code: "provider_timeout", retryable: true });
    expect(requests).toHaveLength(1);
  });

  it("missing provider configuration → 503 provider_not_configured, ZERO provider calls", async () => {
    delete process.env.AI_API_KEY;
    delete process.env.AI_MODEL;
    const res = await postRoute(SHOPVISION_AD);
    const data = await res.json();
    expect(res.status).toBe(503);
    expect(data.code).toBe("provider_not_configured");
    expect(data.retryable).toBe(false);
    expect(requests).toHaveLength(0);
    expect(releaseFeatureOp).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 8–9. malformed / unexpected responses
// ---------------------------------------------------------------------------
describe("malformed provider responses", () => {
  it("2xx with a non-JSON body (HTML error page) → 502 provider_invalid_response, body not leaked", async () => {
    const html =
      "<html><head><title>502 Bad Gateway</title></head><body>nginx secret internal page</body></html>";
    fallback = { status: 200, body: html, contentType: "text/html" };
    const res = await postRoute(SHOPVISION_AD);
    const data = await res.json();
    expect(res.status).toBe(502);
    expect(data.code).toBe("provider_invalid_response");
    expect(data.retryable).toBe(true);
    expect(JSON.stringify(data)).not.toContain("nginx secret internal page");
  });

  it("valid JSON without the expected schema (no choices) → bounded 2 attempts → 502 invalid_ai_output", async () => {
    fallback = { status: 200, body: JSON.stringify({ foo: "bar" }) };
    const res = await postRoute(SHOPVISION_AD);
    const data = await res.json();
    expect(res.status).toBe(502);
    expect(data.code).toBe("invalid_ai_output");
    expect(data.retryable).toBe(true);
    expect(requests).toHaveLength(2); // one nudge retry, then give up
  });

  it("model output that is not JSON at all → bounded 2 attempts → 502 invalid_ai_output", async () => {
    fallback = {
      status: 200,
      body: JSON.stringify({ choices: [{ message: { content: "Hier ist die Analyse: ..." } }] }),
    };
    const res = await postRoute(SHOPVISION_AD);
    const data = await res.json();
    expect(res.status).toBe(502);
    expect(data.code).toBe("invalid_ai_output");
    expect(requests).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 11. app-side gating (authentication / permissions / app quota)
// ---------------------------------------------------------------------------
describe("app-side gating never reaches the provider", () => {
  it("unauthenticated → 401 Unauthorized, ZERO provider calls", async () => {
    (createClient as ReturnType<typeof vi.fn>).mockReturnValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: null })) },
    });
    const res = await postRoute(SHOPVISION_AD);
    expect(res.status).toBe(401);
    expect(requests).toHaveLength(0);
    expect(reserveFeatureOp).not.toHaveBeenCalled();
  });

  it("authenticated user without the feature (feature_disabled) → 403, ZERO provider calls", async () => {
    (reserveFeatureOp as ReturnType<typeof vi.fn>).mockResolvedValue({ outcome: "feature_disabled" });
    const res = await postRoute(SHOPVISION_AD);
    const data = await res.json();
    expect(res.status).toBe(403);
    expect(data.code).toBe("feature_disabled");
    expect(requests).toHaveLength(0);
  });

  it("app-side daily quota exhausted → 429 quota_exhausted, ZERO provider calls", async () => {
    (reserveFeatureOp as ReturnType<typeof vi.fn>).mockResolvedValue({ outcome: "quota_exhausted" });
    const res = await postRoute(SHOPVISION_AD);
    const data = await res.json();
    expect(res.status).toBe(429);
    expect(data.code).toBe("quota_exhausted");
    expect(requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 12. retry after a transient provider failure
// ---------------------------------------------------------------------------
describe("retry after a transient provider failure", () => {
  it("an identical second request succeeds after a 503 (failure is not cached)", async () => {
    queue = [{ status: 503, body: JSON.stringify({ error: { message: "upstream unavailable" } }) }];
    const first = await postRoute(SHOPVISION_AD);
    const firstData = await first.json();
    expect(first.status).toBe(503);
    expect(firstData.code).toBe("provider_unavailable");
    expect(releaseFeatureOp).toHaveBeenCalledTimes(1); // the failed op is refunded

    // The user retries (no re-entry needed) — the same vacancy goes through.
    const second = await postRoute(SHOPVISION_AD);
    const secondData = (await second.json()) as {
      extract: { company: string };
      reused: boolean;
    };
    expect(second.status).toBe(200);
    expect(secondData.extract.company).toBe("ShopVision Digital GmbH");
    expect(secondData.reused).toBe(false);
    expect(requests).toHaveLength(2);
    expect(completeFeatureOp).toHaveBeenCalledTimes(1); // only the successful op
  });
});

// ---------------------------------------------------------------------------
// 13. single-flight (duplicate-request protection) — even on failure
// ---------------------------------------------------------------------------
describe("single-flight", () => {
  it("two CONCURRENT identical requests share ONE provider call when it fails", async () => {
    fallback = { status: 503, body: JSON.stringify({ error: { message: "down" } }), delayMs: 250 };
    const [a, b] = await Promise.all([postRoute(SHOPVISION_AD), postRoute(SHOPVISION_AD)]);
    const da = await a.json();
    const db = await b.json();
    expect(a.status).toBe(503);
    expect(b.status).toBe(503);
    expect(da.code).toBe("provider_unavailable");
    expect(db.code).toBe("provider_unavailable");
    expect(requests).toHaveLength(1); // ONE paid call, not two
    expect(releaseFeatureOp).toHaveBeenCalledTimes(2); // each own reservation refunded
  });
});

// ---------------------------------------------------------------------------
// 14. diagnostics: redacted server logs, no leak to the browser
// ---------------------------------------------------------------------------
describe("secret-safe diagnostics", () => {
  it("a provider error body containing credentials is redacted in server logs and never sent to the browser", async () => {
    const fakeKey = "sk-livE-SuperSecretKey0123456789abcdef0123456789";
    fallback = {
      status: 500,
      body: JSON.stringify({
        error: { message: `Authentication failed for Bearer ${fakeKey} (echoed by upstream)` },
      }),
    };
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await postRoute(SHOPVISION_AD);
      const data = await res.json();
      // Browser sees only the safe category message — never the detail.
      expect(data.error).toBe("The AI provider is temporarily unavailable.");
      expect(JSON.stringify(data)).not.toContain(fakeKey);
      expect(JSON.stringify(data)).not.toContain("Bearer");
      // Server logs contain the cause (status + provider wording) …
      const logged = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain("status=500");
      expect(logged).toContain("code=provider_unavailable");
      expect(logged).toContain("Authentication failed");
      // … with the credential redacted.
      expect(logged).not.toContain(fakeKey);
      expect(logged).not.toContain(`Bearer ${fakeKey}`);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("sanitizeProviderDetail redacts bearer tokens, sk- keys, long opaque tokens and truncates long text", () => {
    expect(sanitizeProviderDetail(`Bearer abc.def-123 / failed`)).toBe("Bearer [REDACTED] / failed");
    expect(sanitizeProviderDetail("key sk-abcdefgh1234567890 invalid")).toBe("key [REDACTED] invalid");
    // A long opaque alphanumeric blob looks like a credential → redacted whole.
    expect(sanitizeProviderDetail("token " + "x".repeat(1000))).toBe("token [REDACTED]");
    // Long human text is truncated to the 300-char log budget.
    const sentence = "the provider reported a transient upstream failure for this request ".repeat(20);
    const truncated = sanitizeProviderDetail(sentence);
    expect(truncated).toHaveLength(300);
    expect(truncated).not.toBeNull();
    expect(sanitizeProviderDetail("")).toBeNull();
    expect(sanitizeProviderDetail(null)).toBeNull();
  });

  it("AIProviderError instances keep their classification fields", () => {
    const err = new AIProviderError("provider_timeout", "The AI provider timed out.", {
      retryable: true,
      detail: "aborted after 120000ms",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AIProviderError");
    expect(err.code).toBe("provider_timeout");
    expect(err.retryable).toBe(true);
    expect(err.status).toBeNull();
    expect(err.detail).toBe("aborted after 120000ms");
  });
});
