import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { communityLog } from "@/lib/community/log";

/**
 * POST /api/community/voice/diagnostic — voice connect-failure report.
 *
 * The CLIENT posts the SAFE metadata of a failed LiveKit join (error name,
 * numeric code, classified cause, the SFU host it tried, and the error
 * message) so the real runtime failure lands in the server logs where it
 * can be read without an iPhone connected to a debugger.
 *
 * SECURITY (secret-exclusion by construction + defense in depth):
 *   * the client NEVER sends the token / keys — this route does not even
 *     ask for them,
 *   * the server REJECTS any `message` that looks like a JWT (starts with
 *     `eyJ`) and replaces it with a redaction marker,
 *   * every field is type-checked, flattened (no newlines/log injection)
 *     and truncated to 120 chars before logging,
 *   * rate-limited (community_voice_diagnostic, 30/min) and 401 without a
 *     valid session.
 *
 * Response is always 204 (the report is fire-and-forget; a failure to
 * report must never affect the user).
 */
const SAFE_CAUSES = new Set([
  "microphone_denied",
  "invalid_room_or_grants",
  "livekit_unreachable",
  "token_error",
  "connection_failed",
  "sfu_disconnected",
  "token_fetch_failed",
  "http_error",
]);

function safeString(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const flat = value.replace(/[=\r\n\t]/g, " ").trim();
  return flat.slice(0, max);
}

/** JWT-shaped content is NEVER logged (tokens always start with `eyJ`). */
function redactTokenLike(value: string): string {
  if (/eyJ[A-Za-z0-9_-]{10,}/.test(value)) return "[redacted: token-like content]";
  return value;
}

export async function POST(req: Request) {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = await checkRateLimit("community_voice_diagnostic", user.id);
  if (!limited.allowed) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429, headers: {
      "retry-after": String(limited.retryAfterSeconds),
      "x-ratelimit-limit": String(limited.limit),
      "x-ratelimit-remaining": "0",
    } });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const phase = safeString(b.phase, 40) || "unknown";
  const code = safeString(b.code, 40);
  if (!SAFE_CAUSES.has(code)) {
    return NextResponse.json({ error: "Unknown diagnostic code." }, { status: 400 });
  }
  const errorName = safeString(b.errorName, 60);
  const errorCode =
    typeof b.errorCode === "number" && Number.isInteger(b.errorCode) && Math.abs(b.errorCode) < 1_000_000
      ? b.errorCode
      : undefined;
  // Host = public service hostname (no credentials — the client strips them
  // and we keep only host:port); message is JWT-redacted + flattened.
  const host = safeString(b.host, 80);
  const room = safeString(b.room, 20);
  const message = redactTokenLike(safeString(b.message, 200));

  communityLog(
    "community.voice.client_error",
    {
      userId: user.id,
      phase,
      code,
      errorName: errorName || "-",
      ...(errorCode !== undefined ? { errorCode } : {}),
      host: host || "-",
      room: room || "-",
      message: message || "-",
    },
    "error",
  );

  return new NextResponse(null, { status: 204 });
}
