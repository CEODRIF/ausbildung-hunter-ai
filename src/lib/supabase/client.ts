import { createBrowserClient } from "@supabase/ssr";
import { getSupabaseEnv } from "@/lib/supabase/config";

export function createClient() {
  const { supabaseUrl, supabaseAnonKey } = getSupabaseEnv();
  return createBrowserClient(supabaseUrl, supabaseAnonKey);
}
