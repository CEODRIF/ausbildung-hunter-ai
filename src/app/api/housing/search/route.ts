import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { checkRateLimit, rateLimitHeaders, tooManyRequests } from "@/lib/rate-limit";
import { searchHousing } from "@/lib/housing/providers";
import { housingSearchSchema } from "@/lib/housing/schema";

/**
 * POST /api/housing/search — run a housing search.
 *
 * In the MVP this serves clearly-labeled DEMO fixtures (data_status="demo");
 * licensed live providers would plug in through the provider-adapter layer and
 * require no change to this route.
 */
export async function POST(request: Request) {
  const { user } = await getCurrentUserAndProfile();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = await checkRateLimit("housing_search", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  let body;
  try {
    body = housingSearchSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid search request." }, { status: 400 });
  }

  try {
    const result = await searchHousing(body, {
      pagination: { limit: body.limit, offset: body.offset },
    });
    return NextResponse.json(result, { headers: rateLimitHeaders(limited) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Search failed." },
      { status: 500 },
    );
  }
}
