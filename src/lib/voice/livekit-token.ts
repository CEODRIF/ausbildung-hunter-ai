/**
 * Community Phase 4 — LiveKit access-token builder (SERVER ONLY),
 * claim layout fixed in Phase 6D (D-5) to the current LiveKit token
 * contract (verified against the LiveKit server SDK source + docs):
 *   * video grants under the `video` claim — room / roomJoin /
 *     canPublish / canSubscribe: the deliberately minimal grant set
 *     (join ONE server-derived room, publish audio, subscribe audio;
 *     NO roomAdmin, NO roomList, no roomCreate/roomRecord, no SIP),
 *   * participant display name in the top-level `name` claim
 *     (surfaced to the UI as Participant.name),
 *   * custom participant data as the top-level `metadata` STRING —
 *     JSON `{ avatarId }`, which the frozen voice UI parses via
 *     JSON.parse(participant.metadata).
 *
 * The SFU signing secret never reaches the browser: tokens are minted
 * here with node:crypto and the response carries only the short-lived
 * token itself.
 */
import "server-only";

import { createHmac, randomBytes } from "node:crypto";

export interface LiveKitVoiceConfig {
  kind: "configured" | "unconfigured";
  url?: string;
  apiKey?: string;
  apiSecret?: string;
}

/**
 * Read the SFU configuration from server-only env vars. Without ALL three
 * values the voice feature is intentionally OFF (the route answers 503 and
 * the UI shows "voice is not available yet") — we never fake a working
 * connection and never fall back to a development endpoint.
 */
export function getLiveKitVoiceConfig(): LiveKitVoiceConfig {
  const url = process.env.LIVEKIT_URL?.trim();
  const apiKey = process.env.LIVEKIT_API_KEY?.trim();
  const apiSecret = process.env.LIVEKIT_API_SECRET?.trim();
  if (!url || !apiKey || !apiSecret) return { kind: "unconfigured" };
  return { kind: "configured", url, apiKey, apiSecret };
}

/** How long a join token stays valid. The SFU keeps the session going via
 *  ICE reconnection after join; the TTL only covers the initial connect. */
export const VOICE_TOKEN_TTL_SECONDS = 600;

const b64url = (input: Buffer | string): string =>
  Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export interface VoiceTokenClaims {
  iss: string;
  sub: string;
  nbf: number;
  exp: number;
  jti: string;
  /** Current LiveKit contract: grants live under `video` (NOT metadata). */
  video: {
    room: string;
    roomJoin: boolean;
    canPublish: boolean;
    canSubscribe: boolean;
  };
  /** Top-level claim; available to the UI as Participant.name. */
  name: string;
  /** Top-level STRING claim; the UI reads JSON { avatarId } from it. */
  metadata: string;
}

/**
 * Mint a LiveKit access token.
 *
 * `identity` MUST be the caller's verified auth.uid() (the route guarantees
 * this) — a client can never mint a token for someone else or for an
 * arbitrary room: `room` is the server-derived provider room name and the
 * signature binds all of it to the server secret.
 */
export function createLiveKitVoiceToken(opts: {
  apiKey: string;
  apiSecret: string;
  identity: string;
  room: string;
  name: string;
  avatarId?: string | null;
  ttlSeconds?: number;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const ttl = opts.ttlSeconds ?? VOICE_TOKEN_TTL_SECONDS;
  const header = { alg: "HS256", typ: "JWT" };
  const payload: VoiceTokenClaims = {
    iss: opts.apiKey,
    sub: opts.identity,
    nbf: now,
    exp: now + ttl, // required by the current LiveKit verifier (exp claim)
    jti: b64url(randomBytes(16)),
    video: {
      room: opts.room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    },
    name: opts.name.slice(0, 100),
    metadata: JSON.stringify({ avatarId: opts.avatarId ?? null }),
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = b64url(createHmac("sha256", opts.apiSecret).update(signingInput).digest());
  return `${signingInput}.${signature}`;
}
