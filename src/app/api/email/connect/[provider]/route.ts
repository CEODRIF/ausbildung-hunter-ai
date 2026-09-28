import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createOAuthState } from "@/lib/oauth-state";
import {
  getProviderConfig,
  getProviderScopes,
  type EmailProvider,
} from "@/lib/email-oauth";

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
  const config = getProviderConfig(provider);
  if (!config.clientId || !config.redirectUri)
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
