import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUserAndProfile } from "@/lib/auth";
import {
  createConversation,
  deleteConversation,
  listConversations,
  renameConversation,
} from "@/lib/ai-service";

/**
 * Explicit session gate for every handler.
 *
 * The service functions check the session themselves, but they THROW, and the
 * catch blocks below answer 400 — so an unauthenticated request used to be
 * reported as a bad request instead of 401 (wrong status, and it hid the real
 * failure from the client). Ownership of the addressed conversation is still
 * enforced inside the service (every statement is scoped to the session user).
 */
async function isUnauthenticated(): Promise<boolean> {
  const { user, profile } = await getCurrentUserAndProfile();
  return !user || !profile || profile.account_status !== "active";
}

const unauthorized = () =>
  NextResponse.json({ error: "Unauthorized" }, { status: 401 });

const createBodySchema = z
  .object({ title: z.string().trim().min(1).max(200).optional() })
  .strict();

const renameBodySchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
  })
  .strict();

const deleteBodySchema = z.object({ id: z.string().uuid() }).strict();

export async function GET() {
  if (await isUnauthenticated()) return unauthorized();
  try {
    return NextResponse.json(await listConversations());
  } catch {
    return NextResponse.json(
      { error: "Unable to load conversations." },
      { status: 400 },
    );
  }
}

export async function POST(request: Request) {
  if (await isUnauthenticated()) return unauthorized();
  const parsed = createBodySchema.safeParse(
    await request.json().catch(() => ({})),
  );
  if (!parsed.success)
    return NextResponse.json({ error: "Invalid title." }, { status: 400 });
  try {
    return NextResponse.json(await createConversation(parsed.data.title));
  } catch {
    return NextResponse.json(
      { error: "Unable to create conversation." },
      { status: 400 },
    );
  }
}

export async function PATCH(request: Request) {
  if (await isUnauthenticated()) return unauthorized();
  const parsed = renameBodySchema.safeParse(
    await request.json().catch(() => ({})),
  );
  if (!parsed.success)
    return NextResponse.json(
      { error: "Conversation is required." },
      { status: 400 },
    );
  try {
    await renameConversation(parsed.data.id, parsed.data.title);
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Unable to rename conversation." },
      { status: 400 },
    );
  }
}

export async function DELETE(request: Request) {
  if (await isUnauthenticated()) return unauthorized();
  const parsed = deleteBodySchema.safeParse(
    await request.json().catch(() => ({})),
  );
  if (!parsed.success)
    return NextResponse.json(
      { error: "Conversation is required." },
      { status: 400 },
    );
  try {
    await deleteConversation(parsed.data.id);
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Unable to delete conversation." },
      { status: 400 },
    );
  }
}
