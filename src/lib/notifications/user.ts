import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import type { UserNotification } from "./types";

/**
 * User-facing notification access (in-app only — no email/SMS/push).
 *
 * Reads are service-role but STRICTLY scoped to the authenticated user:
 * a user sees exactly `target_type = 'all'` rows plus rows where
 * `target_user_id = <their id>`. Read receipts are per (notification,
 * user), so "read" never leaks between users. The RLS policies in the
 * migration mirror this scoping as defense in depth.
 */
const USER_LIST_LIMIT = 20;

export async function listUserNotifications(
  userId: string,
): Promise<UserNotification[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("notifications")
    .select("id, title, content, type, created_at")
    .or(`target_type.eq.all,target_user_id.eq.${userId}`)
    .order("created_at", { ascending: false })
    .limit(USER_LIST_LIMIT);
  if (error || !data || data.length === 0) return [];

  const ids = data.map((row) => String(row.id));
  const { data: reads } = await admin
    .from("notification_reads")
    .select("notification_id, read_at")
    .eq("user_id", userId)
    .in("notification_id", ids);
  const readById = new Map<string, string>();
  for (const row of reads ?? []) {
    readById.set(String(row.notification_id), String(row.read_at));
  }

  return data.map((row) => {
    const id = String(row.id);
    return {
      id,
      title: String(row.title),
      content: String(row.content),
      type: row.type as UserNotification["type"],
      created_at: String(row.created_at),
      read: readById.has(id),
      read_at: readById.get(id) ?? null,
    };
  });
}

export async function markNotificationRead(
  userId: string,
  notificationId: string,
): Promise<{ ok: true; read_at: string } | { ok: false; reason: "not_found" | "db_error" }> {
  const admin = createAdminClient();
  // Verify the notification actually concerns this user before recording
  // a receipt (no cross-user probing via read receipts).
  const { data: notification } = await admin
    .from("notifications")
    .select("id, target_type, target_user_id")
    .eq("id", notificationId)
    .maybeSingle();
  if (!notification) return { ok: false, reason: "not_found" };
  const visible =
    notification.target_type === "all" ||
    notification.target_user_id === userId;
  if (!visible) return { ok: false, reason: "not_found" };

  const { data: receipt, error } = await admin
    .from("notification_reads")
    .upsert(
      { notification_id: notificationId, user_id: userId },
      { onConflict: "notification_id,user_id", ignoreDuplicates: true },
    )
    .select("read_at")
    .single();
  if (error || !receipt) return { ok: false, reason: "db_error" };
  return { ok: true, read_at: String(receipt.read_at) };
}
