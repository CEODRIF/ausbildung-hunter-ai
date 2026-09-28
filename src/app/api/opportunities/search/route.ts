import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import {
  OpportunityProviderError,
  searchOpportunities,
} from "@/lib/opportunities/search";
import { searchParamsSchema } from "@/lib/opportunities/types";

export async function GET(request: Request) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let params;
  try {
    params = searchParamsSchema.parse(
      Object.fromEntries(new URL(request.url).searchParams.entries()),
    );
  } catch {
    return NextResponse.json(
      { error: "Invalid search parameters." },
      { status: 400 },
    );
  }
  try {
    const result = await searchOpportunities(params, { userId: user.id });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof OpportunityProviderError)
      return NextResponse.json({ error: error.message }, { status: 502 });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Search failed." },
      { status: 500 },
    );
  }
}
