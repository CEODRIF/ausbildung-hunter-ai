import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  VOICE_TOKEN_TTL_SECONDS,
  createLiveKitVoiceToken,
  getLiveKitVoiceConfig,
} from "@/lib/voice/livekit-token";
import { fetchCommunityWriteGate } from "@/lib/community/roles";
import { communityLog } from "@/lib/community/log";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/community/voice/token — Phase 4 voice join (WebRTC/SFU).
 *
 * The ONLY path from the browser to an SFU token. Authorization is fully
 * server-side, in this order:
 *   1. valid session + active account,
 *   2. rate limit (community_voice, 20/min — token spam / join churning),
 *   3. voice configured (else 503 — the UI shows "voice unavailable";
 *      we never fake a working connection),
 *   4. the room exists AND is enabled (RLS on community_rooms),
 *   5. create-or-reuse the room's ACTIVE conversation
 *      (community_voice_join — SECURITY DEFINER; the provider room name is
 *      derived from the authorized room id INSIDE SQL, so a client can never
 *      request an arbitrary SFU room),
 *   6. mint a short-lived (10 min) LiveKit token with the minimal grants
 *      (join that exact room, publish audio, subscribe audio).
 *
 * The response carries NO secrets: the SFU URL is an endpoint, not a
 * credential, and the token is scoped + signed (identity = the caller's
 * verified user id — no impersonation, no arbitrary rooms).
 *
 * Never returns participant data of any kind (outsiders see only the count).
 */
export async function POST(req: Request) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active") {
    communityLog("community.voice.join_denied", { reason: "unauthenticated" }, "warn");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const roomId = (body as { roomId?: unknown })?.roomId;
  // The client may send only a ROOM ID — never a provider room name.
  if (typeof roomId !== "string" || !UUID.test(roomId)) {
    communityLog("community.voice.join_denied", { userId: user.id, reason: "invalid_room" }, "warn");
    return NextResponse.json({ error: "Unknown room." }, { status: 400 });
  }

  communityLog("community.voice.join", { userId: user.id, roomId });

  const limited = await checkRateLimit("community_voice", user.id);
  if (!limited.allowed) {
    communityLog("community.voice.join_denied", { userId: user.id, roomId, reason: "rate_limited" }, "warn");
    return NextResponse.json({ error: "Too many requests." }, { status: 429, headers: {
      "retry-after": String(limited.retryAfterSeconds),
      "x-ratelimit-limit": String(limited.limit),
      "x-ratelimit-remaining": "0",
    } });
  }

  // Phase 5 moderation gate: suspended / timed-out users cannot join voice
  // (a timeout is a chat sanction — voice is chat).
  const gate = await fetchCommunityWriteGate(user.id);
  if (!gate.writable) {
    communityLog("community.voice.join_denied", { userId: user.id, roomId, reason: gate.code }, "warn");
    return NextResponse.json({ error: gate.code }, { status: 403 });
  }

  const config = getLiveKitVoiceConfig();
  if (config.kind !== "configured") {
    communityLog("community.voice.join_denied", { userId: user.id, roomId, reason: "voice_unavailable" }, "warn");
    return NextResponse.json({ error: "voice_unavailable" }, { status: 503 });
  }

  const supabase = await createClient();

  const { data: room, error: roomError } = await supabase
    .from("community_rooms")
    .select("id")
    .eq("id", roomId)
    .maybeSingle();
  if (roomError || !room) {
    communityLog("community.voice.join_denied", { userId: user.id, roomId, reason: "room_not_found" }, "warn");
    return NextResponse.json({ error: "Unknown room." }, { status: 404 });
  }

  const { data: conversation, error: convError } = await supabase.rpc("community_voice_join", {
    p_room: roomId,
  });
  if (convError || !conversation) {
    communityLog(
      "community.voice.join_denied",
      { userId: user.id, roomId, reason: "join_failed", detail: convError?.message ?? "no_conversation" },
      "error",
    );
    return NextResponse.json(
      { error: "Could not start the voice conversation." },
      { status: 500 },
    );
  }
  const conv = conversation as {
    provider_room_name: string;
    participant_count: number;
  };

  // The caller's own (already community-public) display name + avatar are
  // signed into the token so the participant list can render them.
  const { data: me } = await supabase
    .from("community_profiles")
    .select("display_name,avatar_id")
    .eq("user_id", user.id)
    .maybeSingle();
  const name =
    me && typeof me.display_name === "string" && me.display_name.trim()
      ? me.display_name.trim()
      : "Member";

  const token = createLiveKitVoiceToken({
    apiKey: config.apiKey as string,
    apiSecret: config.apiSecret as string,
    identity: user.id, // server-derived — the browser cannot spoof who joins
    room: conv.provider_room_name,
    name,
    avatarId: me && typeof me.avatar_id === "string" ? me.avatar_id : null,
  });

  // Phase 6C (C-3): token issued — metadata only, NEVER the token itself.
  // Plus safe config diagnostics (production voice incident): scheme + HOST
  // of the configured LiveKit URL (host is a public service name, never a
  // secret), the API key LENGTH (catches empty/truncated keys without
  // leaking the key), and the exact grant set the token carries. The probe
  // below checks DNS+TLS+HTTP reachability of the SFU host — non-destructive
  // and fire-and-forget, so join latency is not affected.
  const lkUrl = safeUrlMeta(config.url ?? "");
  communityLog("community.voice.token_issued", {
    userId: user.id,
    roomId,
    room: conv.provider_room_name,
    participantCount: conv.participant_count,
    ttlSeconds: VOICE_TOKEN_TTL_SECONDS,
    urlScheme: lkUrl.scheme,
    urlHost: lkUrl.host,
    apiKeyLen: config.apiKey?.length ?? 0,
    roomCreate: true,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
  });
  void probeLiveKitReachable(config.url ?? "").then((result) => {
    communityLog(
      "community.voice.sfu_probe",
      { userId: user.id, host: lkUrl.host, result },
      result.startsWith("fail") || result === "timeout_4s" ? "error" : "warn",
    );
  });

  return NextResponse.json(
    {
      provider: "livekit",
      url: config.url,
      room: conv.provider_room_name,
      token,
      participantCount: conv.participant_count,
      expiresInSeconds: VOICE_TOKEN_TTL_SECONDS,
    },
    {
      headers: {
        "x-ratelimit-limit": String(limited.limit),
        "x-ratelimit-remaining": String(limited.limit - Math.max(limited.count, 1)),
      },
    },
  );
}

/**
 * { scheme, host } of a LiveKit URL — everything except protocol +
 * hostname:port is dropped (no path, no credentials). Host is a public
 * service name, not a secret; safe to log.
 */
function safeUrlMeta(url: string): { scheme: string; host: string } {
  try {
    const u = new URL(url);
    return { scheme: u.protocol.replace(/:$/, ""), host: u.host || "(empty)" };
  } catch {
    return { scheme: "invalid", host: "(unparseable)" };
  }
}

/**
 * Non-destructive reachability probe of the SFU host: a plain GET against the
 * HTTP(S) form of the LiveKit URL (LiveKit answers 404 for non-signal paths).
 * Proves DNS + TLS + HTTP reachability from the server environment. Never
 * creates/touches rooms or auth. Resolves to a short status token, never a
 * stack trace.
 */
async function probeLiveKitReachable(url: string): Promise<string> {
  try {
    const u = new URL(url);
    const https = u.protocol === "wss:" || u.protocol === "https:";
    const httpUrl = `${https ? "https" : "http"}://${u.host}${u.pathname}${u.search}`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await fetch(httpUrl, { method: "GET", signal: controller.signal });
      return `http_${res.status}`;
    } finally {
      clearTimeout(t);
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return "timeout_4s";
    const cause = (error as { cause?: { code?: string } } | null)?.cause?.code;
    if (cause) return `fail_${cause}`; // e.g. fail_ENOTFOUND (DNS), fail_ECONNREFUSED, fail_CERT_* (TLS)
    return "fail";
  }
}
