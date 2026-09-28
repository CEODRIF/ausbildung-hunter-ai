const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export function getSupabaseEnv() {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY.",
    );
  }
  return { supabaseUrl, supabaseAnonKey };
}

export function getSupabaseAdminEnv() {
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error("Missing Supabase server environment variables.");
  }
  return { supabaseUrl, supabaseServiceRoleKey };
}
