import "server-only";
import { NextResponse } from "next/server";
import {
  buildDeckblattPrompt,
  DECKBLATT_STYLES,
  selectDeckblattStyle,
  type DeckblattStyleId,
} from "@/lib/deckblatt/styles";
import {
  PollinationsError,
  buildDeckblattBaseImage,
  generateDeckblattDesign,
} from "@/lib/deckblatt/pollinations";
import {
  completeDeckblattGeneration,
  releaseDeckblattGeneration,
  reserveDeckblattGeneration,
} from "@/lib/deckblatt/usage";
import {
  parseDeckblattForm,
  validateDeckblattForm,
  validateDeckblattPhotoDataUrl,
  type DeckblattFieldErrors,
} from "@/lib/deckblatt/validate";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { checkRateLimit, rateLimitHeaders, tooManyRequests } from "@/lib/rate-limit";
import { DECKBLATT_COMING_SOON } from "@/lib/deckblatt/availability";

export const runtime = "nodejs";
/**
 * MUST be a literal: Next.js only accepts a statically analyzable value for a
 * route segment config (deriving it from the provider budget made the build fail
 * with "Invalid segment configuration export detected").
 *
 * 259 s = the provider module's 244 s budget (2 × 120 s attempt + 4 s backoff)
 * plus ~15 s of route overhead. The relationship is enforced by
 * tests/deckblatt-provider-recovery.test.ts, so the two cannot drift: a retry
 * the function cannot finish is worse than no retry — the platform kills the
 * request mid-flight, the catch block never runs and the reservation used to be
 * lost.
 *
 * The platform clamps this to the plan's limit (Vercel Hobby: 60 s). When that
 * happens the generation fails, but the quota is recovered (see
 * expire_stale_deckblatt_runs) instead of being silently consumed.
 */
export const maxDuration = 259;

/**
 * POST /api/deckblatt/generate
 *
 * Flow: auth → burst rate limit → validate (form + photo payload) →
 * QUOTA RESERVE (atomic, idempotent per run_id) → prompt build
 * (profession + style only) → Pollinations openai/gpt-image-2 via
 * /v1/images/edits (server-side key, deterministic NEUTRAL base image as
 * the model's image input) → COMPLETE / RELEASE (refund on failure) →
 * respond.
 *
 * The browser never talks to Pollinations directly, and the response
 * contains only the generated background (base64), the style id and the
 * fresh quota state — never the API key, never the raw prompt. The
 * applicant's photo never leaves the browser + this API: it is validated
 * here (contract) and then composited locally by the client renderer —
 * the model receives only an abstract style base, so a generated person
 * is structurally impossible. Name, email, phone and address never
 * leave the browser at all.
 *
 * Response contract (the client maps `code` → translated message):
 *  200 { runId, styleId, design, usage }
 *  400 { code: "validation" | "invalid_request" | "invalid_run_id", fields?, photo? }
 *  401 { code: "unauthorized" }
 *  403 { code: "quota_exhausted", usage }
 *  409 { code: "already_running", usage }
 *  429 { code: "rate_limited" }
 *  502 { code: "provider_error" | "provider_rate_limited" | "provider_unauthorized" | "provider_content_blocked" }
 *  503 { code: "coming_soon" }        ← feature parked (DECKBLATT_COMING_SOON)
 *  503 { code: "usage_unavailable" }
 */

/** Client-generated idempotency key (one UUID per click/retry). */
const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Logging discipline: this route handles personal data (name, email, phone,
 * address). The ONLY things that may appear in a log line are the session
 * user id (already the convention across this codebase) and error CODES —
 * never field values, never the provider key, never the prompt.
 */
function logFailure(
  userId: string,
  tag: string,
  detail: {
    httpStatus?: number;
    providerCode?: string;
    providerMessage?: string;
    requestId?: string;
    quotaRefunded?: boolean;
  } = {},
) {
  // One structured line: which provider, which operation, what the provider
  // actually answered, and whether the quota was given back. The provider
  // message is already redacted at the source; the user id is the existing
  // convention across this codebase.
  console.error(
    `[deckblatt] generation failed user=${userId} tag=${tag}` +
      " provider=pollinations operation=images.edits endpoint=gen.pollinations.ai" +
      ` http_status=${detail.httpStatus ?? "n/a"}` +
      ` provider_code=${detail.providerCode ?? "n/a"}` +
      ` provider_message=${detail.providerMessage ?? "n/a"}` +
      ` request_id=${detail.requestId ?? "n/a"}` +
      ` quota_refunded=${detail.quotaRefunded ?? "n/a"}`,
  );
}

function json(body: Record<string, unknown>, init?: ResponseInit): NextResponse {
  return NextResponse.json(body, init);
}

export async function POST(request: Request) {
  // 1. Auth — the layout already guards the PAGE; the route re-guards
  //    itself so the API cannot be reached with a stale/expired session.
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active") {
    return json({ code: "unauthorized" }, { status: 401 });
  }

  // 1b. Availability. The server-side half of the same switch the page uses: a
  //     replayed or hand-made request cannot start a run while the generator is
  //     parked. Nothing below is reached, so no quota is reserved, no rate-limit
  //     budget is spent and the provider is never called. Auth still runs first,
  //     so the route's authorization behaviour is unchanged.
  if (DECKBLATT_COMING_SOON) {
    return json({ code: "coming_soon" }, { status: 503 });
  }

  // 2. Burst protection (the 2/day quota is enforced atomically in the DB
  //    below — this only stops request spam against a slow provider).
  const limited = await checkRateLimit("deckblatt_generate", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  // 3. Validate the untrusted body (same rules as the client, re-applied).
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ code: "invalid_request" }, { status: 400 });
  }
  const form = parseDeckblattForm(body);
  const fieldErrors: DeckblattFieldErrors = validateDeckblattForm(form);
  if (Object.keys(fieldErrors).length > 0) {
    return json({ code: "validation", fields: fieldErrors }, { status: 400 });
  }

  const rawBody = body as Record<string, unknown>;
  const runId =
    typeof rawBody.runId === "string" && RUN_ID_RE.test(rawBody.runId) ? rawBody.runId : null;
  if (!runId) return json({ code: "invalid_run_id" }, { status: 400 });

  // Style: the client may request a specific variation; anything else
  // (absent/unknown) falls back to the deterministic profession selection.
  const styleId: DeckblattStyleId =
    typeof rawBody.styleId === "string" && rawBody.styleId in DECKBLATT_STYLES
      ? (rawBody.styleId as DeckblattStyleId)
      : selectDeckblattStyle(form.profession).id;
  const style = DECKBLATT_STYLES[styleId];

  // 3b. Photo payload — validated here (API contract unchanged), then used
  //     ONLY for the local client-side composite afterwards. The portrait
  //     is deliberately NOT forwarded to the provider: the model edits a
  //     neutral style base instead, so it can never draw/duplicate/alter
  //     the applicant. Strict shape + size bounds keep the JSON body
  //     predictable; the client already downscales.
  const photo = typeof rawBody.photo === "string" ? rawBody.photo : "";
  const photoError = validateDeckblattPhotoDataUrl(photo);
  if (photoError) {
    return json({ code: "validation", photo: photoError }, { status: 400 });
  }

  // 4. QUOTA — reserve ONE design atomically BEFORE any provider call.
  //    Idempotent per run_id: a retried request (same run_id) can never be
  //    charged twice; concurrent tabs race on the DB row (FOR UPDATE +
  //    conditional upsert), so the limit can never be exceeded.
  const reservation = await reserveDeckblattGeneration(runId);
  if (!reservation) {
    return json({ code: "usage_unavailable" }, { status: 503 });
  }
  if (reservation.status === "already_reserved") {
    return json(
      {
        code: "already_running",
        usage: { used: reservation.used, remaining: reservation.remaining },
      },
      { status: 409 },
    );
  }
  if (reservation.status === "quota_exhausted") {
    return json(
      {
        code: "quota_exhausted",
        usage: { used: reservation.used, remaining: reservation.remaining },
      },
      { status: 403 },
    );
  }

  // 4b. Safety net for the case the catch block never runs: if the client goes
  //     away mid-generation (navigation, retry, closed tab) the reserved quota
  //     is given back immediately instead of waiting for the stale-reservation
  //     recovery. Refund exactly once.
  let refunded = false;
  const releaseOnce = async () => {
    if (refunded) return false;
    refunded = true;
    try {
      return await releaseDeckblattGeneration(runId);
    } catch {
      logFailure(user.id, "release_rpc");
      return false;
    }
  };
  const onAbort = () => {
    void releaseOnce();
  };
  request.signal?.addEventListener?.("abort", onAbort, { once: true });

  // 5. Provider — GPT Image 2 via /v1/images/edits. The prompt contains
  //    the style direction + profession context + reserved zones only;
  //    the model's image input is a deterministic NEUTRAL base image in
  //    the style's palette (never the applicant's photo). Name, email,
  //    phone and address NEVER enter the request at all.
  const prompt = buildDeckblattPrompt(style, form.profession);
  try {
    const designBase64 = await generateDeckblattDesign(prompt, buildDeckblattBaseImage(style));
    // The design exists: an abort from here on must not refund it.
    request.signal?.removeEventListener?.("abort", onAbort);

    // 6. Ledger — mark the run succeeded (best effort: the design is
    //    already generated; a ledger hiccup must not fail the response).
    try {
      await completeDeckblattGeneration(runId);
    } catch {
      logFailure(user.id, "complete_rpc");
    }

    return json(
      {
        runId,
        styleId: style.id,
        design: `data:image/png;base64,${designBase64}`,
        usage: { used: reservation.used, remaining: reservation.remaining },
      },
      { headers: rateLimitHeaders(limited) },
    );
  } catch (error) {
    // FAILED generation → refund the reserved quota (idempotent; only runs
    // still in 'reserved' are refunded, so a slow-but-successful first
    // attempt can never be double-refunded by a late retry).
    const quotaRefunded = await releaseOnce();
    // The browser is told whether the generation was really given back — the
    // UI must not claim "quota was not used" when the refund did not happen.
    const usage = { used: reservation.used, remaining: reservation.remaining };

    if (error instanceof PollinationsError) {
      const detail = {
        httpStatus: error.httpStatus,
        providerCode: error.providerCode,
        providerMessage: error.providerMessage,
        requestId: error.requestId,
        quotaRefunded,
      };
      logFailure(user.id, error.code, detail);
      const code =
        error.code === "provider_rate_limited"
          ? "provider_rate_limited"
          : error.code === "provider_unauthorized"
            ? "provider_unauthorized"
            : error.code === "provider_content_blocked"
              ? "provider_content_blocked"
              : error.code === "provider_timeout"
                ? "provider_timeout"
                : error.code === "provider_bad_request"
                  ? "provider_rejected"
                  : "provider_error";
      return json({ code, quotaRefunded, usage }, { status: 502 });
    }
    logFailure(user.id, "unexpected", { quotaRefunded });
    return json(
      { code: "provider_error", quotaRefunded, usage },
      { status: 502 },
    );
  }
}
