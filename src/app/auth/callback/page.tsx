import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/**
 * Supabase Auth email-confirmation callback (PKCE).
 *
 * The user clicks the verification link
 * (…/auth/callback?next=/onboarding&sb_flow_id=…) and Supabase appends
 * `&code=…`. The one-time code is exchanged for a session with the anon-key
 * server client — configured with `flowType: "pkce"` — which supplies the
 * code verifier from the `sb-*-code-verifier` cookies set at sign-up.
 * The `sb_flow_id` from the URL selects the exact pending PKCE flow.
 *
 * The database trigger on_auth_user_email_confirmed activates the profile
 * and consumes the invitation code when the email is confirmed — nothing in
 * this route reads email_confirmed_at directly.
 */

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Only same-origin relative paths are honored — no open redirects. */
function safeNext(value: string | undefined): string {
  if (value && value.startsWith("/") && !value.startsWith("//")) return value;
  return "/onboarding";
}

function scrub(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [redacted]")
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
      "[redacted-jwt]",
    );
}

export default async function AuthCallbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const code = first(params.code);
  const flowId = first(params.sb_flow_id);
  const next = safeNext(first(params.next));

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(
    code ?? "",
    flowId ? { flowId } : undefined,
  );
  if (error) {
    // Keep the failure diagnosable in production without leaking secrets.
    console.error(`[callback] code exchange failed: "${scrub(error.message)}"`);
    redirect("/login");
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  redirect(next);
}
