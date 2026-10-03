import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ATTEMPT_TIMEOUT_MS,
  buildDeckblattBaseImage,
  DECKBLATT_FUNCTION_BUDGET_MS,
  generateDeckblattDesign,
  PollinationsError,
  redactProviderMessage,
} from "@/lib/deckblatt/pollinations";
import { DECKBLATT_STYLES } from "@/lib/deckblatt/styles";

/**
 * Deckblatt provider: diagnostics, budget coherence and the failure path that
 * used to lose the user's quota.
 *
 * The production symptom was "The design service is currently unreachable."
 * with "Your design quota was not used." — while the reservation was in fact
 * still held, because the route's catch block (the only place that refunds)
 * never ran when the platform killed the function mid-generation.
 *
 * These tests pin the three things that make that diagnosable and impossible:
 *   1. the provider failure carries status / provider code / request id and the
 *      message is redacted before it can reach a log;
 *   2. the retry budget fits inside the function budget (it previously did not:
 *      180 s + retry against a 180 s maxDuration could never complete);
 *   3. the client is told whether the refund actually happened.
 */
const root = fileURLToPath(new URL("..", import.meta.url));
const PROMPT = "Test prompt";
const BASE = buildDeckblattBaseImage(DECKBLATT_STYLES.modern);

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.POLLINATIONS_API_KEY = "test-key";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.POLLINATIONS_API_KEY;
});

describe("provider configuration", () => {
  it("fails with provider_unauthorized when the key is not configured", async () => {
    delete process.env.POLLINATIONS_API_KEY;
    const error = await generateDeckblattDesign(PROMPT, BASE).catch((e) => e);
    expect(error).toBeInstanceOf(PollinationsError);
    expect(error.code).toBe("provider_unauthorized");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never sends the key anywhere but the Authorization header", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ b64_json: "AAAA" }] }));
    await generateDeckblattDesign(PROMPT, BASE);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).not.toContain("test-key");
    expect(JSON.stringify(init.body)).not.toContain("test-key");
    expect(init.headers.Authorization).toBe("Bearer test-key");
  });
});

describe("a successful generation", () => {
  it("returns the base64 image", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ b64_json: "QUJD" }] }));
    await expect(generateDeckblattDesign(PROMPT, BASE)).resolves.toBe("QUJD");
  });

  it("treats a 200 without image data as a provider anomaly (no retry)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    const error = await generateDeckblattDesign(PROMPT, BASE).catch((e) => e);
    expect(error.code).toBe("provider_invalid_image");
    // Deterministic failure: retrying would only repeat it.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("provider HTTP failures carry diagnosable detail", () => {
  it("401 → provider_unauthorized with status, code and request id", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          success: false,
          error: { message: "A valid API key is required.", code: "UNAUTHORIZED" },
        },
        401,
        { "x-request-id": "req-abc-123" },
      ),
    );
    const error: PollinationsError = await generateDeckblattDesign(PROMPT, BASE).catch(
      (e) => e,
    );
    expect(error.code).toBe("provider_unauthorized");
    expect(error.httpStatus).toBe(401);
    expect(error.providerCode).toBe("UNAUTHORIZED");
    expect(error.requestId).toBe("req-abc-123");
    // A rejected key is deterministic — never retried.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("400 content_blocked → provider_content_blocked", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: "content_blocked", message: "blocked" } }, 400),
    );
    const error = await generateDeckblattDesign(PROMPT, BASE).catch((e) => e);
    expect(error.code).toBe("provider_content_blocked");
    expect(error.httpStatus).toBe(400);
  });

  it("400 for another reason → provider_bad_request with the provider code", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: "invalid_image_url", message: "bad url" } }, 400),
    );
    const error = await generateDeckblattDesign(PROMPT, BASE).catch((e) => e);
    expect(error.code).toBe("provider_bad_request");
    expect(error.providerCode).toBe("invalid_image_url");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("5xx → provider_unavailable and IS retried once", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: { code: "UPSTREAM" } }, 503))
      .mockResolvedValueOnce(jsonResponse({ data: [{ b64_json: "R09PRA==" }] }));
    await expect(generateDeckblattDesign(PROMPT, BASE)).resolves.toBe("R09PRA==");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a timeout is its own code, distinct from an outage", async () => {
    fetchMock.mockImplementation(() => {
      const abort = new Error("aborted");
      abort.name = "AbortError";
      return Promise.reject(abort);
    });
    const error = await generateDeckblattDesign(PROMPT, BASE).catch((e) => e);
    expect(error.code).toBe("provider_timeout");
  });
});

describe("the retry budget fits inside the function budget", () => {
  it("the two constants cannot drift apart", () => {
    // 2 attempts + one backoff must fit inside the budget the route declares.
    expect(DECKBLATT_FUNCTION_BUDGET_MS).toBe(2 * ATTEMPT_TIMEOUT_MS + 4_000);
    expect(ATTEMPT_TIMEOUT_MS).toBeLessThan(180_000);
  });

  it("does NOT start a retry the function could not finish", async () => {
    let clock = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    fetchMock.mockImplementationOnce(() => {
      // Simulate an attempt that consumed more than the remaining budget.
      clock += 200_000;
      return Promise.resolve(jsonResponse({ error: { code: "UPSTREAM" } }, 503));
    });
    const error = await generateDeckblattDesign(PROMPT, BASE).catch((e) => e);
    expect(error.code).toBe("provider_unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    nowSpy.mockRestore();
  });
});

describe("provider messages are redacted before they can be logged", () => {
  it("strips bearer tokens, JWTs and long blobs", () => {
    expect(redactProviderMessage("Bearer sk-live-9f8e7d6c5b4a3210")).not.toContain(
      "sk-live-9f8e7d6c5b4a3210",
    );
    expect(
      redactProviderMessage(
        "invalid token eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.abcdefghij",
      ),
    ).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(redactProviderMessage("x".repeat(400)).length).toBeLessThanOrEqual(300);
  });

  it("the message attached to the error is already redacted", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: "UNAUTHORIZED", message: "bad key sk-abcdef1234567890" } }, 401),
    );
    const error: PollinationsError = await generateDeckblattDesign(PROMPT, BASE).catch(
      (e) => e,
    );
    expect(error.providerMessage ?? "").not.toContain("sk-abcdef1234567890");
  });
});

describe("quota: the route reports whether the refund happened", () => {
  const route = readFileSync(
    `${root}/src/app/api/deckblatt/generate/route.ts`,
    "utf8",
  );

  it("returns quotaRefunded with the provider failure", () => {
    expect(route).toContain("const quotaRefunded = await releaseOnce();");
    expect(route).toContain("return json({ code, quotaRefunded, usage }, { status: 502 });");
    expect(route).toContain(
      'return json(\n      { code: "provider_error", quotaRefunded, usage },\n      { status: 502 },\n    );',
    );
  });

  it("refunds through one idempotent path (never twice)", () => {
    expect(route).toContain("if (refunded) return false;");
    expect(route).toContain("refunded = true;");
  });

  it("also refunds when the client goes away mid-generation", () => {
    expect(route).toContain('request.signal?.addEventListener?.("abort", onAbort');
    expect(route).toContain('request.signal?.removeEventListener?.("abort", onAbort)');
  });

  it("logs the provider, operation, status, provider code and request id", () => {
    expect(route).toContain("provider=pollinations operation=images.edits");
    expect(route).toContain("http_status=");
    expect(route).toContain("provider_code=");
    expect(route).toContain("request_id=");
    expect(route).toContain("quota_refunded=");
  });

  it("declares a maxDuration that covers the provider budget", () => {
    // Next.js requires a LITERAL route segment config, so the coherence is
    // enforced here instead of by deriving the value at runtime.
    const declared = Number(route.match(/export const maxDuration = (\d+);/)?.[1]);
    expect(Number.isInteger(declared)).toBe(true);
    expect(declared * 1000).toBeGreaterThanOrEqual(DECKBLATT_FUNCTION_BUDGET_MS + 10_000);
    // …and stays inside the platform's documented maximum.
    expect(declared).toBeLessThanOrEqual(300);
    // The route must not import the budget constant just to compute it.
    expect(route).not.toContain("DECKBLATT_FUNCTION_BUDGET_MS");
  });
});

describe("quota: unsettled reservations are recovered", () => {
  const migration = readFileSync(
    `${root}/supabase/migrations/20261023000000_deckblatt_stale_reservation_recovery.sql`,
    "utf8",
  );
  const usage = readFileSync(`${root}/src/lib/deckblatt/usage.ts`, "utf8");

  it("refunds only reservations that are still 'reserved'", () => {
    expect(migration).toContain("and r.status = 'reserved'");
    expect(migration).toContain("set status = 'failed'");
  });

  it("uses the same accounting as the release RPC and never goes below zero", () => {
    expect(migration).toContain("set generations_used = greatest(u.generations_used - 1, 0)");
    // …against the usage day of the RUN, not of the recovery.
    expect(migration).toContain("(r.created_at at time zone 'utc')::date as usage_date");
    expect(migration).toContain("and u.usage_date = stale.usage_date");
  });

  it("is safe: security definer, pinned search path, bounded window, locked rows", () => {
    expect(migration).toContain("security definer");
    expect(migration).toContain("set search_path = public");
    expect(migration).toContain("raise exception 'not_authorized'");
    expect(migration).toContain("p_max_age_minutes > 1440");
    expect(migration).toContain("for update");
  });

  it("is not executable by anonymous callers", () => {
    expect(migration).toContain(
      "revoke execute on function public.expire_stale_deckblatt_runs(uuid, integer) from public, anon;",
    );
    expect(migration).toContain(
      "grant execute on function public.expire_stale_deckblatt_runs(uuid, integer) to authenticated;",
    );
  });

  it("runs before reserving and before reporting the quota", () => {
    expect(usage).toContain("export async function expireStaleDeckblattRuns()");
    expect(usage).toContain("const STALE_RESERVATION_MINUTES = 15;");
    // two call sites: reserve + status
    expect(usage.match(/await expireStaleDeckblattRuns\(\);/g) ?? []).toHaveLength(2);
    // …and a failure of the recovery must never block a generation
    expect(usage).toContain("return 0;");
  });
});

describe("UI tells the truth about the quota and the new codes", () => {
  const generator = readFileSync(
    `${root}/src/components/deckblatt-generator.tsx`,
    "utf8",
  );

  it("shows the reassuring note only when the refund was confirmed", () => {
    expect(generator).toContain("quotaRefunded === false");
    expect(generator).toContain('t("deckblatt.errorProviderNotePending")');
    expect(generator).toContain('setQuotaRefunded(payload.quotaRefunded === true);');
  });

  it("maps the new provider codes to their own messages", () => {
    expect(generator).toContain('payload.code === "provider_timeout"');
    expect(generator).toContain('payload.code === "provider_rejected"');
    expect(generator).toContain('"provider_timeout"');
    expect(generator).toContain('"provider_rejected"');
  });

  it("has all new keys translated in the four locales", async () => {
    const { dictionaries } = await import("@/lib/i18n/dictionaries");
    for (const locale of ["de", "en", "fr", "ar"] as const) {
      const deckblatt = dictionaries[locale].deckblatt as Record<string, unknown>;
      for (const key of [
        "errorProviderNotePending",
        "errorProviderTimeout",
        "errorProviderRejected",
      ]) {
        const value = deckblatt[key];
        expect(typeof value, `${locale}.${key}`).toBe("string");
        expect(String(value).length, `${locale}.${key}`).toBeGreaterThan(20);
      }
    }
  });
});
