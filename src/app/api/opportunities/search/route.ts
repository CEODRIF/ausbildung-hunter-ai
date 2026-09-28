import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { searchOpportunities } from "@/lib/opportunities/search";

export async function GET(request: Request) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const params = Object.fromEntries(
    new URL(request.url).searchParams.entries(),
  );
  try {
    return NextResponse.json(await searchOpportunities(params));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Search failed." },
      { status: 400 },
    );
  }
}
