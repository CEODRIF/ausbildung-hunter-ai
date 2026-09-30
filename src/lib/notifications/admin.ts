import "server-only";

import type { Profile } from "@/lib/auth";
import { requireAdmin } from "@/lib/billing/admin";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  sendNotificationSchema,
  type AdminNotificationRow,
  type NotificationRecipient,
  type SendNotificationInput,
} from "./types";

/**
 * Platform owner authorization (server-side, never client-side).
 *
 * The Platform Updates feature (including targeted notifications and the
 * recipient search) is reserved for the single owner account:
 *   1. authenticated session (requireAdmin → supabase.auth.getUser),
 *   2. verified admin membership (public.admins — users cannot write it),
 *   3. the account email matches the platform owner email exactly.
 * A regular user — or any non-owner admin — fails step 3.
 */
export const PLATFORM_OWNER_EMAIL = "adsium.business@gmail.com";

export async function requirePlatformOwner(): Promise<Profile | null> {
  const admin = await requireAdmin();
  if (!admin) return null;
  if ((admin.email ?? "").trim().toLowerCase() !== PLATFORM_OWNER_EMAIL) {
    return null;
  }
  return admin;
}

/** Hard cap on recipient search results (no bulk user export). */
const RECIPIENT_SEARCH_LIMIT = 10;
const RECIPIENT_HISTORY_LIMIT = 50;

function sanitizeSearchQuery(raw: string): string {
  // Strip Postgres pattern wildcards so the query is literal text only.
  return raw.trim().replace(/[%_\\]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Search recipients by email or full name (server-side, owner-only).
 * Returns at most 10 minimal identity rows — no other profile fields.
 */
export async function searchNotificationRecipients(
  query: string,
): Promise<NotificationRecipient[]> {
  const q = sanitizeSearchQuery(query);
  if (q.length < 2 || q.length > 120) return [];
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("profiles")
    .select("id, email, full_name")
    .or(`email.ilike.%${q}%,full_name.ilike.%${q}%`)
    .order("email", { ascending: true })
    .limit(RECIPIENT_SEARCH_LIMIT);
  if (error || !data) return [];
  return data
    .map((row) => ({
      id: String(row.id),
      email: String(row.email ?? ""),
      full_name: String(row.full_name ?? ""),
    }))
    .filter((row) => row.email.length > 0);
}

export interface SendNotificationResult {
  /** true when this was a duplicate submit (same idempotency key) and the
   *  ORIGINAL notification is returned — nothing new was created. */
  duplicate: boolean;
  notification: AdminNotificationRow;
}

async function fetchRecipient(id: string): Promise<NotificationRecipient | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("profiles")
    .select("id, email, full_name")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  return {
    id: String(data.id),
    email: String(data.email ?? ""),
    full_name: String(data.full_name ?? ""),
  };
}

async function rowToAdminNotification(
  row: Record<string, unknown>,
): Promise<AdminNotificationRow> {
  const targetType = row.target_type === "all" ? "all" : "user";
  const targetUserId =
    targetType === "user" ? (row.target_user_id as string) : null;
  const recipient = targetUserId ? (await fetchRecipient(targetUserId)) : null;
  return {
    id: String(row.id),
    title: String(row.title),
    content: String(row.content),
    type: row.type as AdminNotificationRow["type"],
    target_type: targetType,
    target_user_id: targetUserId,
    created_at: String(row.created_at),
    recipient,
  };
}

/**
 * Create a notification (global or targeted).
 *
 * Authorization is the caller's responsibility (`requirePlatformOwner`);
 * `owner` is the verified session profile — its id is recorded as
 * `created_by`. The target user must exist (server re-derives the
 * recipient; a client-supplied identity is never trusted).
 *
 * Idempotency: `input.idempotency_key` is unique per notification. A
 * duplicate submit (double-click / network retry) resolves to the original
 * row with `duplicate: true` — no second notification is ever created.
 */
export async function sendNotification(
  owner: Profile,
  input: unknown,
): Promise<
  | { ok: true; result: SendNotificationResult }
  | { ok: false; reason: "invalid_input" | "target_not_found" | "db_error" }
> {
  const parsed = sendNotificationSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid_input" };
  const body: SendNotificationInput = parsed.data;

  const targetUserId =
    body.target_type === "user" ? body.target_user_id ?? null : null;
  if (body.target_type === "user" && targetUserId === null) {
    return { ok: false, reason: "invalid_input" };
  }

  // Targeted: the recipient must exist RIGHT NOW, from the server's data.
  let recipient: NotificationRecipient | null = null;
  if (targetUserId !== null) {
    recipient = await fetchRecipient(targetUserId);
    if (!recipient) return { ok: false, reason: "target_not_found" };
  }

  const admin = createAdminClient();
  const { data: inserted, error } = await admin
    .from("notifications")
    .insert({
      title: body.title,
      content: body.content,
      type: body.type,
      target_type: body.target_type,
      target_user_id: targetUserId,
      created_by: owner.id,
      send_key: body.idempotency_key,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      // Unique send_key conflict → this exact submit already happened.
      const { data: existing } = await admin
        .from("notifications")
        .select("*")
        .eq("send_key", body.idempotency_key)
        .maybeSingle();
      if (existing) {
        return {
          ok: true,
          result: {
            duplicate: true,
            notification: await rowToAdminNotification(existing),
          },
        };
      }
    }
    return { ok: false, reason: "db_error" };
  }
  if (!inserted) return { ok: false, reason: "db_error" };

  return {
    ok: true,
    result: {
      duplicate: false,
      notification: {
        id: String(inserted.id),
        title: String(inserted.title),
        content: String(inserted.content),
        type: inserted.type as AdminNotificationRow["type"],
        target_type: body.target_type,
        target_user_id: targetUserId,
        created_at: String(inserted.created_at),
        recipient,
      },
    },
  };
}

/** History of notifications the owner sent (newest first, ≤ 50). */
export async function listSentNotifications(
  owner: Profile,
): Promise<AdminNotificationRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("notifications")
    .select("id, title, content, type, target_type, target_user_id, created_at")
    .eq("created_by", owner.id)
    .order("created_at", { ascending: false })
    .limit(RECIPIENT_HISTORY_LIMIT);
  if (error || !data || data.length === 0) return [];
  // Bounded fan-out: one profiles lookup for all target ids (≤ 50).
  const targetIds = [
    ...new Set(
      data
        .map((row) =>
          row.target_type === "user" ? (row.target_user_id as string) : null,
        )
        .filter((id): id is string => id !== null),
    ),
  ];
  const recipients = new Map<string, NotificationRecipient>();
  if (targetIds.length > 0) {
    const { data: profiles } = await admin
      .from("profiles")
      .select("id, email, full_name")
      .in("id", targetIds);
    for (const row of profiles ?? []) {
      recipients.set(String(row.id), {
        id: String(row.id),
        email: String(row.email ?? ""),
        full_name: String(row.full_name ?? ""),
      });
    }
  }
  const rows: AdminNotificationRow[] = [];
  for (const row of data) {
    const targetType = row.target_type === "all" ? "all" : "user";
    rows.push({
      id: String(row.id),
      title: String(row.title),
      content: String(row.content),
      type: row.type as AdminNotificationRow["type"],
      target_type: targetType,
      target_user_id:
        targetType === "user" ? (row.target_user_id as string) : null,
      created_at: String(row.created_at),
      recipient:
        targetType === "user" && row.target_user_id
          ? (recipients.get(row.target_user_id as string) ?? null)
          : null,
    });
  }
  return rows;
}
