import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Gmail sending path (Phase 21) — the "Reconnect your Gmail account" mystery.
 *
 * Traced source of that message: src/lib/email-providers.ts → sendGmail(),
 * thrown whenever the Gmail API answered 401 OR 403. Everything else in the
 * chain (getProviderAccount, token decryption, refresh) produces DIFFERENT
 * texts — so the account really was ACTIVE and the call really reached Gmail,
 * and Gmail rejected the credential. The app threw one blanket message for
 * every cause and never tried the refresh token it already had.
 *
 * These tests pin the new behaviour for the seven required scenarios.
 */

const updates: Array<Record<string, unknown>> = [];
let accountRow: Record<string, unknown> = {};

/**
 * Chainable Supabase stand-in: ANY chain (select().eq().eq().eq().single(),
 * update().eq(), …) resolves to `{ data: accountRow, error: null }`, and
 * update payloads are recorded for assertions. Shape-proof against the real
 * chains without copying them.
 */
function chainable(table: string): unknown {
  const result = { data: accountRow, error: null };
  const target = () => {};
  return new Proxy(target, {
    get(_target, prop) {
      if (prop === "then")
        return (resolve: (value: unknown) => void) => resolve(result);
      return (...args: unknown[]) => {
        if (table === "email_accounts" && prop === "update" && args[0])
          updates.push({ table, ...(args[0] as Record<string, unknown>) });
        return chainable(table);
      };
    },
  });
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => chainable(table),
    storage: { from: () => chainable("storage") },
  }),
}));

vi.mock("@/lib/email-crypto", () => ({
  decryptEmailToken: (value: string) => `dec(${value})`,
  encryptEmailToken: (value: string) => `enc(${value})`,
}));

const { createEmailProvider } = await import("@/lib/email-providers");

const fetchMock = vi.fn();

/** Queue one response per URL substring; unmatched URLs → 404. */
function routeGmail(
  gmail: Array<() => Response>,
  token: Array<() => Response> = [],
) {
  const gm = [...gmail];
  const tk = [...token];
  fetchMock.mockImplementation(async (input: unknown) => {
    const url = String(input);
    if (url.includes("gmail.googleapis.com")) {
      const next = gm.shift();
      if (!next) throw new Error("unexpected extra Gmail call");
      return next();
    }
    if (url.includes("oauth2.googleapis.com/token")) {
      const next = tk.shift();
      if (!next) throw new Error("unexpected extra token call");
      return next();
    }
    return new Response("not found", { status: 404 });
  });
}

function gmailOk(id = "gmail-message-1") {
  return () => Response.json({ id, threadId: "thread-1" });
}

function gmailError(status: number, reason?: string, googleStatus?: string) {
  return () =>
    Response.json(
      {
        error: {
          code: status,
          status: googleStatus ?? "PERMISSION_DENIED",
          ...(reason ? { errors: [{ reason }] } : {}),
        },
      },
      { status },
    );
}

function tokenOk(accessToken = "access-fresh", expiresIn = 3599) {
  return () => Response.json({ access_token: accessToken, expires_in: expiresIn });
}

function account(overrides: Record<string, unknown> = {}) {
  accountRow = {
    id: "account-1",
    user_id: "user-1",
    provider: "gmail",
    email: "sender@gmail.com",
    access_token_encrypted: "access-1",
    refresh_token_encrypted: "refresh-1",
    token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    requires_reconnect: false,
    ...overrides,
  };
}

async function send() {
  const provider = await createEmailProvider("user-1", "account-1", []);
  return provider.sendEmail({
    to: "empfaenger@example.de",
    subject: "Bewerbung",
    text: "Guten Tag",
    html: "",
    attachments: [],
  });
}

const warnSpy = vi.spyOn(console, "info").mockImplementation(() => {});

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  updates.length = 0;
  warnSpy.mockClear();
  // The refresh flow needs the OAuth client (values are never asserted).
  process.env.GOOGLE_CLIENT_ID = "client-id-test";
  process.env.GOOGLE_CLIENT_SECRET = "client-secret-test";
  account();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("gmail sending path", () => {
  it("1) ACTIVE account with a usable token → message sent, id returned", async () => {
    routeGmail([gmailOk()]);
    await expect(send()).resolves.toEqual({
      providerMessageId: "gmail-message-1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "gmail.googleapis.com/gmail/v1/users/me/messages/send",
    );
  });

  it("2) expired access token + valid refresh token → refresh, then send", async () => {
    account({ token_expires_at: new Date(Date.now() - 60_000).toISOString() });
    routeGmail([gmailOk()], [tokenOk()]);
    await expect(send()).resolves.toEqual({
      providerMessageId: "gmail-message-1",
    });
    // Token endpoint first, Gmail second.
    expect(String(fetchMock.mock.calls[0][0])).toContain("oauth2.googleapis.com");
    expect(String(fetchMock.mock.calls[1][0])).toContain("gmail.googleapis.com");
    // The refreshed credential is persisted (encrypted) and the account is
    // no longer flagged for reconnect.
    const persisted = updates.find((row) => row.access_token_encrypted);
    expect(persisted?.access_token_encrypted).toBe("enc(access-fresh)");
    expect(persisted?.requires_reconnect).toBe(false);
    // The Bearer token is the NEW one.
    const sentWith = (
      fetchMock.mock.calls[1][1] as { headers: Record<string, string> }
    ).headers.authorization;
    expect(sentWith).toBe("Bearer access-fresh");
  });

  it("3) Gmail rejects the token but a refresh token exists → refresh + retry once (no user action)", async () => {
    routeGmail([gmailError(401, "authError"), gmailOk()], [tokenOk()]);
    await expect(send()).resolves.toEqual({
      providerMessageId: "gmail-message-1",
    });
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls[0]).toContain("gmail.googleapis.com");
    expect(urls[1]).toContain("oauth2.googleapis.com");
    expect(urls[2]).toContain("gmail.googleapis.com");
    // No reconnect was forced on the user.
    expect(updates.some((row) => row.requires_reconnect === true)).toBe(false);
  });

  it("3b) refresh itself is revoked → safe reconnect error, account flagged", async () => {
    routeGmail(
      [gmailError(401, "authError")],
      [() => Response.json({ error: "invalid_grant" }, { status: 400 })],
    );
    const error = await send().catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe("reconnect_required");
    expect(String((error as { message?: string }).message)).toMatch(/Reconnect/);
    expect(updates.some((row) => row.requires_reconnect === true)).toBe(true);
  });

  it("4) no refresh token + rejected access token → explicit reconnect error", async () => {
    account({ refresh_token_encrypted: null });
    routeGmail([gmailError(401, "authError")]);
    const error = await send().catch((e: unknown) => e);
    expect((error as { message?: string }).message).toBe(
      "Gmail authentication expired. Reconnecting is required.",
    );
    expect(updates.some((row) => row.requires_reconnect === true)).toBe(true);
  });

  it("5) 403 insufficientPermissions → permission message (never the generic one)", async () => {
    routeGmail([gmailError(403, "insufficientPermissions")], []);
    const error = await send().catch((e: unknown) => e);
    const failure = error as { code?: string; message?: string; reconnect?: boolean };
    expect(failure.code).toBe("gmail_scope_missing");
    expect(failure.message).toContain("Gmail permission");
    expect(failure.message).not.toContain("Reconnect your Gmail account");
    expect(failure.reconnect).toBe(true);
    // …and precisely reported in the logs.
    const logged = warnSpy.mock.calls
      .map((call) => call.map(String).join(" "))
      .join("|");
    expect(logged).toContain("stage=send");
    expect(logged).toContain("gmail_scope_missing");
  });

  it("5b) Gmail API not enabled → configuration message, no reconnect demanded", async () => {
    routeGmail([gmailError(403, "accessNotConfigured")]);
    const error = await send().catch((e: unknown) => e);
    const failure = error as { code?: string; message?: string };
    expect(failure.code).toBe("provider_not_configured");
    expect(failure.message).toContain("Gmail API is not enabled");
    expect(updates.some((row) => row.requires_reconnect === true)).toBe(false);
  });

  it("6) rate limit → temporary (retryable), not a reconnect", async () => {
    // Gmail answers a plain 429 (or 403 + rateLimitExceeded) when a quota or
    // rate limit is hit; both must be retryable and must NOT ask for a
    // reconnect.
    routeGmail([gmailError(429, "rateLimitExceeded")]);
    const limited = (await send().catch((e: unknown) => e)) as {
      code?: string;
      temporary?: boolean;
    };
    expect(limited.code).toBe("provider_temporary");
    expect(limited.temporary).toBe(true);

    routeGmail([gmailError(403, "rateLimitExceeded")]);
    const quota = (await send().catch((e: unknown) => e)) as {
      code?: string;
      temporary?: boolean;
    };
    expect(quota.code).toBe("provider_rate_limited");
    expect(quota.temporary).toBe(true);
    expect(updates.some((row) => row.requires_reconnect === true)).toBe(false);
  });

  it("6b) 5xx → temporary, and never reported as sent", async () => {
    routeGmail([() => Response.json({}, { status: 503 })]);
    const error = await send().catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe("provider_temporary");
    expect((error as { temporary?: boolean }).temporary).toBe(true);
  });

  it("7) never logs a token, code or secret", async () => {
    routeGmail([gmailOk()]);
    await send();
    routeGmail([gmailError(401, "authError"), gmailOk()], [tokenOk()]);
    await send();
    const logged = warnSpy.mock.calls
      .map((call) => call.map(String).join(" "))
      .join("\n");
    for (const secret of [
      "access-1",
      "refresh-1",
      "dec(access-1)",
      "dec(refresh-1)",
      "access-fresh",
      "Bearer",
    ])
      expect(logged).not.toContain(secret);
  });
});
