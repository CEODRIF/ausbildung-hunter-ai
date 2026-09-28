import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/billing/admin";
import { listAdminUsers } from "@/lib/billing/admin-users";
import { checkRateLimit, tooManyRequests } from "@/lib/rate-limit";

export async function GET(request: Request): Promise<NextResponse> {
  const adminUser = await requireAdmin();
  if (!adminUser)
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  const limited = await checkRateLimit("admin_actions", adminUser.id);
  if (!limited.allowed) return tooManyRequests(limited);

  const query = new URL(request.url).searchParams;
  const filterSchema = z
    .object({ email: z.string().trim().min(3).max(200).optional() })
    .strict();
  const parsed = filterSchema.safeParse({
    email: query.get("email") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid filter" }, { status: 400 });
  }
  const users = await listAdminUsers(parsed.data.email);
  return NextResponse.json({ users });
}
