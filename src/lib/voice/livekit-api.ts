/**
 * Community Phase 6B — LiveKit SERVER API client (SERVER ONLY).
 *
 * Closes S-4: suspension used to block NEW voice joins only — an already
 * connected suspended user kept the live SFU session. This module lets the
 * server (the `suspend_user` moderation action) remove that participant from
 * LiveKit via the RoomService API.
 *
 * Contract (verified against the LiveKit server SDK / Server API docs):
 *   * Twirp JSON over HTTP: POST {http(s) base}/twirp/livekit.RoomService/{Method}
 *   * Authorization: Bearer <short-lived admin JWT (HS256, signed with the
 *     LIVEKIT_API_SECRET)> — the same key/secret the join-token route already
 *     uses; the secret never leaves this module and never reaches a browser.
 *   * Minimal per-call grants (mirrors the official SDK's authHeader):
 *       ListRooms         → { roomList: true }
 *       ListParticipants  → { roomAdmin: true, room }
 *       RemoveParticipant → { roomAdmin: true, room }
 *     No identity/sub is set on these service tokens.
 *
 * HONEST RESULT STATES (never fakes success):
 *   * `not_configured`  — LIVEKIT_* env vars missing → no-op (voice is OFF).
 *   * `not_in_any_room` — API reachable, the user holds no active session.
 *   * `evicted`         — every located session was removed.
 *   * `unavailable`     — the SFU could not be reached / refused / partially
 *                         failed → explicit detail, NO success claim.
 *
 * Best-effort by contract: this function NEVER throws and every request has
 * its own timeout — an SFU outage must never block or fail the moderation
 * sanction itself.
 */
import "server-only";

import { createHmac, randomBytes } from "node:crypto";
import { getLiveKitVoiceConfig } from "./livekit-token";

/** Per-request timeout: the moderation path must not stall on a dead SFU. */
export const LIVEKIT_API_TIMEOUT_MS = 5_000;
/** Admin token TTL — service calls only (the SDK default is 10 minutes). */
export const LIVEKIT_ADMIN_TOKEN_TTL_SECONDS = 600;
/**
 * Hard cap on candidate SFU rooms scanned per eviction. A dedicated cluster
 * serves one active voice conversation per community room at most; 50 is far
 * above any realistic concurrency and bounds worst-case request count.
 */
export const LIVEKIT_MAX_CANDIDATE_ROOMS = 50;

/** Provider room namespace: `community_voice_join` derives `croom-<room id>`. */
export const LIVEKIT_ROOM_PREFIX = "croom-";

export type LiveKitEvictionResult =
  | { status: "not_configured" }
  | { status: "unavailable"; detail: string }
  | { status: "not_in_any_room" }
  | { status: "evicted"; rooms: string[] };

/** The `video` grant claim of a server-side admin token. */
interface VideoGrant {
  roomList?: boolean;
  roomAdmin?: boolean;
  room?: string;
}

const b64url = (input: Buffer | string): string =>
  Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/**
 * Mint a short-lived LiveKit Server API token (HS256 JWT signed with the API
 * secret). Mirrors the official SDK's per-call `authHeader` construction:
 * `{ iss, nbf, exp, jti, video: <grant> }` — no `sub` (service call), no
 * roomJoin, no participant metadata.
 */
export function createLiveKitAdminToken(
  apiKey: string,
  apiSecret: string,
  video: VideoGrant,
  ttlSeconds: number = LIVEKIT_ADMIN_TOKEN_TTL_SECONDS,
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const claims = {
    iss: apiKey,
    nbf: now,
    exp: now + ttlSeconds,
    jti: b64url(randomBytes(16)),
    video,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = b64url(createHmac("sha256", apiSecret).update(signingInput).digest());
  return `${signingInput}.${signature}`;
}

/**
 * Convert the configured (ws[s]://) SFU URL to the HTTP(S) API base the
 * Twirp endpoints live on (the official SDK does the same ws→http rewrite).
 */
export function liveKitApiBase(wsUrl: string): string {
  return wsUrl
    .trim()
    .replace(/^wss:/i, "https:")
    .replace(/^ws:/i, "http:")
    .replace(/\/+$/, "");
}

type RoomServiceMethod = "ListRooms" | "ListParticipants" | "RemoveParticipant";

/**
 * One Twirp JSON request against the RoomService. Throws on transport
 * failure, timeout, or a non-2xx response (with the Twirp error message).
 */
async function roomServiceRequest(
  url: string,
  apiKey: string,
  apiSecret: string,
  method: RoomServiceMethod,
  body: Record<string, unknown>,
  video: VideoGrant,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${liveKitApiBase(url)}/twirp/livekit.RoomService/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json;charset=UTF-8",
      authorization: `Bearer ${createLiveKitAdminToken(apiKey, apiSecret, video)}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(LIVEKIT_API_TIMEOUT_MS),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const parsed = (await res.json()) as { msg?: unknown };
      if (typeof parsed.msg === "string" && parsed.msg.length > 0) detail = parsed.msg;
    } catch {
      /* non-JSON error body — keep the HTTP status detail */
    }
    throw new Error(detail);
  }
  return (await res.json()) as Record<string, unknown>;
}

/** Extract a field that the server may emit as snake_case OR camelCase. */
function field(row: Record<string, unknown>, snake: string, camel: string): unknown {
  return row[snake] ?? row[camel];
}

/**
 * Remove a user's active LiveKit session(s) — the B-2 eviction seam.
 *
 * Flow (authoritative source of "who is connected" is the SFU itself, never
 * the app-side count shadow):
 *   1. ListRooms → keep `croom-*` rooms (this app's provider namespace) with
 *      participants, capped at LIVEKIT_MAX_CANDIDATE_ROOMS;
 *   2. ListParticipants per candidate → collect rooms where `identity`
 *      (the SUSPENDED user's verified id — supplied by the server-side
 *      sanction, never by a client) is present;
 *   3. RemoveParticipant in each located room (best-effort per room).
 *
 * On LiveKit Cloud, RemoveParticipant also revokes the participant's token
 * (they cannot reconnect with a cached token). On self-hosted deployments,
 * a cached unexpired join token (10-min TTL) could reconnect once — the
 * token route's write gate rejects every NEW token for the suspended user,
 * so the exposure is bounded by the token TTL.
 */
export async function evictLiveKitParticipant(identity: string): Promise<LiveKitEvictionResult> {
  const config = getLiveKitVoiceConfig();
  if (config.kind !== "configured") return { status: "not_configured" };
  // `kind === "configured"` guarantees all three values are present.
  const url = config.url as string;
  const apiKey = config.apiKey as string;
  const apiSecret = config.apiSecret as string;

  try {
    const roomsRes = await roomServiceRequest(url, apiKey, apiSecret, "ListRooms", {}, {
      roomList: true,
    });
    const allRooms = Array.isArray(roomsRes.rooms) ? (roomsRes.rooms as Array<Record<string, unknown>>) : [];
    const candidates = allRooms
      .filter((room) => typeof room.name === "string" && room.name.startsWith(LIVEKIT_ROOM_PREFIX))
      .filter((room) => {
        const count = field(room, "num_participants", "numParticipants");
        // Unknown count → still scan (an eviction miss is worse than a call).
        return typeof count !== "number" || count > 0;
      })
      .slice(0, LIVEKIT_MAX_CANDIDATE_ROOMS);

    const presentIn: string[] = [];
    for (const room of candidates) {
      const roomName = room.name as string;
      const partsRes = await roomServiceRequest(
        url,
        apiKey,
        apiSecret,
        "ListParticipants",
        { room: roomName },
        { roomAdmin: true, room: roomName },
      );
      const list = partsRes.participants;
      const found =
        Array.isArray(list) &&
        (list as Array<Record<string, unknown>>).some((p) => p.identity === identity);
      if (found) presentIn.push(roomName);
    }
    if (presentIn.length === 0) return { status: "not_in_any_room" };

    const removed: string[] = [];
    const failures: string[] = [];
    for (const roomName of presentIn) {
      try {
        await roomServiceRequest(
          url,
          apiKey,
          apiSecret,
          "RemoveParticipant",
          { room: roomName, identity },
          { roomAdmin: true, room: roomName },
        );
        removed.push(roomName);
      } catch (error) {
        failures.push(`${roomName}: ${error instanceof Error ? error.message : "error"}`);
      }
    }
    if (failures.length > 0) {
      return {
        status: "unavailable",
        detail: `removed=[${removed.join(", ") || "-"}] failed=[${failures.join("; ")}]`,
      };
    }
    return { status: "evicted", rooms: removed };
  } catch (error) {
    return {
      status: "unavailable",
      detail: error instanceof Error ? error.message : "error",
    };
  }
}
