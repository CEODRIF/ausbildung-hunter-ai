/**
 * Community chat — mobile layout / keyboard contracts.
 *
 * Physically simulating an iOS keyboard needs a real browser, which this repo's
 * test environment (node, no jsdom) does not provide. What IS verifiable — and
 * what actually regressed before — is the structural contract that makes the
 * Messenger-like behaviour possible, so it is pinned here:
 *
 *   shell column: exactly the viewport (dvh) + min-h-0 + overflow-hidden
 *   main:         min-h-0 + overflow-hidden  → the page itself never scrolls
 *   chat root:    h-full min-h-0 flex column + --kb reservation
 *   message list: the ONLY scroller (h-full min-h-0 overflow-y-auto)
 *   composer:     shrink-0, sits above the bottom nav / the keyboard
 *
 * Plus the hard product rules: no reload, no polling, and the images/security
 * pipeline untouched.
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

const chatSrc = readSrc("src/components/community-chat.tsx");
const shellSrc = readSrc("src/components/app-shell.tsx");
const layoutSrc = readSrc("src/app/community/layout.tsx");

describe("chat height chain (only the message list scrolls)", () => {
  it("bounds the shell column and main to the viewport in fill mode", () => {
    expect(shellSrc).toContain("fill?: boolean;");
    expect(shellSrc).toMatch(/fill \? "h-\[100dvh\] min-h-0 overflow-hidden"/);
    expect(shellSrc).toMatch(/fill \? "min-h-0 overflow-hidden"/);
    // …and the phone reclaims the space the legal footer used to reserve.
    expect(shellSrc).toMatch(/fill \? "max-lg:hidden"/);
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
    expect(shellSrc).toContain("h-[100dvh]");
  });
});

describe("iOS keyboard handling", () => {
  it("reserves the keyboard height from visualViewport on the chat root", () => {
    expect(chatSrc).toContain("window.visualViewport");
    expect(chatSrc).toContain('root.style.setProperty("--kb"');
    expect(chatSrc).toContain('style={{ paddingBottom: "var(--kb, 0px)" }}');
    expect(chatSrc).toContain('vv.addEventListener("resize"');
    expect(chatSrc).toContain('vv.removeEventListener("resize"');
    expect(chatSrc).toContain('root.style.removeProperty("--kb")');
  });

  it("keeps the newest message visible while the keyboard is open", () => {
    const keyboardBlock = chatSrc.slice(
      chatSrc.indexOf("const onViewportChange"),
      chatSrc.indexOf('vv.removeEventListener("resize"'),
    );
    expect(keyboardBlock).toContain("stickToBottom.current = true");
    expect(keyboardBlock).toContain("el.scrollTop = el.scrollHeight");
    expect(keyboardBlock).toContain("if (measure() <= 0) return");
  });
});

describe("Messenger-like scrolling", () => {
  it("offers a COUNTED 'new messages' pill instead of yanking the reader down", () => {
    expect(chatSrc).toContain("const [newCount, setNewCount] = useState(0)");
    expect(chatSrc).toContain("if (!dup && !stickToBottom.current) setNewCount((c) => c + 1)");
    expect(chatSrc).toContain('t("community.newMessagesCount", { count: newCount })');
    expect(chatSrc).toContain("jumpToLatest");
  });

  it("clears the pill once the reader is back at the bottom", () => {
    expect(chatSrc).toContain("if (atBottom) setNewCount(0)");
  });

  it("never reloads the page and never polls as a delivery mechanism", () => {
    expect(chatSrc).not.toMatch(/location\.reload|window\.location\.reload|router\.refresh\(\)/);
    // The only timer allowed is the LOCAL (in-memory) typing-state prune —
    // no interval may ever touch the network (that would be polling).
    expect(chatSrc.match(/setInterval\(/g)).toHaveLength(1);
    expect(chatSrc).toContain(
      "window.setInterval(refreshTyping, TYPING_PRUNE_INTERVAL_MS)",
    );
    expect(chatSrc).not.toMatch(/setInterval\([^)]*fetch/);
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
    expect(chatSrc).toContain("disabled={submitting ||");
    expect(chatSrc).toContain("if (inFlightRef.current.has(m.id)) return;");
  });

  it("dedupes realtime echoes + POST responses through the stable message id", () => {
    // The INSERT handler merges with preferIncoming (server row wins on id
    // collision — a duplicate echo can never create a second row, it only
    // proves the send persisted: the row flips to "sent").
    expect(chatSrc).toContain("const dup = knownIds.current.has(incoming.id);");
    expect(chatSrc).toContain(
      "mergeCommunityMessages(prev, [{ ...incoming, author: null }], {",
    );
    expect(chatSrc).toContain("preferIncoming: true");
    expect(chatSrc).toContain(
      "mergeCommunityMessages(prev, [serverRow], { preferIncoming: true }),",
    );
  });

  it("resyncs after a reconnect and when the phone comes back to the foreground", () => {
    // (and clears the stale typing state that the gap may have left behind)
    expect(chatSrc).toMatch(
      /if \(sawDisconnected\.current\) \{\s*void resyncRecent\(\);\s*clearTyping\(\);/,
    );
    expect(chatSrc).toContain('document.addEventListener("visibilitychange"');
  });
});

describe("realtime session wiring (production root-cause guard)", () => {
  it("attaches the user JWT to the realtime socket BEFORE joining the channel", () => {
    // Without auth.initialize() the browser socket has no user JWT and the
    // RLS-filtered postgres INSERT stream delivers ZERO rows — the message
    // "only appears after refresh" bug.
    expect(chatSrc).toContain("await client.auth.initialize()");
    expect(chatSrc).toContain("client.realtime.setAuth(session.access_token)");
    // …and the join happens after the token is attached, inside the same
    // async bootstrap (subscribeChannel is only called after setAuth).
    const rtEffect = chatSrc.slice(
      chatSrc.indexOf("const subscribeChannel = () =>"),
      chatSrc.indexOf("return () => {", chatSrc.indexOf("const subscribeChannel = () =>")),
    );
    expect(rtEffect.indexOf("client.realtime.setAuth(session.access_token)")).toBeLessThan(
      rtEffect.indexOf("subscribeChannel();"),
    );
  });

  it("keeps the socket token fresh across refreshes and sign-out", () => {
    expect(chatSrc).toContain("client.auth.onAuthStateChange");
    expect(chatSrc).toContain("client.realtime.setAuth();");
  });

  it("NEVER joins a channel without a JWT (RLS-backed realtime would stream zero rows)", () => {
    // Fast path: the join sits INSIDE the token guard — no token, no join.
    const rtEffect = chatSrc.slice(
      chatSrc.indexOf("const subscribeChannel = () =>"),
      chatSrc.indexOf("return () => {", chatSrc.indexOf("const subscribeChannel = () =>")),
    );
    expect(rtEffect).toContain("if (session?.access_token) {");
    // Slow path: while the session is still restoring, INITIAL_SESSION /
    // SIGNED_IN attach the token and THEN join (same guarded function).
    expect(rtEffect).toContain(
      'if (event === "INITIAL_SESSION" || event === "SIGNED_IN") subscribeChannel();',
    );
  });

  it("creates at most ONE channel per mount (idempotent subscribe, single call site)", () => {
    // The join is id-guarded: a second call (late auth event, StrictMode
    // double-effect, whatever) is a no-op.
    expect(chatSrc).toContain("if (disposed || channel) return;");
    // Exactly one .channel() call site for the message channel — the typing
    // indicator rides the same channel (broadcast), never a second one.
    expect(chatSrc.match(/\.channel\(/g)).toHaveLength(1);
    expect(chatSrc).toContain('.channel("community-messages")');
    // And unmount tears it down.
    expect(chatSrc).toContain("if (channel) void client.removeChannel(channel);");
  });
});

describe("image pipeline and security untouched", () => {
  it("still validates type and size client-side and posts the same form", () => {
    expect(chatSrc).toContain("COMMUNITY_IMAGE_MIMES");
    expect(chatSrc).toContain("COMMUNITY_MAX_IMAGE_BYTES");
    expect(chatSrc).toContain('form.set("image", p.file, "image")');
  });

  it("still renders message text as plain text (memoized row component)", () => {
    expect(chatSrc).not.toContain("dangerouslySetInnerHTML");
    const rowSrc = readSrc("src/components/community-message-row.tsx");
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
