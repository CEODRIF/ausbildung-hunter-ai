import { z } from "zod";

/**
 * Community group chat — shared domain logic.
 *
 * Pure/isomorphic: no server-only imports, so the same constants and
 * validators are used by the API routes, the server actions and the client
 * components (and by the unit tests) without drift.
 */

// ---------------------------------------------------------------------------
// Avatars — exactly five project-controlled images. Users pick one; there is
// deliberately no user-uploaded profile picture in the Community.
// ---------------------------------------------------------------------------

export const COMMUNITY_AVATAR_IDS = [
  "avatar-1",
  "avatar-2",
  "avatar-3",
  "avatar-4",
  "avatar-5",
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

export const COMMUNITY_MAX_NAME_LENGTH = 40;
/** Hard cap on message text, enforced server-side (and mirrored in the DB). */
export const COMMUNITY_MAX_MESSAGE_LENGTH = 2000;
/** 2 MB hard cap for chat images (bytes, measured server-side). */
export const COMMUNITY_MAX_IMAGE_BYTES = 2 * 1024 * 1024;
/** Initial page + "load older" page size. */
export const COMMUNITY_PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Schemas (server-side validation; the client mirrors them for UX only)
// ---------------------------------------------------------------------------

export const communityProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(COMMUNITY_MAX_NAME_LENGTH),
  avatarId: z.enum(COMMUNITY_AVATAR_IDS),
});

export type CommunityProfileInput = z.infer<typeof communityProfileSchema>;

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export interface CommunityAuthor {
  user_id: string;
  display_name: string;
  avatar_id: string;
}

export interface CommunityMessage {
  id: string;
  user_id: string;
  message: string | null;
  image_path: string | null;
  created_at: string;
  updated_at: string;
}

export type CommunityMessageView = CommunityMessage & {
  author: CommunityAuthor | null;
};

// ---------------------------------------------------------------------------
// Optimistic send lifecycle (pure — unit-testable without DOM/network)
// ---------------------------------------------------------------------------

/** Lifecycle of a message THIS client inserted optimistically. */
export type MessageSendStatus = "sending" | "sent" | "failed";

/**
 * A message row in the client state. Rows coming from the API/Realtime never
 * carry `sendStatus`; only the client's own optimistic rows do.
 */
export type LocalMessage = CommunityMessageView & {
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
  user: CommunityAuthor;
  text: string | null;
  imagePath: string | null;
  createdAt: string;
}): LocalMessage {
  return {
    id: input.id,
    user_id: input.user.user_id,
    message: input.text,
    image_path: input.imagePath,
    created_at: input.createdAt,
    updated_at: input.createdAt,
    author: input.user,
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
