/**
 * Community Phase 3 — the in-page notification bus.
 *
 * The CommunityShell owns the ONE realtime notifications channel
 * (postgres_changes on public.notifications — RLS-scoped to the viewer's
 * own + global rows). Pages inside the shell (the notification center)
 * subscribe to this bus instead of opening a second channel, so there is
 * never a duplicate realtime listener for the same table.
 */

export interface BusNotification {
  id: string;
  title: string;
  content: string;
  type: string;
  target_type: "all" | "user";
  actor_id: string | null;
  room_id: string | null;
  room_message_id: string | null;
  conversation_id: string | null;
  dm_message_id: string | null;
  reaction_emoji: string | null;
  /** Phase 5 Q&A references (answer / answer_accepted kinds). */
  question_id?: string | null;
  answer_id?: string | null;
  created_at: string;
}

type Listener = (n: BusNotification) => void;

const listeners = new Set<Listener>();

/** Subscribe; returns the unsubscribe function. */
export function onCommunityNotification(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The shell emits each fresh (RLS-delivered) notification row here. */
export function emitCommunityNotification(n: BusNotification): void {
  for (const fn of [...listeners]) {
    try {
      fn(n);
    } catch (error) {
      console.error("[community] notification bus listener failed:", error);
    }
  }
}
