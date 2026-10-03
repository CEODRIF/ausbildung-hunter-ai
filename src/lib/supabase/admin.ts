import "server-only";

import { createClient } from "@supabase/supabase-js";

/**
 * Server-only Supabase environment (service role).
 *
 * This accessor lives HERE and not in `supabase/config.ts`: that module is part
 * of the browser client's import graph (`supabase/client.ts` imports it), so a
 * service-role reference there shipped the secret's NAME into the client
 * bundle. Only `server-only` modules may read server secrets — the invariant is
 * enforced by tests/security/secret-exposure.test.ts.
 */
export function getSupabaseAdminEnv() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error("Missing Supabase server environment variables.");
  }
  return { supabaseUrl, supabaseServiceRoleKey };
}

export function createAdminClient() {
  const { supabaseUrl, supabaseServiceRoleKey } = getSupabaseAdminEnv();
  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
