import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import type {
  ReportReason,
  ReportStatus,
  ReportTargetType,
} from "@/lib/community/reports";
import { evictLiveKitParticipant } from "@/lib/voice/livekit-api";
import { communityLog } from "@/lib/community/log";

/**
 * Community Phase 5 — the moderation queue + authorized actions.
 *
 * Everything here runs on the ADMIN client (service role) — the
 * moderation page re-checks the viewer's role on every render AND on
 * every action (fetchViewerRole), so a demoted user's in-flight page can
 * never execute an action. The RLS on community_moderation_actions
 * (moderator+ read, NO write policies for any user) is the database-level
 * second line: the audit log is append-only by construction.
 *
 * Reporter privacy: queue rows carry the reporter's community display
 * name (moderators need it to follow up) — never an email or account
 * data, and never exposed outside this role-guarded surface.
 */

type AdminClient = ReturnType<typeof createAdminClient>;

export interface ReportQueueItem {
  id: string;
  reporterName: string | null;
  targetType: ReportTargetType;
  targetId: string;
  /** One-line preview of the reported content (per target type). */
  targetPreview: string;
  /** Where the target lives (message → room slug, question/answer → room slug). */
  roomSlug: string | null;
  /** The user whose content was reported (profile reports → the profile
   *  itself) — the target of user-level sanctions. */
  targetAuthorId: string | null;
  targetAuthorName: string | null;
  reason: ReportReason;
  details: string | null;
  status: ReportStatus;
  assignedTo: string | null;
  assignedName: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface ReportQueuePage {
  items: ReportQueueItem[];
  cursor: { createdAt: string; id: string } | null;
  unavailable: boolean;
}

/**
 * One page of the moderation queue (keyset cursor on created_at, bounded).
 * All lookups are batched per target type (no N+1).
 */
export async function fetchReportQueue(
  opts: {
    status: ReportStatus;
    beforeAt?: string | null;
    beforeId?: string | null;
    limit?: number;
  } = { status: "open" },
): Promise<ReportQueuePage> {
  const fail: ReportQueuePage = { items: [], cursor: null, unavailable: true };
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  try {
    const admin = createAdminClient() as AdminClient;
    let query = admin
      .from("community_reports")
      .select(
        "id,reporter_id,target_type,target_id,reason,details,status,assigned_to,created_at,resolved_at",
      )
      .eq("status", opts.status)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (opts.beforeAt && opts.beforeId) {
      query = query.or(
        `created_at.lt.${opts.beforeAt},and(created_at.eq.${opts.beforeAt},id.lt.${opts.beforeId})`,
      );
    }
    const { data: rows, error } = await query;
    if (error || !rows || rows.length === 0) {
      return { items: [], cursor: null, unavailable: Boolean(error) };
    }
    const reports = rows as Array<Record<string, unknown>>;

    // Batched target previews per type.
    const messageIds = new Set<string>();
    const questionIds = new Set<string>();
    const answerIds = new Set<string>();
    const profileIds = new Set<string>();
    const userNames = new Set<string>();
    for (const r of reports) {
      const type = r.target_type as ReportTargetType;
      const id = String(r.target_id);
      if (type === "message") messageIds.add(id);
      else if (type === "question") questionIds.add(id);
      else if (type === "answer") answerIds.add(id);
      else profileIds.add(id);
      userNames.add(String(r.reporter_id));
      if (r.assigned_to) userNames.add(String(r.assigned_to));
    }

    const [messagesRes, questionsRes, answersRes, profilesRes] = await Promise.all([
      messageIds.size > 0
        ? admin
            .from("community_messages")
            .select("id,user_id,room_id,message")
            .in("id", [...messageIds])
            .limit(100)
        : Promise.resolve({ data: null as Array<Record<string, unknown>> | null, error: null }),
      questionIds.size > 0
        ? admin
            .from("community_questions")
            .select("id,author_id,room_id,title,status")
            .in("id", [...questionIds])
            .limit(100)
        : Promise.resolve({ data: null as Array<Record<string, unknown>> | null, error: null }),
      answerIds.size > 0
        ? admin
            .from("community_answers")
            .select("id,author_id,question_id,body")
            .in("id", [...answerIds])
            .limit(100)
        : Promise.resolve({ data: null as Array<Record<string, unknown>> | null, error: null }),
      profileIds.size > 0
        ? admin
            .from("community_profiles")
            .select("user_id,display_name")
            .in("user_id", [...profileIds])
            .limit(100)
        : Promise.resolve({ data: null as Array<Record<string, unknown>> | null, error: null }),
    ]);
    if (messagesRes.error || questionsRes.error || answersRes.error || profilesRes.error) {
      console.error("[community] report queue previews failed");
      return fail;
    }

    const roomIds = new Set<string>();
    const messageMap = new Map(
      ((messagesRes.data ?? []) as Array<Record<string, unknown>>).map((m) => [String(m.id), m]),
    );
    const questionMap = new Map(
      ((questionsRes.data ?? []) as Array<Record<string, unknown>>).map((q) => [String(q.id), q]),
    );
    const answerMap = new Map(
      ((answersRes.data ?? []) as Array<Record<string, unknown>>).map((a) => [String(a.id), a]),
    );
    const profileMap = new Map(
      ((profilesRes.data ?? []) as Array<Record<string, unknown>>).map((p) => [
        String(p.user_id),
        p.display_name as string,
      ]),
    );
    for (const m of messageMap.values()) roomIds.add(String(m.room_id));
    for (const q of questionMap.values()) roomIds.add(String(q.room_id));
    // Answers need their question's room — resolve in one extra bounded
    // query only when the page contains answers.
    const answerQuestionRooms: Record<string, string> = {};
    if (answerMap.size > 0) {
      const aqIds = [...new Set([...answerMap.values()].map((a) => String(a.question_id)))];
      const { data: aqRows } = await admin
        .from("community_questions")
        .select("id,room_id")
        .in("id", aqIds)
        .limit(100);
      for (const row of (aqRows ?? []) as Array<Record<string, unknown>>) {
        answerQuestionRooms[String(row.id)] = String(row.room_id);
        roomIds.add(String(row.room_id));
      }
    }
    const roomSlugs: Record<string, string> = {};
    if (roomIds.size > 0) {
      const { data: roomRows } = await admin
        .from("community_rooms")
        .select("id,slug")
        .in("id", [...roomIds])
        .limit(100);
      for (const row of (roomRows ?? []) as Array<Record<string, unknown>>) {
        roomSlugs[String(row.id)] = String(row.slug);
      }
    }
    // Reporter + assignee display names (bounded).
    const names: Record<string, string> = {};
    if (userNames.size > 0) {
      const { data: nameRows } = await admin
        .from("community_profiles")
        .select("user_id,display_name")
        .in("user_id", [...userNames])
        .limit(100);
      for (const row of (nameRows ?? []) as Array<Record<string, unknown>>) {
        names[String(row.user_id)] = String(row.display_name);
      }
    }

    // Content authors (for user-level sanctions) — one bounded fetch for
    // every author name still missing from the reporter/assignee batch.
    const authorIds = new Set<string>();
    for (const m of messageMap.values()) authorIds.add(String(m.user_id));
    for (const q of questionMap.values()) authorIds.add(String(q.author_id));
    for (const a of answerMap.values()) authorIds.add(String(a.author_id));
    for (const p of profileIds) authorIds.add(p);
    const missingAuthorNames = [...authorIds].filter((id) => !names[id]);
    if (missingAuthorNames.length > 0) {
      const { data: authorNameRows } = await admin
        .from("community_profiles")
        .select("user_id,display_name")
        .in("user_id", missingAuthorNames.slice(0, 100))
        .limit(100);
      for (const row of (authorNameRows ?? []) as Array<Record<string, unknown>>) {
        names[String(row.user_id)] = String(row.display_name);
      }
    }

    const items: ReportQueueItem[] = reports.map((r) => {
      const type = r.target_type as ReportTargetType;
      const targetId = String(r.target_id);
      let preview = "";
      let slug: string | null = null;
      let authorId: string | null = null;
      if (type === "message") {
        const m = messageMap.get(targetId);
        if (m) {
          preview = String(m.message ?? "").slice(0, 160) || "(Bild)";
          slug = roomSlugs[String(m.room_id)] ?? null;
          authorId = String(m.user_id);
        }
      } else if (type === "question") {
        const q = questionMap.get(targetId);
        if (q) {
          preview = `${String(q.title)} [${String(q.status)}]`;
          slug = roomSlugs[String(q.room_id)] ?? null;
          authorId = String(q.author_id);
        }
      } else if (type === "answer") {
        const a = answerMap.get(targetId);
        if (a) {
          preview = String(a.body).slice(0, 160);
          slug = roomSlugs[answerQuestionRooms[String(a.question_id)] ?? ""] ?? null;
          authorId = String(a.author_id);
        }
      } else {
        preview = profileMap.get(targetId) ?? "(Mitglied entfernt)";
        authorId = targetId;
      }
      return {
        id: String(r.id),
        reporterName: names[String(r.reporter_id)] ?? null,
        targetType: type,
        targetId,
        targetPreview: preview,
        roomSlug: slug,
        targetAuthorId: authorId,
        targetAuthorName: authorId ? (names[authorId] ?? null) : null,
        reason: r.reason as ReportReason,
        details: (r.details as string | null) ?? null,
        status: r.status as ReportStatus,
        assignedTo: (r.assigned_to as string | null) ?? null,
        assignedName: r.assigned_to ? (names[String(r.assigned_to)] ?? null) : null,
        createdAt: String(r.created_at),
        resolvedAt: (r.resolved_at as string | null) ?? null,
      };
    });

    const last = items[items.length - 1];
    return {
      items,
      cursor:
        items.length === limit
          ? { createdAt: last.createdAt, id: last.id }
          : null,
      unavailable: false,
    };
  } catch (error) {
    console.error("[community] report queue threw:", error);
    return fail;
  }
}

export interface ReportCounts {
  open: number;
  reviewing: number;
  resolved: number;
  dismissed: number;
}

/** Queue tab counts (four bounded head-queries — no row downloads). */
export async function fetchReportCounts(): Promise<ReportCounts | null> {
  try {
    const admin = createAdminClient() as AdminClient;
    const [openRes, reviewingRes, resolvedRes, dismissedRes] = await Promise.all([
      admin.from("community_reports").select("id", { count: "exact", head: true }).eq("status", "open"),
      admin.from("community_reports").select("id", { count: "exact", head: true }).eq("status", "reviewing"),
      admin.from("community_reports").select("id", { count: "exact", head: true }).eq("status", "resolved"),
      admin.from("community_reports").select("id", { count: "exact", head: true }).eq("status", "dismissed"),
    ]);
    if (openRes.error || reviewingRes.error || resolvedRes.error || dismissedRes.error) return null;
    return {
      open: openRes.count ?? 0,
      reviewing: reviewingRes.count ?? 0,
      resolved: resolvedRes.count ?? 0,
      dismissed: dismissedRes.count ?? 0,
    };
  } catch (error) {
    console.error("[community] report counts threw:", error);
    return null;
  }
}

/** Move a report through its status (reviewing / resolved / dismissed). */
export async function setReportStatus(input: {
  actorId: string;
  reportId: string;
  status: ReportStatus;
}): Promise<{ ok: true } | { ok: false; error: "failed" }> {
  try {
    const admin = createAdminClient() as AdminClient;
    const values: Record<string, unknown> = { status: input.status };
    if (input.status === "resolved" || input.status === "dismissed") {
      values.resolved_at = new Date().toISOString();
    } else {
      values.resolved_at = null;
    }
    const { data, error } = await admin
      .from("community_reports")
      .update(values)
      .eq("id", input.reportId)
      .select("id,target_type,target_id");
    if (error || !data || data.length === 0) return { ok: false, error: "failed" };
    const row = data[0] as { target_type: string; target_id: string };
    await auditAction(input.actorId, `report_${input.status}`, row.target_type, row.target_id);
    return { ok: true };
  } catch (error) {
    console.error("[community] set report status threw:", error);
    return { ok: false, error: "failed" };
  }
}

/** Assign a report to a moderator (sets the reviewer; keeps the status). */
export async function assignReport(input: {
  actorId: string;
  reportId: string;
  assigneeId: string;
}): Promise<{ ok: true } | { ok: false; error: "failed" }> {
  try {
    const admin = createAdminClient() as AdminClient;
    const { data, error } = await admin
      .from("community_reports")
      .update({ assigned_to: input.assigneeId })
      .eq("id", input.reportId)
      .select("id,target_type,target_id");
    if (error || !data || data.length === 0) return { ok: false, error: "failed" };
    const row = data[0] as { target_type: string; target_id: string };
    const { data: assignee } = await admin
      .from("community_profiles")
      .select("display_name")
      .eq("user_id", input.assigneeId)
      .maybeSingle();
    await auditAction(
      input.actorId,
      "report_assign",
      row.target_type,
      row.target_id,
      (assignee as { display_name?: string } | null)?.display_name,
    );
    return { ok: true };
  } catch (error) {
    console.error("[community] assign report threw:", error);
    return { ok: false, error: "failed" };
  }
}

/** Append one audit row (best-effort — the action itself already ran). */
async function auditAction(
  moderatorId: string,
  action: string,
  targetType: string,
  targetId: string,
  reason?: string | null,
): Promise<void> {
  try {
    const admin = createAdminClient() as AdminClient;
    await admin.from("community_moderation_actions").insert({
      moderator_id: moderatorId,
      action,
      target_type: targetType,
      target_id: targetId,
      reason: reason ?? null,
    });
  } catch (error) {
    console.error("[community] audit insert failed:", error);
  }
}

export type ModerationAction =
  | "delete_message"
  | "hide_message"
  | "unpin"
  | "remove_answer"
  | "close_question"
  | "reopen_question"
  | "warn_user"
  | "timeout_user"
  | "suspend_user"
  | "reinstate_user";

export const TIMEOUT_DURATIONS: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

/**
 * Execute ONE authorized moderation action. The action set is a CLOSED
 * whitelist (an arbitrary string cannot smuggle in a new capability);
 * every action is audited. Destructive actions are idempotent-friendly:
 * acting on an already-gone target returns ok (nothing to undo).
 */
export async function performModerationAction(input: {
  actorId: string;
  action: ModerationAction;
  targetType: ReportTargetType;
  targetId: string;
  /** timeout_user: one of the TIMEOUT_DURATIONS keys. */
  timeoutKey?: string;
}): Promise<{ ok: true } | { ok: false; error: "failed" }> {
  try {
    const admin = createAdminClient() as AdminClient;
    const { action, targetType, targetId } = input;

    if (action === "delete_message") {
      if (targetType !== "message") return { ok: false, error: "failed" };
      // Fetch the image path first (storage cleanup), then delete (the FK
      // cascades reactions / mentions / pins / mentions).
      const { data: msg } = await admin
        .from("community_messages")
        .select("image_path")
        .eq("id", targetId)
        .maybeSingle();
      const { error } = await admin.from("community_messages").delete().eq("id", targetId);
      if (error) return { ok: false, error: "failed" };
      const imagePath = (msg as { image_path?: string | null } | null)?.image_path ?? null;
      if (imagePath) {
        try {
          await admin.storage.from("community-images").remove([imagePath]);
        } catch {
          /* the row is gone; orphaned storage is GC-able */
        }
      }
      await auditAction(input.actorId, "delete_message", "message", targetId);
      return { ok: true };
    }

    if (action === "hide_message") {
      if (targetType !== "message") return { ok: false, error: "failed" };
      const { error } = await admin
        .from("community_messages")
        .update({ hidden_by: input.actorId, hidden_at: new Date().toISOString() })
        .eq("id", targetId);
      if (error) return { ok: false, error: "failed" };
      await auditAction(input.actorId, "hide_message", "message", targetId);
      return { ok: true };
    }

    if (action === "unpin") {
      const { error } = await admin.from("community_pins").delete().eq("message_id", targetId);
      if (error) return { ok: false, error: "failed" };
      await auditAction(input.actorId, "unpin", "message", targetId);
      return { ok: true };
    }

    if (action === "remove_answer") {
      if (targetType !== "answer") return { ok: false, error: "failed" };
      const { data: aRow, error: aErr } = await admin
        .from("community_answers")
        .select("id,question_id,accepted")
        .eq("id", targetId)
        .maybeSingle();
      if (aErr || !aRow) return { ok: false, error: "failed" };
      const { error } = await admin
        .from("community_answers")
        .update({ deleted_at: new Date().toISOString(), accepted: false })
        .eq("id", targetId);
      if (error) return { ok: false, error: "failed" };
      const questionId = String((aRow as { question_id: string }).question_id);
      if ((aRow as { accepted: boolean }).accepted) {
        // The accepted answer vanished → the question is open again.
        await admin
          .from("community_questions")
          .update({ status: "open", accepted_answer_id: null, solved_at: null })
          .eq("id", questionId);
      }
      await auditAction(input.actorId, "remove_answer", "answer", targetId);
      return { ok: true };
    }

    if (action === "close_question" || action === "reopen_question") {
      if (targetType !== "question") return { ok: false, error: "failed" };
      const closed = action === "close_question";
      const { error } = await admin
        .from("community_questions")
        .update({
          status: closed ? "closed" : "open",
          ...(closed ? { accepted_answer_id: null } : {}),
        })
        .eq("id", targetId);
      if (error) return { ok: false, error: "failed" };
      if (closed) {
        await admin.from("community_answers").update({ accepted: false }).eq("question_id", targetId);
      }
      await auditAction(input.actorId, action, "question", targetId);
      return { ok: true };
    }

    // User-level actions operate on profiles.
    if (targetType !== "profile") return { ok: false, error: "failed" };
    const { data: profile, error: pErr } = await admin
      .from("community_profiles")
      .select("user_id,display_name")
      .eq("user_id", targetId)
      .maybeSingle();
    if (pErr || !profile) return { ok: false, error: "failed" };
    const displayName = (profile as { display_name: string }).display_name;

    if (action === "warn_user") {
      // A stored-text notification (type 'moderation' renders from the
      // stored copy — the recipient gets one clear warning).
      const { error: nErr } = await admin.from("notifications").insert({
        type: "moderation",
        target_type: "user",
        target_user_id: targetId,
        created_by: input.actorId,
        actor_id: input.actorId,
        title: "Moderation",
        content:
          "Warnung der Community-Moderation: Bitte halte dich an die Regeln der Community. Weitere Verstöße können zu Sanktionen führen.",
      });
      if (nErr) return { ok: false, error: "failed" };
      await auditAction(input.actorId, "warn_user", "profile", targetId, displayName);
      return { ok: true };
    }

    if (action === "timeout_user") {
      const duration = TIMEOUT_DURATIONS[input.timeoutKey ?? "1h"] ?? TIMEOUT_DURATIONS["1h"];
      const { error } = await admin
        .from("community_profiles")
        .update({ community_muted_until: new Date(Date.now() + duration).toISOString() })
        .eq("user_id", targetId);
      if (error) return { ok: false, error: "failed" };
      await auditAction(
        input.actorId,
        "timeout_user",
        "profile",
        targetId,
        `${displayName} (${input.timeoutKey ?? "1h"})`,
      );
      return { ok: true };
    }

    if (action === "suspend_user") {
      const { error } = await admin
        .from("community_profiles")
        .update({ community_suspended: true })
        .eq("user_id", targetId);
      if (error) return { ok: false, error: "failed" };
      await auditAction(input.actorId, "suspend_user", "profile", targetId, displayName);
      // Phase 6B (B-2): evict the suspended user's ACTIVE LiveKit voice
      // session(s) — the write gate blocks NEW joins but cannot end a live
      // one. Best-effort by contract: the call has its own timeout and
      // never throws, so an SFU outage can neither block nor fail the
      // sanction. The result state is always explicit — `not_configured`
      // (voice OFF → no-op), `not_in_any_room`, `evicted`, or `unavailable`
      // (SFU unreachable/failed → logged, and the action result never claims
      // an eviction that did not happen).
      const eviction = await evictLiveKitParticipant(targetId);
      // Phase 6D (monitoring): eviction outcome through the Phase 6C
      // structured events — honest state only, never a fake success.
      if (eviction.status === "unavailable") {
        communityLog(
          "community.voice.unavailable",
          { userId: targetId, context: "eviction", detail: eviction.detail },
          "error",
        );
      } else if (eviction.status === "evicted") {
        communityLog(
          "community.voice.eviction",
          { userId: targetId, status: "evicted", rooms: eviction.rooms.join(",") },
          "warn",
        );
      } else {
        communityLog("community.voice.eviction", { userId: targetId, status: eviction.status });
      }
      return { ok: true };
    }

    if (action === "reinstate_user") {
      const { error } = await admin
        .from("community_profiles")
        .update({ community_suspended: false, community_muted_until: null })
        .eq("user_id", targetId);
      if (error) return { ok: false, error: "failed" };
      await auditAction(input.actorId, "reinstate_user", "profile", targetId, displayName);
      return { ok: true };
    }

    return { ok: false, error: "failed" };
  } catch (error) {
    console.error("[community] moderation action threw:", error);
    return { ok: false, error: "failed" };
  }
}

export interface ModerationAuditRow {
  id: string;
  action: string;
  targetType: ReportTargetType | string;
  targetId: string;
  reason: string | null;
  moderatorName: string | null;
  createdAt: string;
}

/** The recent audit trail (bounded, newest first) for the actions tab. */
export async function fetchModerationAudit(limit = 30): Promise<ModerationAuditRow[]> {
  try {
    const admin = createAdminClient() as AdminClient;
    const { data: rows, error } = await admin
      .from("community_moderation_actions")
      .select("id,moderator_id,action,target_type,target_id,reason,created_at")
      .order("created_at", { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 100));
    if (error || !rows || rows.length === 0) return [];
    const modIds = [...new Set((rows as Array<Record<string, unknown>>).map((r) => String(r.moderator_id)))];
    const { data: nameRows } = await admin
      .from("community_profiles")
      .select("user_id,display_name")
      .in("user_id", modIds)
      .limit(100);
    const names: Record<string, string> = {};
    for (const row of (nameRows ?? []) as Array<Record<string, unknown>>) {
      names[String(row.user_id)] = String(row.display_name);
    }
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      action: String(r.action),
      targetType: String(r.target_type),
      targetId: String(r.target_id),
      reason: (r.reason as string | null) ?? null,
      moderatorName: names[String(r.moderator_id)] ?? null,
      createdAt: String(r.created_at),
    }));
  } catch (error) {
    console.error("[community] moderation audit threw:", error);
    return [];
  }
}
