import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { requirePlatformOwner, searchNotificationRecipients } from "@/lib/notifications/admin";
import { searchRecipientsSchema } from "@/lib/notifications/types";

/**
 * POST /api/admin/notifications/search
 *
 * Recipient search for targeted notifications. Owner-only, server-side:
 * every call verifies session → admin membership → owner email. Returns at
 * most 10 minimal identity rows (id/email/full_name) — this is an address
 * picker, not a user-management surface.
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
  const parsed = searchRecipientsSchema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json({ error: "Query must be 2-120 characters." }, { status: 400 });

  const results = await searchNotificationRecipients(parsed.data.query);
  return NextResponse.json({ results });
}
