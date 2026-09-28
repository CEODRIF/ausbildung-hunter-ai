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
  if (error) throw new Error(error.message);
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
  if (!response.ok) throw new Error("Gmail authorization failed.");
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
  if (!response.ok) throw new Error("Gmail account verification failed.");
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
