import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUserAndProfile } from "@/lib/auth";
import {
  OpportunityNotFoundError,
  OpportunityProviderError,
  listSavedOpportunities,
  removeSavedOpportunity,
  saveOpportunityFromKey,
  updateSavedOpportunityNotes,
} from "@/lib/opportunities/saved";

/**
 * Save contract: the client submits only the opportunity key (and optional
 * notes). All opportunity data is re-derived server-side from the source.
 * Extra fields sent by the client are stripped by the schema — company,
 * title, URL, salary, match score etc. are never trusted.
 */
const saveBodySchema = z
  .object({
    opportunityKey: z.string().min(3).max(200),
    notes: z.string().trim().max(500).nullish(),
  })
  .strict();

const notesBodySchema = z
  .object({
    opportunityKey: z.string().min(3).max(200),
    notes: z.string().trim().max(500),
  })
  .strict();

function errorResponse(error: unknown) {
  if (error instanceof OpportunityNotFoundError)
    return NextResponse.json({ error: error.message }, { status: 404 });
  if (error instanceof OpportunityProviderError)
    return NextResponse.json({ error: error.message }, { status: 502 });
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "Request failed." },
    { status: 500 },
  );
}

export async function GET() {
  const { user } = await getCurrentUserAndProfile();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const saved = await listSavedOpportunities(user.id);
    return NextResponse.json({ saved });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const { user } = await getCurrentUserAndProfile();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body;
  try {
    body = saveBodySchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: "Invalid save request." },
      { status: 400 },
    );
  }
  try {
    const saved = await saveOpportunityFromKey(
      user.id,
      body.opportunityKey,
      body.notes ?? undefined,
    );
    return NextResponse.json({ saved });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  const { user } = await getCurrentUserAndProfile();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body;
  try {
    body = notesBodySchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: "Invalid notes request." },
      { status: 400 },
    );
  }
  try {
    await updateSavedOpportunityNotes(user.id, body.opportunityKey, body.notes);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  const { user } = await getCurrentUserAndProfile();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body;
  try {
    body = z
      .object({ opportunityKey: z.string().min(3).max(200) })
      .strict()
      .parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    await removeSavedOpportunity(user.id, body.opportunityKey);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
