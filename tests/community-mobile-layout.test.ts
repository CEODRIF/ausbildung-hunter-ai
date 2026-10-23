/**
 * Community v2 (rooms) — mobile layout / keyboard contracts.
 *
 * Physically simulating an iOS keyboard needs a real browser, which this repo's
 * test environment (node, no jsdom) does not provide. What IS verifiable — and
 * what actually regressed before — is the structural contract that makes the
 * Messenger-like behaviour possible, so it is pinned here:
 *
 *   shell column: exactly the viewport (dvh) + min-h-0 + overflow-hidden
 *   main (fill):  relative + min-h-0 + overflow-hidden (positioned box,
 *                 NO padding) + a flex-sibling h-28 spacer that reserves
 *                 the fixed bottom nav → main's box ends where the nav starts
 *   community shell: absolute inset-0 flex — owns the --kb keyboard
 *                    reservation on the WHOLE community surface (room nav,
 *                    chat, members panel all stay above the keyboard)
 *   chat root:    absolute inset-0 flex column (ZERO percentage-height
 *                 resolution — iOS Safari used to collapse `h-full` against
 *                 the flex-1 main and clip the composer below the fold)
 *   message list: the ONLY scroller (h-full min-h-0 overflow-y-auto)
 *   composer:     shrink-0, always last in the flex column → sits above the
 *                 bottom nav and, with the keyboard open, above the keyboard
 *
 * Plus the hard product rules: no page reload, delivery via realtime + ONE
 * controlled 1s poll (the mobile fallback), the voice modal as a
 * viewport-level centered dialog (not a bottom sheet under the nav), and the
 * images/security pipeline untouched.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { dictionaries, SUPPORTED_LANGUAGES } from "@/lib/i18n/dictionaries";
import { lookup } from "@/lib/i18n/core";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const readSrc = (relative: string) =>
  readFileSync(resolve(root, relative), "utf8");

const chatSrc = readSrc("src/components/community/room-chat.tsx");
const shellSrc = readSrc("src/components/community/community-shell.tsx");
const appShellSrc = readSrc("src/components/app-shell.tsx");
const layoutSrc = readSrc("src/app/community/layout.tsx");
const composerSrc = readSrc("src/components/community/composer.tsx");

describe("chat height chain (only the message list scrolls)", () => {
  it("bounds the shell column to the viewport in fill mode", () => {
    expect(appShellSrc).toContain("fill?: boolean;");
    expect(appShellSrc).toMatch(/fill \? "h-\[100dvh\] min-h-0 overflow-hidden"/);
    // …and the phone reclaims the space the legal footer used to reserve.
    expect(appShellSrc).toMatch(/fill \? "max-lg:hidden"/);
  });

  it("makes main a positioned, padding-free chat box in fill mode", () => {
    // `relative` is the containing block for the shell root's `absolute
    // inset-0`; `min-h-0 overflow-hidden` bounds it. NO padding here — the
    // bottom-nav reservation moved to a sibling spacer (below), so main's
    // box is EXACTLY the visible zone between the top bar and the nav.
    expect(appShellSrc).toMatch(/fill \? "relative min-h-0 overflow-hidden"/);
    // Normal routes keep the document-scroll shell untouched.
    expect(appShellSrc).toMatch(/: "pb-28 lg:pb-0"/);
  });

  it("reserves the fixed bottom nav as a flex sibling so it never covers the composer", () => {
    // Same 112px (h-28) as the old pb-28, now a real flex item: main's box
    // ends exactly where the floating nav begins. Phones only (max-lg),
    // fill routes only.
    expect(appShellSrc).toContain('{fill && <div aria-hidden className="h-28 max-lg:block shrink-0" />}');
    // The nav stays the same floating glass bar (z-30, bottom-3) — only its
    // reservation moved.
    expect(appShellSrc).toMatch(/fixed inset-x-3 bottom-3 z-30/);
  });

  it("fills main with absolute inset-0 — zero percentage-height resolution (iOS fix)", () => {
    // The composer-disappearing-on-iPhone bug: `h-full` (height:100%)
    // against the flex-1 <main> collapsed in iOS Safari, so the flex column
    // grew to content height and the composer was clipped below the fold.
    // `absolute inset-0` against the positioned main needs no percentage
    // resolution at all — it fills the definite box on every engine.
    // v2: the COMMUNITY SHELL owns the fill (room nav + chat + members).
    expect(shellSrc).toContain('className="absolute inset-0 flex min-h-0"');
    expect(chatSrc).toContain('className="absolute inset-0 flex min-h-0 flex-col"');
    expect(chatSrc).not.toContain('className="flex h-full min-h-0 w-full flex-col"');
    // …and the chat root itself must never become a scroller.
    expect(chatSrc).not.toMatch(/absolute inset-0[^\"]*overflow-y-auto/);
  });

  it("the /community layout opts into fill mode", () => {
    expect(layoutSrc).toMatch(/communityUnread=\{communityUnread\} fill/);
  });

  it("makes the message list the single scroll container", () => {
    expect(chatSrc).toContain('className="relative min-h-0 flex-1"');
    expect(chatSrc).toContain('className="h-full min-h-0 overflow-y-auto overscroll-contain"');
  });

  it("keeps the composer pinned (never shrunk, always last)", () => {
    expect(chatSrc).toContain('className="shrink-0 border-t border-line bg-surface/95');
  });

  it("never relies on the legacy 100vh sizing hack", () => {
    // dvh (dynamic viewport height) is used instead, so Safari's collapsing
    // browser chrome cannot cut the composer off.
    const legacy = /h-\[100vh\]|min-h-\[100vh\]|height:\s*100vh|max-h-\[100vh\]/;
    expect(chatSrc).not.toMatch(legacy);
    expect(shellSrc).not.toMatch(legacy);
    expect(appShellSrc).not.toMatch(legacy);
    expect(appShellSrc).toContain("h-[100dvh]");
  });
});

describe("iOS keyboard handling", () => {
  it("reserves the keyboard height from visualViewport on the SHELL (v2: sole owner)", () => {
    // The reservation lives on the community shell root, so room nav, chat
    // AND the members panel all stay above the keyboard — and the chat root
    // must not add a SECOND reservation.
    expect(shellSrc).toContain("window.visualViewport");
    expect(shellSrc).toContain('root.style.setProperty("--kb"');
    expect(shellSrc).toContain('style={{ paddingBottom: "var(--kb, 0px)" }}');
    expect(shellSrc).toContain('vv.addEventListener("resize"');
    expect(shellSrc).toContain('vv.removeEventListener("resize"');
    expect(shellSrc).toContain('root.style.removeProperty("--kb")');
    // The chat root owns NO keyboard reservation of its own (single owner).
    expect(chatSrc).not.toContain('root.style.setProperty("--kb"');
    expect(chatSrc).not.toContain('style={{ paddingBottom: "var(--kb, 0px)" }}');
  });

  it("keeps the newest message visible while the keyboard is open (chat-side effect)", () => {
    // The chat's visualViewport listener is SCROLL-ONLY: it pins the list to
    // the bottom while typing, it never writes layout CSS.
    const keyboardBlock = chatSrc.slice(
      chatSrc.indexOf("const onViewportChange"),
      chatSrc.indexOf('vv.removeEventListener("resize"'),
    );
    expect(keyboardBlock).toContain("stickToBottom.current = true");
    expect(keyboardBlock).toContain("el.scrollTop = el.scrollHeight");
    expect(keyboardBlock).toContain("if (covered <= 0) return;");
    expect(keyboardBlock).not.toContain("--kb");
  });
});

describe("Messenger-like scrolling", () => {
  it("offers a COUNTED 'new messages' pill instead of yanking the reader down", () => {
    expect(chatSrc).toContain("const [newCount, setNewCount] = useState(0)");
    // The batched INSERT applier counts only genuinely NEW rows (the echo of
    // our own send is a dup) and only when the reader is NOT at the bottom.
    expect(chatSrc).toContain(
      "if (appended > 0 && !stickToBottom.current) setNewCount((c) => c + appended);",
    );
    expect(chatSrc).toContain('t("community.newMessagesCount", { count: newCount })');
    expect(chatSrc).toContain("jumpToLatest");
  });

  it("clears the pill once the reader is back at the bottom", () => {
    expect(chatSrc).toContain("if (atBottom) setNewCount(0)");
  });

  it("never reloads the page; delivery is pure realtime (no polling)", () => {
    // Hard rule (unchanged): never a page reload / navigation as a "refresh".
    expect(chatSrc).not.toMatch(/location\.reload|window\.location\.reload|router\.refresh\(\)/);
    // Exactly ONE timer: the in-memory typing-state prune (never touches the
    // network). The old 1s room poll is GONE — Supabase Realtime is the
    // transport; reconnects and visibility returns run ONE targeted sync.
    expect(chatSrc.match(/setInterval\(/g)).toHaveLength(1);
    expect((shellSrc.match(/setInterval\(/g) ?? [])).toHaveLength(0);
    expect(chatSrc).toContain(
      "window.setInterval(refreshTyping, TYPING_PRUNE_INTERVAL_MS)",
    );
    expect(chatSrc).not.toContain("window.setInterval(tick, 1000)");
    // No interval ever inlines a network call.
    expect(chatSrc).not.toMatch(/setInterval\([^)]*fetch/);
  });

  it("catch-up is EVENT-DRIVEN: visibility return + reconnect (ONE targeted sync)", () => {
    // Phones suspend the socket while the tab is hidden; returning performs a
    // single targeted resync (a silent no-op when nothing changed) — no
    // periodic polling while hidden.
    expect(chatSrc).toContain('document.visibilityState !== "visible"');
    expect(chatSrc).toContain('document.addEventListener("visibilitychange", onVisibilityChange)');
    expect(chatSrc).toContain('void resyncRecent("visibility")');
    // The realtime reconnect path runs the same single targeted resync.
    expect(chatSrc).toContain('void resyncRecent("reconnect")');
    // The resync hits ONLY the active room's newest page (poll rate bucket).
    expect(chatSrc).toContain("encodeURIComponent(room.slug)}&poll=1");
  });

  it("the targeted sync is a silent no-op when nothing new/changed (no flash)", () => {
    expect(chatSrc).toContain("if (!changed) return;");
  });
});

describe("send + realtime delivery contract (optimistic UI)", () => {
  it("the optimistic row appears BEFORE the network round-trip", () => {
    const submitBlock = chatSrc.slice(
      chatSrc.indexOf("const submit = useCallback"),
      chatSrc.indexOf("const retryMessage"),
    );
    expect(submitBlock).toContain("const id = crypto.randomUUID()");
    expect(submitBlock).toContain("createOptimisticMessage(");
    expect(submitBlock).toContain("mergeCommunityMessages(prev, [optimistic])");
    // the UI insert happens strictly before the POST is fired
    expect(submitBlock.indexOf("mergeCommunityMessages(prev, [optimistic])")).toBeLessThan(
      submitBlock.indexOf("void postMessage("),
    );
  });

  it("a failed send flips the row to failed and never loses the user's text", () => {
    const postBlock = chatSrc.slice(
      chatSrc.indexOf("const postMessage = useCallback"),
      chatSrc.indexOf("const submit = useCallback"),
    );
    expect(postBlock).toContain("if (!response.ok)");
    expect(postBlock).toContain('setSendStatus(prev, p.id, "failed")');
    // the composer text is restored on failure (bubble + composer, never lost)
    expect(postBlock).toContain("if (p.text) setText(p.text)");
    // retries reuse the SAME id (server-side idempotency)
    expect(postBlock).toContain('form.set("id", p.id)');
    expect(chatSrc).toContain('form.set("message", p.text)');
  });

  it("blocks double submits while a POST is in flight", () => {
    expect(chatSrc).toContain("if (submitting) return;");
    expect(composerSrc).toContain("disabled={submitting ||");
    expect(chatSrc).toContain("if (inFlightRef.current.has(m.id)) return;");
  });

  it("dedupes realtime echoes + POST responses through the stable message id", () => {
    // The INSERT handler merges with preferIncoming (server row wins on id
    // collision — a duplicate echo can never create a second row, it only
    // proves the send persisted: the row flips to "sent").
    expect(chatSrc).toContain("const dup = knownIds.current.has(incoming.id);");
    expect(chatSrc).toContain(
      "[{ ...incoming, author: null, reactions: [], replyTo: null }]",
    );
    expect(chatSrc).toContain("preferIncoming: true");
    expect(chatSrc).toContain(
      "mergeCommunityMessages(prev, [serverRow], { preferIncoming: true }),",
    );
  });

  it("resyncs after a reconnect and when the phone comes back to the foreground", () => {
    // (and clears the stale typing state that the gap may have left behind)
    expect(chatSrc).toContain('void resyncRecent("reconnect");');
    expect(chatSrc).toContain("clearTyping();");
    expect(chatSrc).toContain('document.addEventListener("visibilitychange"');
    expect(chatSrc).toContain('void resyncRecent("visibility");');
  });
});

describe("realtime session wiring (production root-cause guard)", () => {
  // The handshake, the stable channel names, the ref-counted registry and
  // the teardown all live in the ONE shared layer now (every Community
  // surface — rooms, DMs, inbox, friends, notifications — is pinned through
  // it; room-chat only registers its handlers).
  const sharedSrc = readSrc("src/lib/community/conversation-realtime.ts");
  const coreSrc = readSrc("src/lib/community/realtime-core.ts");

  it("attaches the user JWT to the realtime socket BEFORE joining the channel", () => {
    // Without auth.initialize() the browser socket has no user JWT and the
    // RLS-filtered postgres INSERT stream delivers ZERO rows — the message
    // "only appears after refresh" bug.
    expect(sharedSrc).toContain("await client.auth.initialize()");
    expect(sharedSrc).toContain("client.realtime.setAuth(session.access_token)");
    // …and the join (setup) happens only after the token is attached, inside
    // the same async bootstrap:
    const bootstrap = sharedSrc.slice(
      sharedSrc.indexOf("void (async () => {"),
      sharedSrc.indexOf("const authSub ="),
    );
    expect(bootstrap.indexOf("await client.realtime.setAuth(session.access_token)")).toBeGreaterThanOrEqual(0);
    expect(
      bootstrap.indexOf("await client.realtime.setAuth(session.access_token)"),
    ).toBeLessThan(bootstrap.indexOf("if (!disposed) setup();"));
    // …and the room chat is wired through that shared hook:
    expect(chatSrc).toContain("useRoomRealtime(room.id, {");
  });

  it("keeps the socket token fresh across refreshes and sign-out", () => {
    expect(sharedSrc).toContain("client.auth.onAuthStateChange");
    // A refreshed session re-attaches the token and (re)joins; …
    expect(sharedSrc).toContain(
      'if (event === "INITIAL_SESSION" || event === "SIGNED_IN") setup();',
    );
    // …sign-out disposes the wiring (a join is never kept on a dead token).
    expect(sharedSrc).toContain('} else if (event === "SIGNED_OUT" && handle) {');
    expect(sharedSrc).toContain("handle.dispose();");
  });

  it("NEVER joins a channel without a JWT (RLS-backed realtime would stream zero rows)", () => {
    // Fast path: the join sits INSIDE the token guard — no token, no join.
    expect(sharedSrc).toContain("if (session?.access_token) {");
    expect(sharedSrc).toContain("NEVER join without a JWT");
    // Slow path: while the session is still restoring, INITIAL_SESSION /
    // SIGNED_IN attach the token and THEN join (the same guarded setup).
    expect(sharedSrc).toContain(
      'if (event === "INITIAL_SESSION" || event === "SIGNED_IN") setup();',
    );
  });

  it("subscribes a DYNAMIC per-room channel (one per mount, idempotent)", () => {
    // The channel name is DERIVED FROM THE ROOM in the shared naming
    // scheme (postgres_changes filter room_id = eq.<room.id>), so each room
    // gets its own stream and typing/edits/deletes ride the same one — and
    // two mounts of the same room share ONE live channel (ref-counted
    // registry, no duplicate subscriptions).
    expect(sharedSrc).toContain("`community-room:${target.id}`");
    expect(chatSrc).toContain("useRoomRealtime(room.id, {");
    // The join is id-guarded: a second call (late auth event, StrictMode
    // double-effect, whatever) is a no-op.
    expect(sharedSrc).toContain("if (disposed || handle) return;");
    expect(coreSrc).toContain("entry.refs += 1;");
    // And unmount releases the ref (the registry removeChannel's at 0).
    expect(sharedSrc).toContain("registry.release(client, name);");
    expect(coreSrc).toContain("void entry.client.removeChannel(entry.channel);");
  });
});

describe("image pipeline and security untouched", () => {
  it("still validates type and size client-side and posts the same form", () => {
    // The composer filters the picker to the allowed MIME types…
    expect(composerSrc).toContain("COMMUNITY_IMAGE_MIMES");
    // …and the single type+size gate lives in the room chat (one source of
    // truth, with translated error copy).
    expect(chatSrc).toContain("COMMUNITY_IMAGE_MIMES");
    expect(chatSrc).toContain("COMMUNITY_MAX_IMAGE_BYTES");
    expect(chatSrc).toContain('setImageError("invalidImage")');
    expect(chatSrc).toContain('setImageError("imageTooLarge")');
    expect(chatSrc).toContain('form.set("image", p.file, "image")');
  });

  it("still renders message text as plain text (memoized row component)", () => {
    expect(chatSrc).not.toContain("dangerouslySetInnerHTML");
    const rowSrc = readSrc("src/components/community/message-row.tsx");
    expect(rowSrc).not.toContain("dangerouslySetInnerHTML");
    expect(rowSrc).toContain("whitespace-pre-wrap");
    expect(rowSrc).toContain("break-words");
    expect(rowSrc).toContain("memo(");
  });
});

describe("new-messages copy in every language", () => {
  it("resolves community.newMessages in de/en/fr/ar", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(lookup(dictionaries[lang], "community.newMessages")).toBeTruthy();
    }
  });
});

describe("voice modal — viewport-level, centered (not a bottom sheet under the nav)", () => {
  const voiceSrc = readSrc("src/components/community/voice-panel.tsx");

  it("ports the dialog to <body> so no ancestor can mis-anchor it on iOS", () => {
    // A `transform`/`backdrop-filter`/`overflow` ancestor becomes the `fixed`
    // containing block on iOS — the exact production bug. Portaling to body
    // guarantees the overlay is positioned against the real viewport.
    expect(voiceSrc).toContain('import { createPortal } from "react-dom"');
    expect(voiceSrc).toContain("return createPortal(");
    expect(voiceSrc).toContain("document.body");
  });

  it("is a true viewport-level overlay, centered at every width", () => {
    // full-viewport, above content/header(z-20)/nav(z-30)/drawer(z-40)
    expect(voiceSrc).toContain('fixed inset-0 z-50 flex items-center justify-center');
    // The old mobile bottom-dock (items-end / bottom sheet) is gone — no
    // sm: breakpoint split for vertical centering, no bottom-sheet rounding.
    expect(voiceSrc).not.toContain("items-end");
    expect(voiceSrc).not.toContain("rounded-t-2xl");
    expect(voiceSrc).not.toMatch(/sm:items-center/);
    // The dialog body is a rounded rectangle (matches the product mock).
    expect(voiceSrc).toContain("rounded-2xl border border-line bg-surface p-5 shadow-xl");
  });

  it("respects iOS safe-area insets and keeps a full-viewport backdrop", () => {
    // Safe-area padding (notch / home indicator) via env() — never a huge
    // arbitrary bottom margin, never a single hardcoded pixel position.
    expect(voiceSrc).toContain("env(safe-area-inset-top)");
    expect(voiceSrc).toContain("env(safe-area-inset-bottom)");
    expect(voiceSrc).toContain("max(1rem, env(safe-area-inset-bottom))");
    // Backdrop covers the WHOLE viewport (so the bottom nav is dimmed +
    // click-blocked behind it) and closes on outside tap.
    expect(voiceSrc).toContain("fixed inset-0 bg-ink/40");
    expect(voiceSrc).toContain("onClick={voice.closeDialog}");
  });

  it("preserves the dialog semantics and voice states", () => {
    expect(voiceSrc).toContain('role="dialog"');
    expect(voiceSrc).toContain('aria-modal="true"');
    expect(voiceSrc).toContain('aria-labelledby="voice-dialog-title"');
    // All connection states remain rendered: connecting / connected /
    // unavailable / error / mic_denied.
    expect(voiceSrc).toContain('voice.connection === "unavailable"');
    expect(voiceSrc).toContain('voice.connection === "error"');
    expect(voiceSrc).toContain('voice.connection === "mic_denied"');
    expect(voiceSrc).toContain('voice.connection === "connecting"');
  });
});
