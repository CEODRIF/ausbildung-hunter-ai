import { NextResponse } from "next/server";
import {
  saveOpportunity,
  removeSavedOpportunity,
} from "@/lib/opportunities/search";
import { opportunitySchema } from "@/lib/opportunities/types";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      opportunity?: unknown;
      notes?: string;
    };
    const opportunity = opportunitySchema.parse(body.opportunity);
    await saveOpportunity({ opportunity, notes: body.notes });
    return NextResponse.json({ saved: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to save." },
      { status: 400 },
    );
  }
}
export async function DELETE(request: Request) {
  try {
    const body = (await request.json()) as { opportunityKey?: string };
    if (!body.opportunityKey) throw new Error("Opportunity key required.");
    await removeSavedOpportunity(body.opportunityKey);
    return NextResponse.json({ saved: false });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to remove." },
      { status: 400 },
    );
  }
}
