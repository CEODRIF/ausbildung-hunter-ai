import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { consumeOAuthState } from "@/lib/oauth-state";
import {
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
  if (!(await consumeOAuthState(provider, url.searchParams.get("state")))) {
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
    if (provider === "gmail") {
      const identity = await fetchGoogleIdentity(tokens.access_token);
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
    console.error("Email OAuth callback failed", {
      provider,
      reason: error instanceof Error ? error.message : "unknown",
    });
    destination.searchParams.set("error", "connection_failed");
  }
  return NextResponse.redirect(destination);
}
