/**
 * Browser-safe Supabase configuration.
 *
 * This module is imported by BOTH the browser client (`supabase/client.ts`)
 * and the server client (`supabase/server.ts`), so it may only ever touch
 * `NEXT_PUBLIC_*` values. Server secrets are read exclusively inside
 * `server-only` modules — the service-role key lives in `supabase/admin.ts`.
 *
 * The two public values here are not secrets: the project URL and the anon /
 * publishable key are designed to ship to the browser, where RLS is the
 * enforcement boundary.
 */
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export function getSupabaseEnv() {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY.",
    );
  }
  return { supabaseUrl, supabaseAnonKey };
}
