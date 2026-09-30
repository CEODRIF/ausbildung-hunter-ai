import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { listSentNotifications, requirePlatformOwner } from "@/lib/notifications/admin";

/**
 * GET /api/admin/notifications/history
 *
 * The owner's sent-notification history (newest first, ≤ 50): title,
 * type, created_at, and a minimal recipient identity ("all users" or
 * name/email of the targeted user). Owner-only, server-side.
 */
export async function GET() {
  const { user } = await getCurrentUserAndProfile();
  if (!user)
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const owner = await requirePlatformOwner();
  if (!owner)
    return NextResponse.json(
      { error: "Platform owner access required." },
      { status: 403 },
    );

  const items = await listSentNotifications(owner);
  return NextResponse.json({ items });
}
