import { z } from "zod";

export const NOTIFICATION_TYPES = [
  "info",
  "important",
  "maintenance",
  "improvement",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);
export const notificationTargetSchema = z.enum(["all", "user"]);

const UUID = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

/** Owner-composed notification (admin API input). */
export const sendNotificationSchema = z
  .object({
    target_type: notificationTargetSchema,
    // The client may propose a target — the server re-validates existence
    // and re-derives the recipient from its own database (no spoofing).
    target_user_id: UUID.nullable().optional(),
    title: z.string().trim().min(3).max(120),
    content: z.string().trim().min(3).max(2000),
    type: notificationTypeSchema,
    // Idempotency: client-generated per form open; a duplicate submit with
    // the same key returns the original row instead of a duplicate.
    idempotency_key: UUID,
  })
  .refine(
    (value) =>
      value.target_type === "all"
        ? value.target_user_id == null
        : value.target_user_id != null,
    {
      message: "target_user_id must be set exactly for targeted sends",
      path: ["target_user_id"],
    },
  );
export type SendNotificationInput = z.infer<typeof sendNotificationSchema>;

export const searchRecipientsSchema = z.object({
  query: z.string().trim().min(2).max(120),
});
export type SearchRecipientsInput = z.infer<typeof searchRecipientsSchema>;

/** Minimal recipient identity — ONLY what is needed to address a
 *  notification. Never a user-management surface. */
export interface NotificationRecipient {
  id: string;
  email: string;
  full_name: string;
}

/** Notification row as returned by the admin send/history APIs. */
export interface AdminNotificationRow {
  id: string;
  title: string;
  content: string;
  type: NotificationType;
  target_type: "all" | "user";
  target_user_id: string | null;
  created_at: string;
  recipient: NotificationRecipient | null; // null for "all"
}

/** Notification as seen by the end user (bell + dropdown). */
export interface UserNotification {
  id: string;
  title: string;
  content: string;
  type: NotificationType;
  created_at: string;
  read: boolean;
  read_at: string | null;
}
