import "server-only";

import { decryptEmailToken, encryptEmailToken } from "@/lib/email-crypto";
import { createAdminClient } from "@/lib/supabase/admin";

export type EmailProvider = "gmail" | "outlook";
export type SafeEmailAccount = {
  id: string;
  provider: EmailProvider;
  email: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
};

const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.send",
];
const MICROSOFT_SCOPES = [
  "openid",
  "email",
  "offline_access",
  "https://graph.microsoft.com/Mail.Send",
];

export function getProviderScopes(provider: EmailProvider) {
  return provider === "gmail" ? GOOGLE_SCOPES : MICROSOFT_SCOPES;
}

export function getProviderConfig(provider: EmailProvider) {
  if (provider === "gmail")
    return {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      redirectUri: process.env.GOOGLE_REDIRECT_URI,
    };
  return {
    clientId: process.env.MICROSOFT_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    redirectUri: process.env.MICROSOFT_REDIRECT_URI,
  };
}

/**
 * Read the provider's JSON error body so the *real* failure reason
 * (e.g. Google's `invalid_client`, a PostgREST `42P01`) survives into the
 * callback log instead of a generic message that hides it.
 */
class OAuthProviderFailure extends Error {
  /** HTTP status returned by the provider (400/401/403/…). */
  readonly status: number;
  /** Provider error code, e.g. Google's `invalid_grant` (safe to log). */
  readonly providerError: string | null;
  /** Provider's human description (never contains the secret). */
  readonly providerDescription: string | null;
  constructor(
    fallback: string,
    status: number,
    providerError: string | null,
    providerDescription: string | null,
  ) {
    super(
      `${fallback} (HTTP ${status}${providerError ? `: ${providerError}` : ""}` +
        `${providerDescription ? `: ${providerDescription}` : ""})`,
    );
    this.name = "OAuthProviderFailure";
    this.status = status;
    this.providerError = providerError;
    this.providerDescription = providerDescription;
  }
}

async function describeProviderFailure(
  response: Response,
  fallback: string,
): Promise<Error> {
  let providerError: string | null = null;
  let providerDescription: string | null = null;
  try {
    const body = (await response.json()) as {
      error?: unknown;
      error_description?: unknown;
      message?: unknown;
    };
    providerError =
      typeof body.error === "string"
        ? body.error
        : typeof body.message === "string"
          ? null
          : null;
    const description = body.error_description ?? body.message;
    providerDescription =
      typeof description === "string" ? description : null;
  } catch {
    // Non-JSON error body (gateway HTML, empty body) — fallback suffices.
  }
  return new OAuthProviderFailure(
    fallback,
    response.status,
    providerError,
    providerDescription,
  );
}

/** Safe, fixed-set reason codes surfaced to the UI (never a secret). */
export type OAuthFailureReason =
  | "redirect_uri_mismatch"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "access_denied"
  | "invalid_request"
  | "permission_denied"
  | "identity_check_failed"
  | "token_save_failed"
  | "config_incomplete"
  | "network_error";

/**
 * Classify an OAuth failure into a safe code so the real cause is visible in
 * the UI and the logs — no secrets, no tokens, no personal data.
 */
export function classifyOAuthFailure(error: unknown): {
  reason: OAuthFailureReason;
  status: number | null;
} {
  if (error instanceof OAuthProviderFailure) {
    const code = error.providerError ?? "";
    if (/redirect_uri_mismatch/i.test(code))
      return { reason: "redirect_uri_mismatch", status: error.status };
    if (/invalid_client/i.test(code))
      return { reason: "invalid_client", status: error.status };
    if (/invalid_grant/i.test(code))
      return { reason: "invalid_grant", status: error.status };
    if (/unauthorized_client/i.test(code))
      return { reason: "unauthorized_client", status: error.status };
    if (/access_denied/i.test(code))
      return { reason: "access_denied", status: error.status };
    if (/invalid_request/i.test(code))
      return { reason: "invalid_request", status: error.status };
    if (error.status === 401 || error.status === 403)
      return { reason: "permission_denied", status: error.status };
    return { reason: "invalid_request", status: error.status };
  }
  const message = error instanceof Error ? error.message : "";
  if (/EMAIL_TOKEN_ENCRYPTION_KEY is not configured/i.test(message))
    return { reason: "config_incomplete", status: null };
  if (/Unable to verify provider account/i.test(message))
    return { reason: "identity_check_failed", status: null };
  if (/Saving email account failed/i.test(message))
    return { reason: "token_save_failed", status: null };
  if (/is not configured/i.test(message))
    return { reason: "config_incomplete", status: null };
  return { reason: "network_error", status: null };
}

/**
 * Which parts of the OAuth configuration are present (booleans only — the
 * values, and especially the secret, are never returned or logged).
 */
export function oauthConfigStatus(provider: EmailProvider) {
  const config = getProviderConfig(provider);
  return {
    clientId: Boolean(config.clientId),
    clientSecret: Boolean(config.clientSecret),
    redirectUri: Boolean(config.redirectUri),
    encryptionKey: Boolean(process.env.EMAIL_TOKEN_ENCRYPTION_KEY),
    complete: Boolean(
      config.clientId &&
        config.clientSecret &&
        config.redirectUri &&
        process.env.EMAIL_TOKEN_ENCRYPTION_KEY,
    ),
  };
}

/** Public identifier suffix only (a client id is public, still kept short). */
export function clientIdSuffix(clientId: string | undefined): string {
  if (!clientId) return "none";
  return clientId.length <= 8 ? clientId : `…${clientId.slice(-8)}`;
}

export async function saveEmailAccount(input: {
  userId: string;
  provider: EmailProvider;
  providerAccountId: string;
  email: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  scopes: string[];
}) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("email_accounts")
    .upsert(
      {
        user_id: input.userId,
        provider: input.provider,
        provider_account_id: input.providerAccountId,
        email: input.email,
        access_token_encrypted: encryptEmailToken(input.accessToken),
        refresh_token_encrypted: input.refreshToken
          ? encryptEmailToken(input.refreshToken)
          : null,
        token_expires_at: input.expiresAt,
        scopes: input.scopes,
        is_active: true,
        last_used_at: null,
      },
      { onConflict: "user_id,provider,provider_account_id" },
    )
    .select(
      "id, provider, email, is_active, created_at, updated_at, last_used_at",
    )
    .single<SafeEmailAccount>();
  if (error)
    throw new Error(
      `Saving email account failed${error.code ? ` [${error.code}]` : ""}: ${error.message}`,
    );
  return data;
}

export async function listEmailAccounts(userId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("email_accounts")
    .select(
      "id, provider, email, is_active, created_at, updated_at, last_used_at",
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as SafeEmailAccount[];
}

/**
 * Safe projection for the Email Assistant settings page: the same fields as
 * SafeEmailAccount plus the CURRENT re-authorization state
 * (`requires_reconnect`, set by the provider layer when a token refresh
 * fails or the grant is revoked). Still token-free — encrypted tokens stay
 * server-side and are never part of this projection.
 */
export type EmailAccountStatus = SafeEmailAccount & {
  requires_reconnect: boolean;
};

export async function listEmailAccountsWithStatus(
  userId: string,
): Promise<EmailAccountStatus[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("email_accounts")
    .select(
      "id, provider, email, is_active, created_at, updated_at, last_used_at, requires_reconnect",
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as EmailAccountStatus[];
}

export async function revokeEmailAuthorization(
  userId: string,
  accountId: string,
) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("email_accounts")
    .select("provider, access_token_encrypted")
    .eq("id", accountId)
    .eq("user_id", userId)
    .maybeSingle<{ provider: EmailProvider; access_token_encrypted: string }>();
  if (error) throw new Error(error.message);
  if (!data || data.provider !== "gmail") return;
  const accessToken = decryptEmailToken(data.access_token_encrypted);
  const response = await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: accessToken }),
    cache: "no-store",
  });
  if (!response.ok && response.status !== 400)
    throw new Error("Provider authorization could not be revoked.");
}

export async function deleteEmailAccount(userId: string, accountId: string) {
  const admin = createAdminClient();
  const { error } = await admin
    .from("email_accounts")
    .delete()
    .eq("id", accountId)
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
}

export type DisconnectBlockers = {
  /** Campaigns still `queued`/`sending` on this sender. Disconnecting
   *  would strand live sends — blocked (campaigns are SET NULL only
   *  after they reach a terminal state, by which point no sends remain). */
  activeCampaigns: number;
  /** Drafts that use this account as sender. A draft must keep its
   *  sender to stay sendable (FK RESTRICT) — blocked until the user
   *  deletes or reassigns them. */
  drafts: number;
};

/** Server-derived usage counts for one of the user's accounts. Both
 *  queries are user- AND account-scoped (head counts, no rows moved). */
export async function getDisconnectBlockers(
  userId: string,
  accountId: string,
): Promise<DisconnectBlockers> {
  const admin = createAdminClient();
  const [campaigns, drafts] = await Promise.all([
    admin
      .from("email_campaigns")
      .select("id", { count: "exact", head: true })
      .eq("email_account_id", accountId)
      .eq("user_id", userId)
      .in("status", ["queued", "sending"]),
    admin
      .from("application_drafts")
      .select("id", { count: "exact", head: true })
      .eq("sender_email_account_id", accountId)
      .eq("user_id", userId),
  ]);
  return {
    activeCampaigns: campaigns.count ?? 0,
    drafts: drafts.count ?? 0,
  };
}

export async function exchangeGoogleCode(code: string) {
  const config = getProviderConfig("gmail");
  if (!config.clientId || !config.clientSecret || !config.redirectUri)
    throw new Error("Gmail OAuth is not configured.");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    }),
    cache: "no-store",
  });
  if (!response.ok)
    throw await describeProviderFailure(response, "Gmail authorization failed.");
  return (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
}

export async function exchangeMicrosoftCode(code: string) {
  const config = getProviderConfig("outlook");
  if (!config.clientId || !config.clientSecret || !config.redirectUri)
    throw new Error("Outlook OAuth is not configured.");
  const response = await fetch(
    "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: "authorization_code",
        scope: MICROSOFT_SCOPES.join(" "),
      }),
      cache: "no-store",
    },
  );
  if (!response.ok) throw new Error("Outlook authorization failed.");
  return (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
}

export async function fetchGoogleIdentity(accessToken: string) {
  const response = await fetch(
    "https://openidconnect.googleapis.com/v1/userinfo",
    { headers: { authorization: `Bearer ${accessToken}` }, cache: "no-store" },
  );
  if (!response.ok)
    throw await describeProviderFailure(response, "Gmail account verification failed.");
  return (await response.json()) as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
  };
}
export async function fetchMicrosoftIdentity(accessToken: string) {
  const response = await fetch(
    "https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName",
    { headers: { authorization: `Bearer ${accessToken}` }, cache: "no-store" },
  );
  if (!response.ok) throw new Error("Outlook account verification failed.");
  return (await response.json()) as {
    id?: string;
    mail?: string;
    userPrincipalName?: string;
  };
}
