/**
 * Community Phase 4 — the voice contract (isomorphic, provider-agnostic).
 *
 * UI code talks to THIS contract (and the use-voice hook), never to a
 * concrete SFU SDK. Audio media flows Browser <-> SFU (LiveKit WebRTC);
 * Supabase carries only application coordination (the aggregate count
 * broadcast + the durable conversation row) — NEVER media.
 */

export const VOICE_PROVIDER = "livekit" as const;
export type VoiceProviderKind = typeof VOICE_PROVIDER;

/**
 * Server → client voice connection configuration (the token route response).
 * Contains NO secrets: the SFU websocket URL is not a credential, and the
 * token is short-lived + scoped (join the exact server-derived room,
 * publish audio, subscribe audio — nothing else).
 */
export interface VoiceJoinConfig {
  provider: VoiceProviderKind;
  url: string;
  /** Provider room — server-derived `croom-<roomId>`, never client-chosen. */
  room: string;
  token: string;
  /** Token lifetime in seconds (the SFU keeps the session via ICE after join). */
  expiresInSeconds: number;
  /** Aggregate count at join time (display only). */
  participantCount: number;
}

export type VoiceConnectionState =
  /** Not in a voice conversation. */
  | "idle"
  /** Token accepted, WebRTC connecting. */
  | "connecting"
  /** Connected, publishing + subscribed. */
  | "connected"
  /** The SFU/ICE connection dropped; auto-reconnecting (no user action). */
  | "reconnecting"
  /** A connection attempt failed (SFU unreachable, token rejected, …). */
  | "error"
  /** The server reports voice is not configured yet (503). */
  | "unavailable"
  /** Microphone permission denied — an explicit user retry is required. */
  | "mic_denied";

/** A voice participant (identities come from the SFU — server-signed). */
export interface VoiceParticipant {
  /** Stable identity = the user's id (signed into the token by the server). */
  identity: string;
  name: string;
  avatarId: string | null;
  muted: boolean;
  speaking: boolean;
  isSelf: boolean;
}

/**
 * Durable aggregate metadata (the DB row / page prefetch). Deliberately
 * carries NO participant identities — outsiders see a count, nothing else.
 */
export interface VoiceConversationMeta {
  active: boolean;
  participantCount: number;
}
