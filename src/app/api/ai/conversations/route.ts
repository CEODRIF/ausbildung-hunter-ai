import { NextResponse } from "next/server";
import {
  createConversation,
  deleteConversation,
  listConversations,
  renameConversation,
} from "@/lib/ai-service";

export async function GET() {
  try {
    return NextResponse.json(await listConversations());
  } catch {
    return NextResponse.json(
      { error: "Unable to load conversations." },
      { status: 401 },
    );
  }
}
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { title?: string };
  try {
    return NextResponse.json(await createConversation(body.title));
  } catch {
    return NextResponse.json(
      { error: "Unable to create conversation." },
      { status: 400 },
    );
  }
}
export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    id?: string;
    title?: string;
  };
  if (!body.id)
    return NextResponse.json(
      { error: "Conversation is required." },
      { status: 400 },
    );
  try {
    await renameConversation(body.id, body.title || "New conversation");
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Unable to rename conversation." },
      { status: 400 },
    );
  }
}
export async function DELETE(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { id?: string };
  if (!body.id)
    return NextResponse.json(
      { error: "Conversation is required." },
      { status: 400 },
    );
  try {
    await deleteConversation(body.id);
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Unable to delete conversation." },
      { status: 400 },
    );
  }
}
