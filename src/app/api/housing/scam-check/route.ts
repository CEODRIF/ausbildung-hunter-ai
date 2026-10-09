import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { checkRateLimit, tooManyRequests } from "@/lib/rate-limit";
import { checkScam } from "@/lib/housing/scam-check";
import { scamCheckBodySchema } from "@/lib/housing/schema";

/**
 * POST /api/housing/scam-check — analyze a listing/message for scam indicators.
 *
 * Heuristics always run (offline, deterministic). When `useAi` is set, an AI
 * summary is added on top (best-effort; degrades to heuristic-only). The risk
 * level is ALWAYS heuristic-driven — the AI can never lower or raise it.
 */
export async function POST(request: Request) {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = await checkRateLimit("housing_scam_ai", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  let body;
  try {
    body = scamCheckBodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  try {
    const result = await checkScam(body.text, { useAi: body.useAi });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Analysis failed." },
      { status: 500 },
    );
  }
}
