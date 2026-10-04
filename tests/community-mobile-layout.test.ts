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
  it("offers a 'new messages' pill instead of yanking the reader down", () => {
    expect(chatSrc).toContain("const [newBelow, setNewBelow] = useState(false)");
    expect(chatSrc).toContain("if (!stickToBottom.current) setNewBelow(true)");
    expect(chatSrc).toContain('t("community.newMessages")');
    expect(chatSrc).toContain("jumpToLatest");
  });

  it("clears the pill once the reader is back at the bottom", () => {
    expect(chatSrc).toContain("if (atBottom) setNewBelow(false)");
  });

  it("never reloads the page and never polls as a delivery mechanism", () => {
    expect(chatSrc).not.toMatch(/location\.reload|window\.location\.reload|router\.refresh\(\)/);
    expect(chatSrc).not.toMatch(/setInterval\(/);
  });
});

describe("send + realtime delivery contract", () => {
  it("adds the server row to local state (no refresh needed for the sender)", () => {
    expect(chatSrc).toContain("mergeCommunityMessages(prev, [view])");
    expect(chatSrc).toContain("knownIds.current.add(view.id)");
  });

  it("only adds after a successful response, and reports failures", () => {
    const sendBlock = chatSrc.slice(
      chatSrc.indexOf("const send = useCallback"),
      chatSrc.indexOf("const onTextKeyDown"),
    );
    expect(sendBlock).toContain("if (!response.ok)");
    expect(sendBlock).toContain('setSendError("send_failed")');
    // the local add happens after the ok-check, never before
    expect(sendBlock.indexOf("if (!response.ok)")).toBeLessThan(
      sendBlock.indexOf("mergeCommunityMessages(prev, [view])"),
    );
  });

  it("blocks double submits while sending", () => {
    expect(chatSrc).toContain("if (sending) return;");
    expect(chatSrc).toContain("disabled={sending ||");
  });

  it("dedupes realtime echoes through the message id", () => {
    expect(chatSrc).toContain("if (!incoming?.id || knownIds.current.has(incoming.id)) return;");
  });

  it("resyncs after a reconnect and when the phone comes back to the foreground", () => {
    expect(chatSrc).toContain("if (sawDisconnected.current) void resyncRecent();");
    expect(chatSrc).toContain('document.addEventListener("visibilitychange"');
  });
});

describe("image pipeline and security untouched", () => {
  it("still validates type and size client-side and posts the same form", () => {
    expect(chatSrc).toContain("COMMUNITY_IMAGE_MIMES");
    expect(chatSrc).toContain("COMMUNITY_MAX_IMAGE_BYTES");
    expect(chatSrc).toContain('form.set("image", pendingImage.file, "image")');
  });

  it("still renders message text as plain text", () => {
    expect(chatSrc).not.toContain("dangerouslySetInnerHTML");
    expect(chatSrc).toContain("whitespace-pre-wrap");
    expect(chatSrc).toContain("break-words");
  });
});

describe("new-messages copy in every language", () => {
  it("resolves community.newMessages in de/en/fr/ar", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(lookup(dictionaries[lang], "community.newMessages")).toBeTruthy();
    }
  });
});
