import { createBrowserClient } from "@supabase/ssr";
import { getSupabaseEnv } from "@/lib/supabase/config";

export function createClient() {
  const { supabaseUrl, supabaseAnonKey } = getSupabaseEnv();
  return createBrowserClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      // Must match the server client: the Supabase project runs in PKCE flow
      // type, and the email-confirmation code exchange requires the verifier
      // stored by the PKCE-enabled client.
      flowType: "pkce",
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
}
