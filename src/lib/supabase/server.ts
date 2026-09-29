import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getSupabaseEnv } from "@/lib/supabase/config";

export async function createClient() {
  const cookieStore = await cookies();
  const { supabaseUrl, supabaseAnonKey } = getSupabaseEnv();

  return createServerClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: true,
      // The Supabase project runs in PKCE flow type: signUp() must send the
      // code challenge (and persist the verifier to the sb-*-code-verifier
      // cookies), and /auth/callback exchanges the one-time code with that
      // verifier. Without this, the confirmation link can never be
      // exchanged, the email is never confirmed, and no session is created.
      flowType: "pkce",
    },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Server Components cannot always write cookies. Middleware refreshes them.
        }
      },
    },
  });
}
