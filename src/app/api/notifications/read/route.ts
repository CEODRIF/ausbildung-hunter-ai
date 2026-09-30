import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { markNotificationRead } from "@/lib/notifications/user";

const UUID = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

/**
 * POST /api/notifications/read
 *
 * Record a read receipt for the signed-in user (read_at = now). The server
 * verifies the notification actually concerns this user before recording —
 * receipts cannot be probed or forged for other users' notifications.
 * Idempotent: re-reading keeps the FIRST read_at.
 */
export async function POST(request: Request) {
  const { user } = await getCurrentUserAndProfile();
  if (!user)
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsedId = UUID.safeParse(
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>).notification_id
      : undefined,
  );
  if (!parsedId.success)
    return NextResponse.json(
      { error: "notification_id is required." },
      { status: 400 },
    );

  const result = await markNotificationRead(user.id, parsedId.data);
  if (!result.ok)
    return NextResponse.json({ error: "Notification not found." }, { status: 404 });
  return NextResponse.json({ read_at: result.read_at });
}
