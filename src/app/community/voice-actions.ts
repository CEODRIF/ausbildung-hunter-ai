"use server";

/**
 * Community Phase 4 — voice count reconciliation (server action).
 *
 * The SFU-connected client observes the authoritative participant set; this
 * action reconciles the DURABLE aggregate (community_voice_conversations)
 * so outsiders' "Voice conversation · N" stays current WITHOUT any polling
 * and WITHOUT per-heartbeat writes: it runs only when the observed count
 * CHANGES (a participant joined or left).
 *
 * The SQL function accepts only convergent moves (a decrease, or exactly +1)
 * — see the v5 migration. No participant identities ever flow through here:
 * an integer count, nothing more.
 */
import { getCurrentUserAndProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rate-limit";
import { communityLog } from "@/lib/community/log";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PARTICIPANTS = 50;

/**
 * Reconcile the aggregate participant count of a room's active voice
 * conversation. Returns false (never throws) on any failure — voice chrome
 * is best-effort and must not break the room.
 */
export async function syncVoiceCount(roomId: string, observedCount: number): Promise<boolean> {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active") return false;
  if (typeof roomId !== "string" || !UUID.test(roomId)) return false;
  const n = Math.floor(observedCount);
  if (!Number.isFinite(n) || n < 0 || n > MAX_PARTICIPANTS) return false;

  const limited = await checkRateLimit("community_voice", user.id);
  if (!limited.allowed) return false;

  const supabase = await createClient();
  const { data: room } = await supabase
    .from("community_rooms")
    .select("id")
    .eq("id", roomId)
    .maybeSingle();
  if (!room) return false;

  const { error } = await supabase.rpc("community_voice_sync_count", {
    p_room: roomId,
    p_count: n,
  });
  // Phase 6C (C-3): leave/sync event — the count is an integer aggregate;
  // no identities, no token, no URL ever pass through here.
  if (error) {
    communityLog(
      "community.voice.leave_sync",
      { userId: user.id, roomId, count: n, result: "failed", detail: error.message },
      "error",
    );
    return false;
  }
  communityLog("community.voice.leave_sync", { userId: user.id, roomId, count: n, result: "ok" });
  return true;
}
