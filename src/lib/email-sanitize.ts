import sanitizeHtml from "sanitize-html";

/**
 * ISOMORPHIC e-mail HTML sanitization (safe on server AND client).
 *
 * This is the single source of truth for the e-mail body allowlist used by the
 * AUTO BEWERB Step 6 rich-text editor preview (client) and the send pipeline
 * (server, defense in depth). It intentionally has NO server-only imports so
 * it can run in a client component. `@/lib/application-drafts` re-exports it.
 *
 * The allowlist is deliberately tight: basic block/inline formatting, lists,
 * and safe links (http/https/mailto, forced rel=noopener). Everything else
 * (scripts, event handlers, iframes, javascript: URLs, …) is stripped.
 */
export function sanitizeEmailHtml(html: string) {
  return sanitizeHtml(html, {
    allowedTags: [
      "p",
      "br",
      "strong",
      "b",
      "em",
      "i",
      "u",
      "ul",
      "ol",
      "li",
      "a",
      "div",
      "span",
      "font",
    ],
    allowedAttributes: {
      a: ["href", "target", "rel"],
      span: ["style"],
      font: ["color", "size"],
    },
    allowedStyles: {
      span: {
        color: [/^#[0-9a-f]{3,8}$/i, /^rgb\(/i],
        "background-color": [/^#[0-9a-f]{3,8}$/i, /^rgb\(/i],
        "text-align": [/^(left|center|right|justify)$/],
      },
    },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: (_tag, attribs) => ({
        tagName: "a",
        attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer" },
      }),
    },
  });
}

/** Plain-text fallback for an e-mail body: sanitize-html strips ALL tags
 *  first (nothing executable can survive), then the named entities are
 *  decoded ONCE so the text reads naturally ("Henkel AG & Co. KGaA", not
 *  "Henkel AG &amp; Co. KGaA").
 *
 *  Decode order: &quot; / &#39; / &#x27; FIRST, &amp; LAST — so "&amp;quot;"
 *  yields the literal text "&quot;" (exactly one decode, like a browser) and
 *  is never a second pass into '"'.
 *
 *  SECURITY DELIBERATION: &lt; / &gt; are intentionally NOT decoded. The
 *  plain-text part must never contain raw angle brackets — tests/security/
 *  xss.test.ts pins this defense-in-depth contract ("no markup can survive"
 *  in the text alternative). Decoding them would let markup that was safely
 *  entity-escaped in a stored body resurface as raw "<"/">" text. They stay
 *  inertly encoded there. The result is display text only: no consumer may
 *  feed it back into an HTML sink. */
export function htmlToText(html: string) {
  return sanitizeHtml(html.replace(/<br\s*\/?>/gi, " "), { allowedTags: [], allowedAttributes: {} })
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}
