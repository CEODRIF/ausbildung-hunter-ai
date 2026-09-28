import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { deleteUserAccount } from "@/lib/account-data";
import { checkRateLimit, tooManyRequests } from "@/lib/rate-limit";

const deleteSchema = z
  .object({
    /** Must match the account email exactly (case-insensitive). */
    confirmEmail: z.string().trim().email().max(320),
  })
  .strict();

/** GDPR erasure. Session-verified actor + typed email confirmation.
 *  Strict schema: any extra field (user_id, etc.) is rejected. */
export async function POST(request: Request): Promise<NextResponse> {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = await checkRateLimit("account_delete", user.id);
  if (!limited.allowed) return tooManyRequests(limited);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid confirmation" },
      { status: 400 },
    );
  }
  if (
    parsed.data.confirmEmail.toLowerCase() !==
    String(profile.email ?? "").toLowerCase()
  ) {
    return NextResponse.json(
      { error: "Email does not match this account" },
      { status: 400 },
    );
  }
  try {
    const result = await deleteUserAccount(user.id);
    return NextResponse.json({
      ok: true,
      storageSwept: result.storageSwept,
    });
  } catch {
    return NextResponse.json(
      { error: "Deletion failed — your account is unchanged, please retry." },
      { status: 500 },
    );
  }
}
