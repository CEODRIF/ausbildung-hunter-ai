import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { requirePlatformOwner, sendNotification } from "@/lib/notifications/admin";

/**
 * POST /api/admin/notifications/send
 *
 * Create a global (all users) or targeted (one user) in-app notification.
 * Owner-only, server-side authorization on every call. In-app only — this
 * endpoint never sends email/SMS/push.
 *
 * Idempotency: the client sends an `idempotency_key` (UUID, one per form
 * open). A duplicate submit with the same key returns 200 { duplicate:
 * true } and the ORIGINAL notification — the unique `send_key` constraint
 * guarantees no duplicate row is ever created.
 */
export async function POST(request: Request) {
  const { user } = await getCurrentUserAndProfile();
  if (!user)
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const owner = await requirePlatformOwner();
  if (!owner)
    return NextResponse.json(
      { error: "Platform owner access required." },
      { status: 403 },
    );

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const result = await sendNotification(owner, body);
  if (!result.ok) {
    if (result.reason === "invalid_input")
      return NextResponse.json({ error: "Invalid notification payload." }, { status: 400 });
    if (result.reason === "target_not_found")
      return NextResponse.json(
        { error: "The selected user no longer exists." },
        { status: 409 },
      );
    return NextResponse.json(
      { error: "Could not store the notification. Please try again." },
      { status: 500 },
    );
  }

  const { notification, duplicate } = result.result;
  return NextResponse.json(
    { notification, duplicate },
    { status: duplicate ? 200 : 201 },
  );
}
