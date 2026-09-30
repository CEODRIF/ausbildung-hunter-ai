import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { listUserNotifications } from "@/lib/notifications/user";

/**
 * GET /api/notifications
 *
 * The signed-in user's in-app notifications (global + targeted at them,
 * newest first, ≤ 20) with per-user read state. Nothing beyond what the
 * notification itself contains is returned.
 */
export async function GET() {
  const { user } = await getCurrentUserAndProfile();
  if (!user)
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const items = await listUserNotifications(user.id);
  return NextResponse.json({ items });
}
