import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createOAuthState } from "@/lib/oauth-state";
import {
  clientIdSuffix,
  getProviderConfig,
  getProviderScopes,
  oauthConfigStatus,
  type EmailProvider,
} from "@/lib/email-oauth";
import { checkRateLimit, tooManyRequests } from "@/lib/rate-limit";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const provider = (await params).provider as EmailProvider;
  if (provider !== "gmail" && provider !== "outlook")
    return NextResponse.redirect(
      new URL("/settings/email?error=unsupported_provider", request.url),
    );
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));
  const limited = await checkRateLimit("email_oauth", user.id);
  if (!limited.allowed) return tooManyRequests(limited);
  const config = getProviderConfig(provider);
  const configStatus = oauthConfigStatus(provider);
  const origin = new URL(request.url).origin;
  const callbackRoute = `/api/email/callback/${provider}`;
  // Safe start diagnostics: public identifier suffix + URLs + booleans only.
  console.info("[GOOGLE_OAUTH] start", {
    provider,
    clientIdSuffix: clientIdSuffix(config.clientId),
    redirectUri: config.redirectUri ?? null,
    origin,
    callbackRoute,
    configured: configStatus,
  });
  // The redirect_uri sent to Google must match the Authorized redirect URI
  // literally (scheme, host incl. www, path, no stray trailing slash).
  const expectedRedirectUri = `${origin}${callbackRoute}`;
  if (config.redirectUri && config.redirectUri !== expectedRedirectUri)
    console.warn("[GOOGLE_OAUTH] redirect_uri differs from this deployment", {
      configuredRedirectUri: config.redirectUri,
      expectedForThisOrigin: expectedRedirectUri,
      hint: "Add the configured value VERBATIM under Google Cloud → Clients → Authorized redirect URIs.",
    });
  // Fail fast BEFORE the user consents when the flow cannot succeed (this
  // also narrows the config type for the request below).
  if (
    !config.clientId ||
    !config.clientSecret ||
    !config.redirectUri ||
    !configStatus.complete
  )
    return NextResponse.redirect(
      new URL(`/settings/email?error=${provider}_not_configured`, request.url),
    );
  const state = await createOAuthState(provider);
  const scopes = getProviderScopes(provider).join(" ");
  const authorizationUrl =
    provider === "gmail"
      ? new URL("https://accounts.google.com/o/oauth2/v2/auth")
      : new URL(
          "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        );
  authorizationUrl.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: scopes,
    state,
    ...(provider === "gmail"
      ? { access_type: "offline", prompt: "consent" }
      : { response_mode: "query" }),
  }).toString();
  return NextResponse.redirect(authorizationUrl);
}
