import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { consumeOAuthState } from "@/lib/oauth-state";
import {
  classifyOAuthFailure,
  exchangeGoogleCode,
  exchangeMicrosoftCode,
  fetchGoogleIdentity,
  fetchMicrosoftIdentity,
  getProviderScopes,
  saveEmailAccount,
  type EmailProvider,
} from "@/lib/email-oauth";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const provider = (await params).provider as EmailProvider;
  const url = new URL(request.url);
  const destination = new URL("/settings/email", request.url);
  if (provider !== "gmail" && provider !== "outlook") {
    destination.searchParams.set("error", "unsupported_provider");
    return NextResponse.redirect(destination);
  }
  const submittedState = url.searchParams.get("state");
  const stateVerified = await consumeOAuthState(provider, submittedState);
  // Safe callback diagnostics: booleans + Google's error CODE only — the
  // authorization code, tokens, cookies and secrets are never logged.
  console.info("[GOOGLE_OAUTH] callback", {
    provider,
    hasCode: Boolean(url.searchParams.get("code")),
    providerErrorCode: url.searchParams.get("error"),
    hasState: Boolean(submittedState),
    stateVerified,
  });
  if (!stateVerified) {
    destination.searchParams.set("error", "invalid_oauth_state");
    return NextResponse.redirect(destination);
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    destination.searchParams.set("error", "session_expired");
    return NextResponse.redirect(destination);
  }
  const providerError = url.searchParams.get("error");
  if (providerError) {
    destination.searchParams.set(
      "error",
      providerError === "access_denied"
        ? "authorization_cancelled"
        : "provider_authorization_failed",
    );
    return NextResponse.redirect(destination);
  }
  const code = url.searchParams.get("code");
  if (!code) {
    destination.searchParams.set("error", "invalid_oauth_response");
    return NextResponse.redirect(destination);
  }
  try {
    const tokens =
      provider === "gmail"
        ? await exchangeGoogleCode(code)
        : await exchangeMicrosoftCode(code);
    if (!tokens.access_token) throw new Error("Missing access token.");
    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null;
    const scopes = tokens.scope?.split(" ") ?? getProviderScopes(provider);
    // Stage logging (temporary, diagnostic): metadata/booleans only — never
    // tokens, secrets or other credentials.
    console.info("[GOOGLE_OAUTH] token_exchange ok", {
      provider,
      hasAccessToken: Boolean(tokens.access_token),
      hasRefreshToken: Boolean(tokens.refresh_token),
      expiresInSeconds: tokens.expires_in ?? null,
      grantedScopes: scopes,
    });
    if (provider === "gmail") {
      const identity = await fetchGoogleIdentity(tokens.access_token);
      console.info("[GOOGLE_OAUTH] identity ok", {
        provider,
        hasSub: Boolean(identity.sub),
        hasEmail: Boolean(identity.email),
        emailVerified: identity.email_verified ?? null,
      });
      if (!identity.sub || !identity.email || identity.email_verified === false)
        throw new Error("Unable to verify provider account.");
      await saveEmailAccount({
        userId: user.id,
        provider,
        providerAccountId: identity.sub,
        email: identity.email,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        expiresAt,
        scopes,
      });
      console.info("[GOOGLE_OAUTH] account_saved ok", { provider });
    } else {
      const identity = await fetchMicrosoftIdentity(tokens.access_token);
      const email = identity.mail ?? identity.userPrincipalName;
      if (!identity.id || !email)
        throw new Error("Unable to verify provider account.");
      await saveEmailAccount({
        userId: user.id,
        provider,
        providerAccountId: identity.id,
        email,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        expiresAt,
        scopes,
      });
    }
    destination.searchParams.set("connected", provider);
  } catch (error) {
    // The real cause, classified into a fixed safe set (never a secret).
    const { reason, status } = classifyOAuthFailure(error);
    console.error("[GOOGLE_OAUTH] callback failed", {
      provider,
      reason,
      providerHttpStatus: status,
      detail: error instanceof Error ? error.message : "unknown",
    });
    destination.searchParams.set("error", "connection_failed");
    destination.searchParams.set("reason", reason);
    if (status) destination.searchParams.set("status", String(status));
  }
  return NextResponse.redirect(destination);
}
