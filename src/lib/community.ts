import { z } from "zod";

/**
 * Community group chat — shared domain logic.
 *
 * Pure/isomorphic: no server-only imports, so the same constants and
 * validators are used by the API routes, the server actions and the client
 * components (and by the unit tests) without drift.
 */

// ---------------------------------------------------------------------------
// Avatars — exactly four project-controlled images (two feminine, two
// masculine). Users pick one; there is deliberately no user-uploaded profile
// picture in the Community.
// ---------------------------------------------------------------------------

export const COMMUNITY_AVATAR_IDS = [
  "avatar-1", // masculine
  "avatar-2", // feminine
  "avatar-3", // masculine
  "avatar-4", // feminine
] as const;

export type CommunityAvatarId = (typeof COMMUNITY_AVATAR_IDS)[number];

/** Static URL for a predefined avatar; unknown ids fall back to avatar-1. */
export function communityAvatarUrl(avatarId: string): string {
  const id = (COMMUNITY_AVATAR_IDS as readonly string[]).includes(avatarId)
    ? avatarId
    : "avatar-1";
  return `/community/avatars/${id}.png`;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Generated community usernames are short; the column keeps a 40 cap. */
export const COMMUNITY_MAX_NAME_LENGTH = 40;
export const COMMUNITY_MIN_USERNAME_LENGTH = 3;
export const COMMUNITY_MAX_USERNAME_LENGTH = 24;
/** Hard cap on message text, enforced server-side (and mirrored in the DB). */
export const COMMUNITY_MAX_MESSAGE_LENGTH = 2000;
/** 2 MB hard cap for chat images (bytes, measured server-side). */
export const COMMUNITY_MAX_IMAGE_BYTES = 2 * 1024 * 1024;
/** Initial page + "load older" page size. */
export const COMMUNITY_PAGE_SIZE = 50;

/**
 * Community usernames are generated (adjective + animal, e.g. "BlueFalcon")
 * or user-edited later. Either way: letters/digits only, 3–24 chars, starting
 * with a letter — no spaces (mention parsing needs word boundaries), no
 * personal first names (the generator never emits one).
 *
 * NOTE: declared BEFORE `communityProfileSchema` (below) — the schema is
 * evaluated at module load, so a later `const` would hit the TDZ.
 */
export const COMMUNITY_USERNAME_REGEX = /^[A-Za-z][A-Za-z0-9]{2,23}$/;

export function isValidCommunityUsername(value: string): boolean {
  return COMMUNITY_USERNAME_REGEX.test(value.trim());
}

/**
 * Phase 10 — the DESIGNATED platform admin's display-name rules. Only applied
 * to that one stable user id (the server decides via isPlatformAdminId; a
 * client can never claim admin). Everything else keeps the strict username
 * rules above:
 *   * 1–40 characters (after trim)
 *   * no C0/C1 control characters anywhere
 */
export const COMMUNITY_ADMIN_MAX_NAME_LENGTH = 40;
const ADMIN_NAME_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

export function isValidAdminCommunityName(value: string): boolean {
  const name = value.trim();
  return (
    name.length >= 1 &&
    name.length <= COMMUNITY_ADMIN_MAX_NAME_LENGTH &&
    !ADMIN_NAME_CONTROL_CHARS.test(name)
  );
}

// ---------------------------------------------------------------------------
// Schemas (server-side validation; the client mirrors them for UX only)
// ---------------------------------------------------------------------------

export const communityProfileSchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(1)
    .max(COMMUNITY_MAX_NAME_LENGTH)
    .regex(COMMUNITY_USERNAME_REGEX, "username_format"),
  avatarId: z.enum(COMMUNITY_AVATAR_IDS),
});

export type CommunityProfileInput = z.infer<typeof communityProfileSchema>;

// ---------------------------------------------------------------------------
// Rooms & categories (data-driven; seeded in the DB, never hard-coded in UI)
// ---------------------------------------------------------------------------

export interface CommunityRoomCategory {
  id: string;
  slug: string;
  name: string;
  position: number;
}

export interface CommunityRoom {
  id: string;
  slug: string;
  /** Display name — German by design (the rooms are German topics). */
  name: string;
  category_id: string;
  description: string | null;
  icon: string;
  position: number;
  enabled: boolean;
  /** Phase 5: Q&A mode — questions + answers allowed in this room. */
  qna_enabled: boolean;
}

/** A category with its rooms already ordered — the sidebar's shape. */
export interface CommunityRoomGroup extends CommunityRoomCategory {
  rooms: CommunityRoom[];
}

/** The seeded default room where the old single-chat messages live. */
export const COMMUNITY_DEFAULT_ROOM_SLUG = "public-chat";

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export interface CommunityAuthor {
  user_id: string;
  display_name: string;
  avatar_id: string;
  /**
   * Phase 3: privacy-mapped presence (server-computed; the members endpoint
   * is the only surface that provides it — message authors render without).
   */
  presence?: "online" | "away" | "dnd" | "offline";
  /** Phase 3: privacy-mapped last seen (null = never / hidden). */
  last_seen_at?: string | null;
  /**
   * Phase 10: the platform-admin flag (server-computed from the database
   * author id — never client-set, never derived from the display name).
   * Drives the red verification badge.
   */
  platform_admin?: boolean;
}

export interface CommunityMessage {
  id: string;
  user_id: string;
  /** The room this message belongs to (required since Community v2). */
  room_id: string;
  message: string | null;
  image_path: string | null;
  reply_to_message_id: string | null;
  created_at: string;
  updated_at: string;
}

export type CommunityMessageView = CommunityMessage & {
  author: CommunityAuthor | null;
};

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

/**
 * The fixed reaction set. 👍 doubles as the "helpful" signal (it later feeds
 * the reputation count) — keeping the set closed means no free-text emoji
 * rows and a tiny, stable wire format.
 */
export const COMMUNITY_REACTION_EMOJIS = [
  "👍",
  "❤️",
  "😂",
  "😮",
  "😢",
  "🔥",
  "✅",
] as const;

export type CommunityReactionEmoji = (typeof COMMUNITY_REACTION_EMOJIS)[number];

/** The emoji that counts toward a member's reputation ("helpful"). */
export const COMMUNITY_HELPFUL_EMOJI: CommunityReactionEmoji = "👍";

/** Aggregated reaction for one emoji on one message (API/initial-fetch shape). */
export interface CommunityMessageReactionAgg {
  emoji: string;
  count: number;
  /** Whether the current viewer already reacted with this emoji. */
  mine: boolean;
}

// ---------------------------------------------------------------------------
// Reply previews
// ---------------------------------------------------------------------------

/** The trimmed parent a message replies to (fetched in batch, no N+1). */
export interface CommunityReplyPreview {
  id: string;
  user_id: string;
  message: string | null;
  image_path: string | null;
  created_at: string;
  author: CommunityAuthor | null;
}

/**
 * A message row as the CLIENT keeps it: the server shape plus the display
 * data the room view resolves in batch (reactions, the reply-to parent) and —
 * only for rows THIS client inserted optimistically — the send status.
 */
export type CommunityMessageClient = CommunityMessageView & {
  reactions: CommunityMessageReactionAgg[];
  replyTo: CommunityReplyPreview | null;
};

// ---------------------------------------------------------------------------
// Mentions
// ---------------------------------------------------------------------------

/**
 * Extract the @-mentioned username tokens from a message body (pure —
 * testable). A mention is `@` followed by 2–24 letters/digits, starting a
 * word or following whitespace/punctuation — so "@not-a-name_" or
 * "email@x.com" never match. Matching against real members happens
 * case-insensitively server-side (Postgres `ilike`), not here.
 */
const MENTION_TOKEN = /(^|[\s([{>"'])@([A-Za-z][A-Za-z0-9]{1,23})/g;

export function extractMentionUsernames(text: string | null): string[] {
  if (!text) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(MENTION_TOKEN)) {
    const name = match[2];
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      found.push(name);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Optimistic send lifecycle (pure — unit-testable without DOM/network)
// ---------------------------------------------------------------------------

/** Lifecycle of a message THIS client inserted optimistically. */
export type MessageSendStatus = "sending" | "sent" | "failed";

/**
 * A message row in the client state: the API/Realtime shape plus the
 * display data the room view resolves (reactions, reply-to parent) and —
 * only for rows THIS client inserted optimistically — the send status.
 */
export type LocalMessage = CommunityMessageClient & {
  sendStatus?: MessageSendStatus;
};

/**
 * Build the optimistic row that appears in the UI the instant Send is
 * pressed — BEFORE the network round-trip. The client generates the UUID
 * (`id`), which the API route accepts (idempotency): every retry reuses the
 * SAME id, so a lost response or a duplicate Realtime INSERT can never
 * create a second copy.
 */
export function createOptimisticMessage(input: {
  id: string;
  roomId: string;
  user: CommunityAuthor;
  text: string | null;
  imagePath: string | null;
  replyToMessageId: string | null;
  createdAt: string;
}): LocalMessage {
  return {
    id: input.id,
    room_id: input.roomId,
    user_id: input.user.user_id,
    message: input.text,
    image_path: input.imagePath,
    reply_to_message_id: input.replyToMessageId,
    created_at: input.createdAt,
    updated_at: input.createdAt,
    author: input.user,
    reactions: [],
    replyTo: null,
    sendStatus: "sending",
  };
}

/** Set the send status of one optimistic row (no-op for unknown ids). */
export function setSendStatus(
  messages: LocalMessage[],
  id: string,
  status: MessageSendStatus,
): LocalMessage[] {
  let changed = false;
  const next = messages.map((m) => {
    if (m.id !== id) return m;
    if (m.sendStatus === status) return m;
    changed = true;
    return { ...m, sendStatus: status };
  });
  return changed ? next : messages;
}

type MergeableMessage = CommunityMessage & {
  author?: CommunityAuthor | null;
  sendStatus?: MessageSendStatus;
};

/**
 * Merge incoming messages into the current list — dedupe by id (the sender's
 * own POST response, a realtime INSERT, and a post-reconnect resync can all
 * carry the same row) and keep the chronological ascending order.
 *
 * Collision policy:
 *  - default (`preferIncoming: false`): the EXISTING row wins — used for
 *    "load older" pagination, where the local list is already authoritative.
 *  - `preferIncoming: true`: the INCOMING (server) row wins — used for the
 *    sender's POST response and Realtime INSERTs, which carry the DB truth
 *    (created_at, image_path). The local author is preserved when the
 *    incoming row has none (Realtime rows are un-enriched), and the send
 *    status becomes "sent" — a server echo is PROOF the row is persisted,
 *    even if the POST response itself was lost by the network (the failed
 *    bubble flips to delivered instead of being resurrected).
 */
export function mergeCommunityMessages<T extends MergeableMessage>(
  existing: T[],
  incoming: T[],
  opts: { preferIncoming?: boolean } = {},
): T[] {
  const preferIncoming = opts.preferIncoming === true;
  const byId = new Map<string, T>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of incoming) {
    const local = byId.get(m.id);
    if (local === undefined) {
      byId.set(m.id, m);
    } else if (preferIncoming) {
      byId.set(m.id, {
        ...m,
        author: m.author ?? local.author,
        sendStatus: "sent",
      } as T);
    }
  }
  return [...byId.values()].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
}

// ---------------------------------------------------------------------------
// Image upload validation (server-side — never trust the client)
// ---------------------------------------------------------------------------

/** The only accepted chat image MIME types (no GIF/SVG/PDF/video/audio). */
export const COMMUNITY_IMAGE_MIMES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export type CommunityImageVerdict =
  | { ok: true; ext: string }
  | { ok: false; code: "image_too_large" | "invalid_image" };

/**
 * Validate an uploaded chat image from its ACTUAL bytes:
 *  1. the declared MIME must be jpeg/png/webp,
 *  2. the real byte length must be ≤ 2 MB (never the client-declared size),
 *  3. the magic bytes must match the declared MIME (detects spoofing,
 *     e.g. a PDF or script bytes renamed/retyped as an image).
 */
export function validateCommunityImage(
  mime: string,
  bytes: Uint8Array,
): CommunityImageVerdict {
  if (!(COMMUNITY_IMAGE_MIMES as readonly string[]).includes(mime)) {
    return { ok: false, code: "invalid_image" };
  }
  if (bytes.byteLength > COMMUNITY_MAX_IMAGE_BYTES) {
    return { ok: false, code: "image_too_large" };
  }
  if (bytes.byteLength === 0) {
    return { ok: false, code: "invalid_image" };
  }
  if (mime === "image/jpeg") {
    if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
      return { ok: false, code: "invalid_image" };
    }
  } else if (mime === "image/png") {
    if (
      bytes.length < PNG_SIGNATURE.length ||
      PNG_SIGNATURE.some((value, i) => bytes[i] !== value)
    ) {
      return { ok: false, code: "invalid_image" };
    }
  } else {
    // image/webp: "RIFF" + size + "WEBP"
    if (bytes.length < 12) return { ok: false, code: "invalid_image" };
    if (
      bytes[0] !== 0x52 || // R
      bytes[1] !== 0x49 || // I
      bytes[2] !== 0x46 || // F
      bytes[3] !== 0x46 || // F
      bytes[8] !== 0x57 || // W
      bytes[9] !== 0x45 || // E
      bytes[10] !== 0x42 || // B
      bytes[11] !== 0x50 // P
    ) {
      return { ok: false, code: "invalid_image" };
    }
  }
  return { ok: true, ext: MIME_TO_EXT[mime] };
}

/**
 * Server-generated storage path: {user_id}/{message_id}/image.{ext}.
 * The client filename is never used. Both id segments must be valid UUIDs —
 * anything else yields "" and the caller rejects the request.
 */
export function buildCommunityImagePath(
  userId: string,
  messageId: string,
  ext: string,
): string {
  const uuidOk = z.string().uuid().safeParse(userId).success;
  const messageOk = z.string().uuid().safeParse(messageId).success;
  if (!uuidOk || !messageOk) return "";
  return `${userId}/${messageId}/image.${ext}`;
}

/**
 * Phase 2 DM storage path: dm/{conversation_id}/{user_id}/{message_id}/image.{ext}
 * The top-level `dm` segment is the storage-policy boundary (see the v3
 * social migration): every DM object is scoped to conversation membership,
 * and the third segment to the author. ALL segments must be valid UUIDs —
 * anything else yields "" and the caller rejects the request.
 */
export function buildDmImagePath(
  conversationId: string,
  userId: string,
  messageId: string,
  ext: string,
): string {
  const convOk = z.string().uuid().safeParse(conversationId).success;
  const userOk = z.string().uuid().safeParse(userId).success;
  const messageOk = z.string().uuid().safeParse(messageId).success;
  if (!convOk || !userOk || !messageOk) return "";
  return `dm/${conversationId}/${userId}/${messageId}/image.${ext}`;
}
