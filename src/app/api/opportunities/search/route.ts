import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import {
  OpportunityProviderError,
  searchOpportunities,
} from "@/lib/opportunities/search";
import {
  normalizeSearchParams,
  searchParamsSchema,
} from "@/lib/opportunities/types";

export async function GET(request: Request) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const raw = new URL(request.url).searchParams;
  let params;
  try {
    // `q` is the shareable URL alias for keyword; the API also accepts
    // `keyword` directly.
    const keyword = raw.get("q") ?? raw.get("keyword") ?? "";
    const candidate: Record<string, unknown> = {
      goal: raw.get("goal"),
      keyword,
      role: raw.get("role") ?? "",
      company: raw.get("company") ?? "",
      location: raw.get("location") ?? "",
      freshness: raw.get("freshness") ?? "any",
      sort: raw.get("sort") ?? "relevance",
      employment: raw.get("employment") ?? "any",
      training_type: raw.get("training_type") ?? "any",
      home_office: raw.get("home_office") ?? "any",
      match: raw.get("match") ?? "false",
      salary_documented: raw.get("salary") === "1",
    };
    if (raw.get("radius")) candidate.radius = raw.get("radius");
    if (raw.get("distance_max"))
      candidate.distance_max = raw.get("distance_max");
    if (raw.get("page")) candidate.page = raw.get("page");
    if (raw.get("pageSize")) candidate.pageSize = raw.get("pageSize");
    params = searchParamsSchema.parse(candidate);
    params = normalizeSearchParams(params);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Invalid search parameters.",
      },
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
