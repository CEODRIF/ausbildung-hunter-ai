/**
 * Community chat — Messenger/Facebook-style message alignment (UI only).
 *
 * Proves the alignment contract end to end WITHOUT touching the backend:
 *
 *   1.  current user's message → RIGHT aligned
 *   2.  other user's message   → LEFT aligned
 *   3.  ownership is determined by the STABLE user ID
 *   4.  username/display-name similarity never affects ownership
 *   5.  Arabic (RTL) keeps own=RIGHT / other=LEFT (sender-based, not
 *       direction-based: physical margins + pinned layout direction)
 *   6.  optimistic own message renders RIGHT immediately
 *   7.  realtime/polled incoming from another user renders LEFT
 *   8.  realtime/polled message from the current user renders RIGHT
 *   9.  no horizontal overflow on mobile (width caps + wrapping)
 *   10. reaction pills stay attached to the correct bubble/alignment
 *   11. reply/quote rendering stays functional (jump-to preserved)
 *   12. message API / realtime / 1-second polling are untouched
 *
 * Style: the project's established source-guard pattern (the suite runs in
 * the node environment — no DOM), plus unit tests of the pure ownership +
 * merge functions where a real assertion is possible.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createOptimisticMessage,
  isOwnMessage,
  mergeCommunityMessages,
  type CommunityAuthor,
  type LocalMessage,
} from "@/lib/community";

const ROOT = join(__dirname, "..");
const readSrc = (p: string) => readFileSync(join(ROOT, p), "utf8");

const ME = "6fa45036-1b86-427a-a7d0-54a3a3904767";
const OTHER = "11111111-1111-4111-8111-111111111111";

const rowSrc = readSrc("src/components/community/message-row.tsx");
const roomSrc = readSrc("src/components/community/room-chat.tsx");
const dmSrc = readSrc("src/components/community/dm-chat.tsx");
const mentionSrc = readSrc("src/components/community/mention-text.tsx");

const author = (userId: string, name: string): CommunityAuthor => ({
  user_id: userId,
  display_name: name,
  avatar_id: "avatar-1",
});

const message = (userId: string, id: string, extra?: Partial<LocalMessage>): LocalMessage => ({
  id,
  room_id: "room-1",
  user_id: userId,
  message: "hallo",
  image_path: null,
  reply_to_message_id: null,
  created_at: "2026-10-08T10:00:00Z",
  updated_at: "2026-10-08T10:00:00Z",
  author: null,
  reactions: [],
  replyTo: null,
  ...extra,
});

// ---------------------------------------------------------------------------
// 3 + 4 — ownership is the stable user ID, and ONLY that
// ---------------------------------------------------------------------------

describe("isOwnMessage — sender-based ownership", () => {
  it("1./2./3. own id → own (right), other id → not own (left)", () => {
    expect(isOwnMessage(ME, ME)).toBe(true);
    expect(isOwnMessage(OTHER, ME)).toBe(false);
    expect(isOwnMessage(ME, OTHER)).toBe(false);
  });

  it("3. missing/unknown ids fail closed to 'not own' (left)", () => {
    expect(isOwnMessage(null, ME)).toBe(false);
    expect(isOwnMessage(undefined, ME)).toBe(false);
    expect(isOwnMessage("", ME)).toBe(false);
    expect(isOwnMessage(ME, null)).toBe(false);
    expect(isOwnMessage(ME, "")).toBe(false);
  });

  it("4. username/display-name similarity NEVER affects ownership", () => {
    // ME and OTHER may carry identical display names ("Alex Müller") — the
    // ownership decision still follows the ids:
    expect(isOwnMessage(ME, ME)).toBe(true); // the real me — by id
    expect(isOwnMessage(OTHER, ME)).toBe(false); // impostor sharing the name — by id
    // and the function's signature cannot even be GIVEN a name:
    expect(isOwnMessage.length).toBe(2); // exactly (messageUserId, currentUserId)
  });
});

// ---------------------------------------------------------------------------
// 6 — optimistic own message is immediately RIGHT
// ---------------------------------------------------------------------------

describe("optimistic send", () => {
  it("6. the optimistic row carries MY stable id → isOwnMessage true → right", () => {
    const optimistic = createOptimisticMessage({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      roomId: "room-1",
      user: author(ME, "Me"),
      text: "just sent",
      imagePath: null,
      replyToMessageId: null,
      createdAt: new Date().toISOString(),
    });
    expect(optimistic.user_id).toBe(ME);
    expect(isOwnMessage(optimistic.user_id, ME)).toBe(true);
    expect(optimistic.sendStatus).toBe("sending");
  });

  it("room-chat builds the optimistic row with myAuthor (id-based)", () => {
    expect(roomSrc).toContain("createOptimisticMessage({");
    expect(roomSrc).toContain("user: myAuthor,");
    // and the render map derives `mine` from the helper, not from a name
    expect(roomSrc).toContain("const mine = isOwnMessage(m.user_id, me.userId);");
  });
});

// ---------------------------------------------------------------------------
// 7 + 8 — realtime/polling rows land on the side of their AUTHOR
// ---------------------------------------------------------------------------

describe("realtime + 1s polling ingestion", () => {
  it("7. a polled/realtime row from ANOTHER user → not own → left", () => {
    const incoming = message(OTHER, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(isOwnMessage(incoming.user_id, ME)).toBe(false);
  });

  it("8. a polled/realtime row from the CURRENT user → own → right", () => {
    const incoming = message(ME, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    expect(isOwnMessage(incoming.user_id, ME)).toBe(true);
  });

  it("7./8. the realtime handler does NOT rewrite the author id (the server row wins)", () => {
    // realtime INSERT rows are stored with their payload fields intact —
    // only author/reactions/replyTo are backfilled, user_id is untouched:
    expect(roomSrc).toContain("[{ ...incoming, author: null, reactions: [], replyTo: null }]");
    // and a server POST response row likewise keeps data.message.user_id:
    expect(roomSrc).toContain("...data.message,");
  });

  it("no duplication + no side-jump: merge keeps ONE row and the stable id", () => {
    const optimistic = message(ME, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", { sendStatus: "sending" });
    const serverRow = message(ME, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", {
      sendStatus: undefined,
    }) as LocalMessage;
    const merged = mergeCommunityMessages([optimistic], [serverRow], { preferIncoming: true });
    expect(merged).toHaveLength(1); // dedup by the stable id — no second bubble
    expect(merged[0].user_id).toBe(ME); // id unchanged → same side (right)
    expect(isOwnMessage(merged[0].user_id, ME)).toBe(true);

    // an OTHER user's row can never be merged into my side:
    const theirRow = message(OTHER, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
    const merged2 = mergeCommunityMessages([], [theirRow]);
    expect(isOwnMessage(merged2[0].user_id, ME)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 1 + 2 + 5 — the rendered alignment classes (source guards)
// ---------------------------------------------------------------------------

describe("MessageRow — messenger alignment rendering", () => {
  it("1. own rows align RIGHT via PHYSICAL margin (ml-auto) + blue bubble + white text", () => {
    // the single alignment decision in the component:
    expect(rowSrc).toContain('mine ? "ml-auto" : "mr-auto"');
    // messenger geometry: own = saturated blue (the app's semantic blue
    // token), white text, tighter OUTER (bottom-right) corner:
    expect(rowSrc).toContain("rounded-2xl rounded-br-md bg-accent");
    expect(rowSrc).toContain('mine ? "text-white" : "text-ink"');
  });

  it("2. other rows align LEFT (mr-auto) with the neutral surface + avatar on the left", () => {
    expect(rowSrc).toContain("rounded-2xl rounded-bl-md bg-surface-2");
    // avatar renders for others only, in the pinned (physical) start slot:
    expect(rowSrc).toContain("{!mine && avatar}");
  });

  it("5. RTL stability: physical margins + pinned layout direction, no logical/align-self tricks", () => {
    // the cluster pins its physical direction so the avatar/content ORDER
    // and the auto margins never flip under dir="rtl" (Arabic):
    expect(rowSrc).toContain("[direction:ltr]");
    // ...and the message TEXT re-establishes its own bidi flow:
    expect(rowSrc).toContain('dir="auto"');
    // nothing direction-dependent may drive the side:
    expect(rowSrc).not.toMatch(/self-end|self-start|align-self/);
    expect(rowSrc).not.toMatch(/ms-auto|me-auto/);
    expect(rowSrc).not.toContain("rtl:ml-auto");
    expect(rowSrc).not.toContain("rtl:mr-auto");
  });

  it("grouping: tight 2px stack, avatar only on the group head, no spacer column", () => {
    expect(rowSrc).toContain('firstOfGroup ? "mt-2.5 first:mt-0" : "mt-[2px]"');
    // the old full-width avatar SPACER (w-10 for non-first rows) is gone —
    // grouped bubbles stack edge-to-edge (tighter spacing):
    expect(rowSrc).not.toContain('<span className="w-10 shrink-0" aria-hidden="true" />');
  });

  it("own rows skip the repeated username; the timestamp moves under the bubble", () => {
    // name+time header is other-only:
    expect(rowSrc).toContain("{firstOfGroup && !mine && (");
    // own timestamp lives in the right-aligned meta row under the bubble:
    expect(rowSrc).toContain('{mine && (');
    expect(rowSrc).toContain("justify-end gap-1 px-0.5");
  });
});

// ---------------------------------------------------------------------------
// 9 — no horizontal overflow on mobile
// ---------------------------------------------------------------------------

describe("mobile overflow safety", () => {
  it("9. the cluster is width-capped (78% mobile → tighter on desktop) and everything wraps", () => {
    expect(rowSrc).toContain("w-fit");
    expect(rowSrc).toContain("max-w-[78%] md:max-w-[68%] lg:max-w-[56%]");
    // text wraps inside the cap:
    expect(rowSrc).toContain("min-w-0");
    expect(rowSrc).toContain("whitespace-pre-wrap");
    expect(rowSrc).toContain("break-words");
    // images are capped too:
    expect(rowSrc).toContain("max-h-60 w-auto max-w-full object-contain");
  });
});

// ---------------------------------------------------------------------------
// 10 + 11 — reactions + replies stay attached to the correct message
// ---------------------------------------------------------------------------

describe("reactions and replies follow the bubble", () => {
  it("10. reaction pills render inside the aligned row and follow the side (justify-end for own)", () => {
    // the reaction container is part of MessageRow (nothing can detach it):
    expect(rowSrc).toContain('aria-label={t("community.reactionAria")}');
    expect(rowSrc).toContain('className={`mt-1 flex flex-wrap gap-1 ${mine ? "justify-end" : ""}`}');
    // toggling still targets the row's own message id:
    expect(rowSrc).toContain("onToggleReaction(m.id, r.emoji)");
  });

  it("11. reply/quote stays inside the bubble and the jump-to behavior is intact", () => {
    expect(rowSrc).toContain("m.replyTo && (");
    expect(rowSrc).toContain("onJumpToMessage(m.replyTo!.id)");
    expect(rowSrc).toContain('aria-label={t("community.replyToLabel", { name: replyAuthorName })}');
    // the quoted author is still resolved by id (you vs. named member):
    expect(rowSrc).toContain("m.replyTo.user_id === m.user_id");
    // the quote adapts to the bubble tone (white-on-blue for own):
    expect(rowSrc).toContain("border-white/60 bg-white/15 text-white hover:bg-white/25");
  });
});

// ---------------------------------------------------------------------------
// mention chips stay readable inside the blue own bubble
// ---------------------------------------------------------------------------

describe("mention chips on the accent bubble", () => {
  it("tone='on-accent' renders white-on-glass chips; default is unchanged", () => {
    expect(mentionSrc).toContain('tone?: "default" | "on-accent"');
    expect(mentionSrc).toContain("bg-white/25 text-white");
    expect(mentionSrc).toContain("bg-accent-soft text-accent"); // default kept
    // links keep working (currentColor → white in the own bubble):
    expect(mentionSrc).toContain("decoration-current");
    // the own bubble passes the tone:
    expect(rowSrc).toContain('tone={mine ? "on-accent" : undefined}');
  });
});

// ---------------------------------------------------------------------------
// 12 — backend contract untouched
// ---------------------------------------------------------------------------

describe("message API / realtime / 1s polling untouched", () => {
  it("the 1-second authoritative polling tick is still there", () => {
    expect(roomSrc).toContain("timer = window.setInterval(tick, 1000);");
  });

  it("the realtime channel subscription is still there (per-room, deduped)", () => {
    expect(roomSrc).toContain(".channel(`community-room:${room.id}`)");
    expect(roomSrc).toContain("const dup = knownIds.current.has(incoming.id);");
    expect(roomSrc).toContain("knownIds.current.add(incoming.id);");
  });

  it("still loads/sends through the SAME community message endpoints", () => {
    // list (incl. the 1s poll tick with ?poll=1), load-older, send, edit:
    expect(roomSrc).toContain(
      "`/api/community/messages?room=${encodeURIComponent(room.slug)}&poll=1`",
    );
    expect(roomSrc).toContain('"/api/community/messages", {');
    expect(roomSrc).toContain("mergeCommunityMessages(prev, [serverRow], { preferIncoming: true })");
  });

  it("no new data source was introduced (the browser client usage is unchanged)", () => {
    // room-chat still has exactly ONE supabase read (image signing) — the
    // alignment work added no queries (same invariant as the typing guard):
    expect(roomSrc.match(/\.from\(/g)).toHaveLength(1);
  });

  it("the DM chat reuses the SAME row component + ownership helper (no second chat implementation)", () => {
    expect(dmSrc).toContain('from "./message-row"');
    expect(dmSrc).toContain("const mine = isOwnMessage(m.user_id, me.userId);");
  });
});
