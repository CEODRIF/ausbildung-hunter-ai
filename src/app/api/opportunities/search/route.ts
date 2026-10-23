import { NextResponse } from "next/server";
import {
  completeFeatureOp,
  releaseFeatureOp,
  reserveFeatureOp,
} from "@/lib/billing/entitlement-service";
import { getCurrentUserAndProfile } from "@/lib/auth";
import {
  BA_SOURCE_ID,
  BaFetchFailure,
  OpportunityProviderError,
  searchOpportunities,
} from "@/lib/opportunities/search";
import {
  normalizeSearchParams,
  parseCitiesParam,
  searchParamsSchema,
} from "@/lib/opportunities/types";
import {
  checkRateLimit,
  rateLimitHeaders,
  tooManyRequests,
} from "@/lib/rate-limit";

export async function GET(request: Request) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Protects the shared upstream BA client id from per-user bursts.
  const limited = await checkRateLimit("opportunity_search", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

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
      // Work place: comma-separated curated cities (validated + deduped by
      // parseCitiesParam; unknown names dropped, never trusted).
      cities: raw.get("cities") ? parseCitiesParam(raw.get("cities")!) : [],
      beginn: raw.get("beginn") ?? "any",
      freshness: raw.get("freshness") ?? "any",
      sort: raw.get("sort") ?? "relevance",
      employment: raw.get("employment") ?? "any",
      training_type: raw.get("training_type") ?? "any",
      home_office: raw.get("home_office") ?? "any",
      match: raw.get("match") ?? "false",
      // Legacy compatibility: old clients send salary=1/0.
      salary:
        raw.get("salary") === "1"
          ? "documented"
          : raw.get("salary") === "0"
            ? "any"
            : raw.get("salary") ?? "any",
      contact_email: raw.get("email") ?? "any",
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

  // Per-day search quota (one operation = one server-side search execution).
  // Reserved AFTER parameter validation (invalid requests cost nothing) and
  // released whenever the execution fails — a failed op never consumes quota.
  const runId = crypto.randomUUID();
  const reserved = await reserveFeatureOp(
    user.id,
    "opportunity_search",
    runId,
  );
  if (reserved.outcome === "quota_exhausted") {
    return NextResponse.json(
      {
        error: "Opportunity search limit reached. It resets daily (UTC).",
        code: "quota_exhausted",
      },
      { status: 429, headers: rateLimitHeaders(limited) },
    );
  }
  if (reserved.outcome === "feature_disabled") {
    return NextResponse.json(
      {
        error: "Opportunity search is not available on your current plan.",
        code: "feature_disabled",
      },
      { status: 403 },
    );
  }
  if (reserved.outcome === "error") {
    return NextResponse.json(
      {
        error: reserved.message ?? "Quota service temporarily unavailable.",
        code: "quota_unavailable",
      },
      { status: 503 },
    );
  }

  try {
    const result = await searchOpportunities(params, { userId: user.id });
    // Success: the reservation becomes a consumed operation.
    await completeFeatureOp(user.id, "opportunity_search", runId);
    return NextResponse.json(result, { headers: rateLimitHeaders(limited) });
  } catch (error) {
    // Failed search executions (upstream 502/500) must not consume quota.
    await releaseFeatureOp(user.id, "opportunity_search", runId).catch(
      () => undefined,
    );
    if (error instanceof BaFetchFailure) {
      // Transient official-source failure AFTER controlled retries: a
      // structured 502 so the client can keep its previous results and offer
      // a no-reload "Erneut versuchen" (only when the failure is retryable).
      return NextResponse.json(
        {
          error: error.message,
          source_status: {
            source: BA_SOURCE_ID,
            status: "temporarily_unavailable",
            retryable: error.retryable,
          },
        },
        { status: 502, headers: rateLimitHeaders(limited) },
      );
    }
    if (error instanceof OpportunityProviderError)
      return NextResponse.json({ error: error.message }, { status: 502 });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Search failed." },
      { status: 500 },
    );
  }
}
