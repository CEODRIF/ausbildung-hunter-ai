"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  fetchViewerRole,
  isAdmin,
  type CommunityRole,
  setMemberRole,
} from "@/lib/community/roles";
import {
  pinMessage,
  unpinMessage,
} from "@/lib/community/pins";
import {
  assignReport,
  fetchModerationAudit,
  performModerationAction,
  setReportStatus,
  type ModerationAction,
} from "@/lib/community/moderation";
import {
  updateRoomSettings,
  type RoomSettingsInput,
} from "@/lib/community/rooms";
import {
  acceptAnswer,
  setQuestionClosed,
  unsolveQuestion,
} from "@/lib/community/qa";
import type { ReportStatus, ReportTargetType } from "@/lib/community/reports";

/**
 * Community Phase 5 — server actions for pins, moderation, roles and room
 * settings.
 *
 * AUTHORIZATION MODEL (the whole point of this file):
 *   * the actor is ALWAYS the session user (never a client field),
 *   * the role is re-resolved from the database on EVERY call (a demotion
 *     takes effect on the next click),
 *   * the lib layer re-checks the role AGAIN with the rank it needs
 *     (two independent gates), and the DB keeps a third line (no user
 *     write policies on the protected tables),
 *   * rate limits apply per scope (pin / moderation / role / room_settings).
 *
 * Every result is a small typed envelope; the client toasts the localized
 * copy and re-reads its view on success.
 */

type ActionResult = { ok: true } | { ok: false; code: string };

const uuidValue = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Session + role in one pass; null = not authorized (or no session). */
async function requireRole(min: "moderator" | "admin"): Promise<{
  userId: string;
  role: CommunityRole;
} | null> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;
    const role = await fetchViewerRole(supabase, user.id);
    const ok = min === "admin" ? isAdmin(role) : role !== "member" && role !== "helper";
    if (!ok) return null;
    return { userId: user.id, role };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pins (moderator+)
// ---------------------------------------------------------------------------

/** Pin a room message (moderator+). `roomSlug` is resolved server-side. */
export async function pinMessageAction(
  roomSlug: string,
  messageId: string,
): Promise<ActionResult> {
  if (!uuidValue.test(messageId)) return { ok: false, code: "invalid" };
  const actor = await requireRole("moderator");
  if (!actor) return { ok: false, code: "forbidden" };
  const limited = await checkRateLimit("community_pin", actor.userId);
  if (!limited.allowed) return { ok: false, code: "rate_limited" };
  try {
    const supabase = await createClient();
    const { data: room } = await supabase
      .from("community_rooms")
      .select("id")
      .eq("slug", roomSlug)
      .eq("enabled", true)
      .maybeSingle();
    if (!room) return { ok: false, code: "not_found" };
    const result = await pinMessage({
      actorUserId: actor.userId,
      actorRole: actor.role,
      roomId: (room as { id: string }).id,
      messageId,
    });
    if (!result.ok) return { ok: false, code: result.error };
    revalidatePath(`/community/${roomSlug}`);
    return { ok: true };
  } catch {
    return { ok: false, code: "failed" };
  }
}

export async function unpinMessageAction(
  roomSlug: string,
  messageId: string,
): Promise<ActionResult> {
  if (!uuidValue.test(messageId)) return { ok: false, code: "invalid" };
  const actor = await requireRole("moderator");
  if (!actor) return { ok: false, code: "forbidden" };
  const limited = await checkRateLimit("community_pin", actor.userId);
  if (!limited.allowed) return { ok: false, code: "rate_limited" };
  try {
    const supabase = await createClient();
    const { data: room } = await supabase
      .from("community_rooms")
      .select("id")
      .eq("slug", roomSlug)
      .eq("enabled", true)
      .maybeSingle();
    if (!room) return { ok: false, code: "not_found" };
    const result = await unpinMessage({
      actorUserId: actor.userId,
      actorRole: actor.role,
      roomId: (room as { id: string }).id,
      messageId,
    });
    if (!result.ok) return { ok: false, code: result.error };
    revalidatePath(`/community/${roomSlug}`);
    return { ok: true };
  } catch {
    return { ok: false, code: "failed" };
  }
}

// ---------------------------------------------------------------------------
// Moderation queue (moderator+)
// ---------------------------------------------------------------------------

export async function setReportStatusAction(
  reportId: string,
  status: ReportStatus,
): Promise<ActionResult> {
  if (!uuidValue.test(reportId)) return { ok: false, code: "invalid" };
  if (!["open", "reviewing", "resolved", "dismissed"].includes(status)) {
    return { ok: false, code: "invalid" };
  }
  const actor = await requireRole("moderator");
  if (!actor) return { ok: false, code: "forbidden" };
  const limited = await checkRateLimit("community_moderation", actor.userId);
  if (!limited.allowed) return { ok: false, code: "rate_limited" };
  const result = await setReportStatus({
    actorId: actor.userId,
    reportId,
    status,
  });
  if (!result.ok) return { ok: false, code: result.error };
  revalidatePath("/community/moderation");
  return { ok: true };
}

export async function assignReportAction(
  reportId: string,
  assigneeId: string,
): Promise<ActionResult> {
  if (!uuidValue.test(reportId) || !uuidValue.test(assigneeId)) {
    return { ok: false, code: "invalid" };
  }
  const actor = await requireRole("moderator");
  if (!actor) return { ok: false, code: "forbidden" };
  const limited = await checkRateLimit("community_moderation", actor.userId);
  if (!limited.allowed) return { ok: false, code: "rate_limited" };
  const result = await assignReport({
    actorId: actor.userId,
    reportId,
    assigneeId,
  });
  if (!result.ok) return { ok: false, code: result.error };
  revalidatePath("/community/moderation");
  return { ok: true };
}

export async function performModerationActionAction(input: {
  action: ModerationAction;
  targetType: ReportTargetType;
  targetId: string;
  timeoutKey?: string;
}): Promise<ActionResult> {
  const actions: ModerationAction[] = [
    "delete_message",
    "hide_message",
    "unpin",
    "remove_answer",
    "close_question",
    "reopen_question",
    "warn_user",
    "timeout_user",
    "suspend_user",
    "reinstate_user",
  ];
  if (!actions.includes(input.action)) return { ok: false, code: "invalid" };
  if (!uuidValue.test(input.targetId)) return { ok: false, code: "invalid" };
  const actor = await requireRole("moderator");
  if (!actor) return { ok: false, code: "forbidden" };
  // User-level sanctions (suspend / reinstate) are admin+ only.
  if (
    (input.action === "suspend_user" || input.action === "reinstate_user") &&
    !isAdmin(actor.role)
  ) {
    return { ok: false, code: "forbidden" };
  }
  const limited = await checkRateLimit("community_moderation", actor.userId);
  if (!limited.allowed) return { ok: false, code: "rate_limited" };
  const result = await performModerationAction({
    actorId: actor.userId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    timeoutKey: input.timeoutKey,
  });
  if (!result.ok) return { ok: false, code: result.error };
  revalidatePath("/community/moderation");
  revalidatePath("/community", "layout");
  return { ok: true };
}

/** The audit trail for the moderation "Actions" tab (moderator+ page). */
export async function loadModerationAudit(): Promise<
  | { ok: true; rows: Awaited<ReturnType<typeof fetchModerationAudit>> }
  | { ok: false; code: string }
> {
  const actor = await requireRole("moderator");
  if (!actor) return { ok: false, code: "forbidden" };
  const rows = await fetchModerationAudit(30);
  return { ok: true, rows };
}

// ---------------------------------------------------------------------------
// Roles (admin+; rank-limited)
// ---------------------------------------------------------------------------

export async function setMemberRoleAction(
  targetUserId: string,
  role: string,
): Promise<ActionResult> {
  if (!uuidValue.test(targetUserId)) return { ok: false, code: "invalid" };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, code: "forbidden" };
  const limited = await checkRateLimit("community_role", user.id);
  if (!limited.allowed) return { ok: false, code: "rate_limited" };
  const result = await setMemberRole({
    actorUserId: user.id,
    targetUserId,
    role,
  });
  if (!result.ok) return { ok: false, code: result.error };
  revalidatePath("/community/moderation");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Room settings (moderator+)
// ---------------------------------------------------------------------------

export async function updateRoomSettingsAction(
  input: RoomSettingsInput,
): Promise<ActionResult> {
  if (!uuidValue.test(input.roomId)) return { ok: false, code: "invalid" };
  const actor = await requireRole("moderator");
  if (!actor) return { ok: false, code: "forbidden" };
  const limited = await checkRateLimit("community_room_settings", actor.userId);
  if (!limited.allowed) return { ok: false, code: "rate_limited" };
  const result = await updateRoomSettings(input);
  if (!result.ok) return { ok: false, code: result.error };
  revalidatePath("/community", "layout");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Q&A state transitions (role + authorship checked server-side)
// ---------------------------------------------------------------------------

/** Accept an answer: the QUESTION AUTHOR or moderator+ (server-checked). */
export async function acceptAnswerAction(
  questionId: string,
  answerId: string,
): Promise<ActionResult> {
  if (!uuidValue.test(questionId) || !uuidValue.test(answerId)) {
    return { ok: false, code: "invalid" };
  }
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, code: "forbidden" };
    const limited = await checkRateLimit("community_question", user.id);
    if (!limited.allowed) return { ok: false, code: "rate_limited" };
    // Authorship is checked INSIDE acceptAnswer against the DB row — the
    // client never asserts who it is; the role is the fallback path for
    // moderators.
    const role = await fetchViewerRole(supabase, user.id);
    const result = await acceptAnswer({
      actorUserId: user.id,
      actorRole: role,
      questionId,
      answerId,
    });
    if (!result.ok) return { ok: false, code: result.error };
    revalidatePath("/community/questions");
    return { ok: true };
  } catch {
    return { ok: false, code: "failed" };
  }
}

export async function unsolveQuestionAction(questionId: string): Promise<ActionResult> {
  if (!uuidValue.test(questionId)) return { ok: false, code: "invalid" };
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, code: "forbidden" };
    const limited = await checkRateLimit("community_question", user.id);
    if (!limited.allowed) return { ok: false, code: "rate_limited" };
    const role = await fetchViewerRole(supabase, user.id);
    const result = await unsolveQuestion({
      actorUserId: user.id,
      actorRole: role,
      questionId,
    });
    if (!result.ok) return { ok: false, code: result.error };
    revalidatePath("/community/questions");
    return { ok: true };
  } catch {
    return { ok: false, code: "failed" };
  }
}

/** Close / reopen — moderator+ only. */
export async function setQuestionClosedAction(
  questionId: string,
  closed: boolean,
): Promise<ActionResult> {
  if (!uuidValue.test(questionId)) return { ok: false, code: "invalid" };
  const actor = await requireRole("moderator");
  if (!actor) return { ok: false, code: "forbidden" };
  const limited = await checkRateLimit("community_question", actor.userId);
  if (!limited.allowed) return { ok: false, code: "rate_limited" };
  const result = await setQuestionClosed({
    actorUserId: actor.userId,
    actorRole: actor.role,
    questionId,
    closed,
  });
  if (!result.ok) return { ok: false, code: result.error };
  revalidatePath("/community/questions");
  return { ok: true };
}
