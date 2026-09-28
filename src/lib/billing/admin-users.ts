import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

export interface AdminUserListRow {
  id: string;
  email: string;
  full_name: string;
  selected_goal: string | null;
  account_status: string;
  created_at: string;
  is_admin: boolean;
  subscription: {
    plan: string;
    status: string;
    current_period_end: string | null;
  } | null;
  usage_today: { emails_sent: number; ai_requests: number };
}

/** Server-side admin user list (bounded to 50 rows, optional email
 *  filter). Reads are service-role and joined in application code —
 *  the admin UI/API never exposes raw storage or tokens. */
export async function listAdminUsers(
  emailFilter?: string,
): Promise<AdminUserListRow[]> {
  const admin = createAdminClient();
  let query = admin
    .from("profiles")
    .select("id, email, full_name, selected_goal, account_status, created_at")
    .order("created_at", { ascending: false })
    .limit(50);
  if (emailFilter && emailFilter.trim().length >= 3) {
    query = query.ilike("email", `%${emailFilter.trim()}%`);
  }
  const { data: profiles, error } = await query;
  if (error || !profiles || profiles.length === 0) return [];

  const ids = profiles.map((profile) => profile.id as string);
  const [subs, admins] = await Promise.all([
    admin
      .from("subscriptions")
      .select("user_id, plan, status, current_period_end")
      .in("user_id", ids),
    admin.from("admins").select("user_id").in("user_id", ids),
  ]);

  // Per-user today counters (bounded fan-out, list is capped at 50).
  const usageById = new Map<
    string,
    { emails_sent: number; ai_requests: number }
  >();
  for (const id of ids) {
    const { data } = await admin.rpc("get_daily_usage_snapshot", {
      target_user_id: id,
    });
    if (data) {
      usageById.set(id, {
        emails_sent: data.emails_sent ?? 0,
        ai_requests: data.ai_requests ?? 0,
      });
    }
  }

  const subById = new Map(
    (
      (subs.data ?? []) as Array<{
        user_id: string;
        plan: string;
        status: string;
        current_period_end: string | null;
      }>
    ).map((row) => [row.user_id, row]),
  );
  const adminSet = new Set(
    ((admins.data ?? []) as Array<{ user_id: string }>).map(
      (row) => row.user_id,
    ),
  );

  return profiles.map((profile) => {
    const id = profile.id as string;
    const sub = subById.get(id) ?? null;
    return {
      id,
      email: profile.email as string,
      full_name: profile.full_name as string,
      selected_goal: (profile.selected_goal as string | null) ?? null,
      account_status: profile.account_status as string,
      created_at: profile.created_at as string,
      is_admin: adminSet.has(id),
      subscription: sub
        ? {
            plan: sub.plan,
            status: sub.status,
            current_period_end: sub.current_period_end,
          }
        : null,
      usage_today: usageById.get(id) ?? { emails_sent: 0, ai_requests: 0 },
    };
  });
}
