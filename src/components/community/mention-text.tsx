"use client";

import { Fragment } from "react";

/**
 * Community message text — SAFE rendering of mentions + links.
 *
 * The message body is never rendered as HTML (XSS). Instead the raw text is
 * tokenised into exactly three kinds:
 *   - text    → plain React text nodes (the default, exactly like before)
 *   - mention → `@Username`; styled as a chip ONLY when it matches a known
 *               member (case-insensitive); unknown tokens stay plain text
 *   - link    → http(s) URLs → a real <a> (rel="noopener noreferrer");
 *               every other scheme is left as plain text
 *
 * The tokenizer is pure and unit-tested (tests/community.test.ts —
 * "extractMentionUsernames" + the safe-rendering source guard).
 */

export interface MessageToken {
  kind: "text" | "mention" | "link";
  /** Raw text: the text itself / the username WITHOUT the @ / the URL. */
  value: string;
  /** mention only: matches a known member (case-insensitive). */
  known?: boolean;
}

/** A mention: word boundary (start/whitespace/open-punct) + @ + 3–24 chars. */
const MENTION_RE = /(?<=^|[\s([{>"'])@([A-Za-z][A-Za-z0-9]{1,23})/g;
/** Plain http(s) URLs — the only linkable scheme. */
const LINK_RE = /https?:\/\/[^\s<>"')\]]+/g;

/**
 * Split a message body into render tokens. Deterministic, allocation-light,
 * and safe: no HTML is parsed or produced. Mentions inside a URL are ignored
 * (the URL wins), and a mention never matches inside a longer word.
 */
export function tokenizeMessage(
  text: string,
  knownMembers: ReadonlySet<string>,
): MessageToken[] {
  const tokens: MessageToken[] = [];
  if (!text) return tokens;

  const spans: Array<{ start: number; end: number; token: MessageToken }> = [];

  for (const m of text.matchAll(LINK_RE)) {
    spans.push({
      start: m.index,
      end: m.index + m[0].length,
      token: { kind: "link", value: m[0] },
    });
  }
  for (const m of text.matchAll(MENTION_RE)) {
    const start = m.index; // points at the "@" (lookbehind is zero-width)
    const end = start + 1 + m[1].length;
    const insideLink = spans.some((s) => start >= s.start && end <= s.end);
    if (insideLink) continue;
    spans.push({
      start,
      end,
      token: {
        kind: "mention",
        value: m[1],
        known: knownMembers.has(m[1].toLowerCase()),
      },
    });
  }

  spans.sort((a, b) => a.start - b.start);
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) {
      tokens.push({ kind: "text", value: text.slice(cursor, span.start) });
    }
    tokens.push(span.token);
    cursor = span.end;
  }
  if (cursor < text.length) {
    tokens.push({ kind: "text", value: text.slice(cursor) });
  }
  return tokens;
}

export interface MentionTextProps {
  text: string;
  /** Lower-cased member usernames (from the members list / author cache). */
  knownMembers: ReadonlySet<string>;
  /** Clicking a KNOWN mention (member list / profile in later phases). */
  onMentionClick?: (username: string) => void;
  /** Extra classes for the text container (color, size). */
  className?: string;
  /**
   * "on-accent": mention chips rendered legible on a saturated bubble
   * (own messages, Messenger-style blue) instead of the light-surface
   * default. Links are unaffected (they inherit the bubble text color).
   */
  tone?: "default" | "on-accent";
}

/**
 * Render a message body as safe text + mention chips + links.
 * `aria-label` mirrors the raw text so screen readers get the message as
 * one continuous string (the chips would otherwise be read out of order).
 */
export function MentionText({
  text,
  knownMembers,
  onMentionClick,
  className,
  tone = "default",
}: MentionTextProps) {
  const tokens = tokenizeMessage(text, knownMembers);
  return (
    <span aria-label={text} className={className}>
      {tokens.map((token, i) => {
        if (token.kind === "text") return <Fragment key={i}>{token.value}</Fragment>;
        if (token.kind === "link") {
          return (
            <a
              key={i}
              href={token.value}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all underline decoration-current underline-offset-2 opacity-95"
            >
              {token.value}
            </a>
          );
        }
        if (!token.known) {
          // Not a member (or unknown yet) — render as plain text, no chip.
          return <Fragment key={i}>@{token.value}</Fragment>;
        }
        const chip = (
          <span
            className={`rounded-md px-0.5 font-semibold ${
              tone === "on-accent"
                ? "bg-white/25 text-white"
                : "bg-accent-soft text-accent"
            }`}
          >
            @{token.value}
          </span>
        );
        return onMentionClick ? (
          <button
            key={i}
            type="button"
            onClick={() => onMentionClick(token.value)}
            aria-label={`@${token.value}`}
            className="border-0 bg-transparent p-0"
          >
            <span className="hover:underline">{chip}</span>
          </button>
        ) : (
          <Fragment key={i}>{chip}</Fragment>
        );
      })}
    </span>
  );
}
