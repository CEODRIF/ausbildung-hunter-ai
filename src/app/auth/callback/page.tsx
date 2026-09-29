import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/**
 * Supabase Auth email-confirmation callback.
 *
 * The user clicks the verification link (…/auth/callback?next=/onboarding)
 * and Supabase appends `?code=…`. We exchange the code for a session with
 * the anon-key server client (no service role, no secrets), verify the
 * session, and forward to the requested `next` target (relative paths only).
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

export default async function AuthCallbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const code = first(params.code);
  const next = safeNext(first(params.next));

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code ?? "");
  if (error) redirect("/login");

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  redirect(next);
}
