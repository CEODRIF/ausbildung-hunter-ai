import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyOAuthFailure,
  clientIdSuffix,
  exchangeGoogleCode,
  getProviderConfig,
  oauthConfigStatus,
} from "@/lib/email-oauth";

/**
 * Google OAuth diagnostics (Phase 18).
 *
 * The UI used to show only "We could not verify that account." for every
 * failure, hiding Google's real error. These tests pin: the real provider
 * error survives into the thrown/classified error, the classification is a
 * fixed safe set, the redirect_uri is the SAME value at authorize and token
 * time, and nothing secret is ever logged.
 */

const ENV_KEYS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "EMAIL_TOKEN_ENCRYPTION_KEY",
] as const;
const ORIGINAL: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) ORIGINAL[key] = process.env[key];

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.env.GOOGLE_CLIENT_ID = "1234567890-abcdefghijklmnop.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "test-secret-not-real";
  process.env.GOOGLE_REDIRECT_URI =
    "https://ausbildung-hunter-ai.vercel.app/api/email/callback/gmail";
  process.env.EMAIL_TOKEN_ENCRYPTION_KEY = "test-encryption-key";
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    if (ORIGINAL[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL[key];
  }
});

function googleError(status: number, error: string, description?: string) {
  return new Response(
    JSON.stringify({
      error,
      ...(description ? { error_description: description } : {}),
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

describe("google oauth failure visibility", () => {
  it("surfaces Google's REAL error code instead of a generic message", async () => {
    fetchMock.mockResolvedValue(
      googleError(400, "invalid_grant", "Malformed auth code."),
    );
    const error = await exchangeGoogleCode("test-code").catch(
      (e: unknown) => e,
    );
    expect(String((error as Error).message)).toContain("invalid_grant");
    expect(String((error as Error).message)).toContain("HTTP 400");
    expect(classifyOAuthFailure(error)).toEqual({
      reason: "invalid_grant",
      status: 400,
    });
  });

  it.each([
    ["redirect_uri_mismatch", 400, "redirect_uri_mismatch"],
    ["invalid_client", 401, "invalid_client"],
    ["unauthorized_client", 400, "unauthorized_client"],
    ["access_denied", 403, "access_denied"],
    ["invalid_request", 400, "invalid_request"],
  ])("classifies Google's %s", async (code, status, expected) => {
    fetchMock.mockResolvedValue(googleError(status, code));
    const error = await exchangeGoogleCode("c").catch((e: unknown) => e);
    expect(classifyOAuthFailure(error)).toEqual({
      reason: expected,
      status,
    });
  });

  it("classifies a permission-only failure (401 without a body code)", () => {
    const error = Object.assign(new Error("boom"), { status: 401 });
    expect(classifyOAuthFailure(error).reason).toBe("network_error");
  });

  it("classifies the app's own guards (identity / save / config)", () => {
    expect(
      classifyOAuthFailure(new Error("Unable to verify provider account.")),
    ).toEqual({ reason: "identity_check_failed", status: null });
    expect(
      classifyOAuthFailure(
        new Error('Saving email account failed [42P01]: relation does not exist'),
      ),
    ).toEqual({ reason: "token_save_failed", status: null });
    expect(
      classifyOAuthFailure(
        new Error("EMAIL_TOKEN_ENCRYPTION_KEY is not configured."),
      ),
    ).toEqual({ reason: "config_incomplete", status: null });
  });

  it("never returns a value that could carry a secret", () => {
    const reasons = new Set([
      "redirect_uri_mismatch",
      "invalid_client",
      "invalid_grant",
      "unauthorized_client",
      "access_denied",
      "invalid_request",
      "permission_denied",
      "identity_check_failed",
      "token_save_failed",
      "config_incomplete",
      "network_error",
    ]);
    for (const input of [
      new Error("client_secret=abc"),
      new Error("Bearer ya29.token"),
      Object.assign(new Error("x"), { status: 500 }),
    ])
      expect(reasons.has(classifyOAuthFailure(input).reason)).toBe(true);
  });
});

describe("oauth configuration", () => {
  it("reports presence as booleans only (never the values)", () => {
    const status = oauthConfigStatus("gmail");
    expect(status).toEqual({
      clientId: true,
      clientSecret: true,
      redirectUri: true,
      encryptionKey: true,
      complete: true,
    });
    expect(JSON.stringify(status)).not.toContain("test-secret-not-real");
  });

  it("flags an incomplete configuration (missing encryption key)", () => {
    delete process.env.EMAIL_TOKEN_ENCRYPTION_KEY;
    expect(oauthConfigStatus("gmail")).toMatchObject({
      encryptionKey: false,
      complete: false,
    });
  });

  it("logs only a suffix of the client id", () => {
    const suffix = clientIdSuffix(process.env.GOOGLE_CLIENT_ID);
    expect(suffix).toMatch(/^…/);
    expect(suffix.length).toBeLessThanOrEqual(9);
    expect(suffix).not.toContain("1234567890");
    expect(clientIdSuffix(undefined)).toBe("none");
  });
});

describe("redirect_uri consistency (the classic mismatch)", () => {
  it("uses the SAME configured redirect_uri for authorize and token exchange", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ access_token: "a", expires_in: 3600 }),
    );
    await exchangeGoogleCode("c");
    const body = String(
      (fetchMock.mock.calls[0][1] as { body: URLSearchParams }).body,
    );
    const sent = new URLSearchParams(body).get("redirect_uri");
    // …identical to what the connect route sends to Google.
    expect(sent).toBe(process.env.GOOGLE_REDIRECT_URI);
    expect(getProviderConfig("gmail").redirectUri).toBe(
      process.env.GOOGLE_REDIRECT_URI,
    );
    expect(sent).toBe(
      "https://ausbildung-hunter-ai.vercel.app/api/email/callback/gmail",
    );
  });

  it("the connect route logs the redirect URI, origin, callback route and client suffix — and warns on a mismatch", () => {
    const route = readFileSync(
      "src/app/api/email/connect/[provider]/route.ts",
      "utf8",
    );
    expect(route).toContain("[GOOGLE_OAUTH] start");
    expect(route).toContain("clientIdSuffix");
    expect(route).toContain("redirectUri: config.redirectUri");
    expect(route).toContain("origin");
    expect(route).toContain("callbackRoute");
    expect(route).toContain("redirect_uri differs from this deployment");
    // Never logs the secret.
    expect(route).not.toContain("clientSecret:");
  });

  it("the callback route logs the safe callback fields and the classified reason", () => {
    const route = readFileSync(
      "src/app/api/email/callback/[provider]/route.ts",
      "utf8",
    );
    expect(route).toContain("[GOOGLE_OAUTH] callback");
    expect(route).toContain("hasCode");
    expect(route).toContain("providerErrorCode");
    expect(route).toContain("hasState");
    expect(route).toContain("stateVerified");
    expect(route).toContain("classifyOAuthFailure");
    expect(route).toContain('searchParams.set("reason", reason)');
    // Forbidden values are never logged.
    // Object KEYS only — a prose comment may still mention them.
    for (const forbidden of [
      "access_token:",
      "refresh_token:",
      "client_secret:",
      "code:",
      "cookie:",
    ])
      expect(route).not.toContain(forbidden);
  });

  it("the settings page shows the provider reason to the user", () => {
    const page = readFileSync("src/app/settings/email/page.tsx", "utf8");
    expect(page).toContain("params.reason");
    expect(page).toContain("account.errProviderReason");
  });
});
