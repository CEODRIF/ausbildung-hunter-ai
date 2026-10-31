/**
 * email-sanitize — sanitizeEmailHtml + htmlToText contracts.
 *
 * htmlToText must decode &amp; / &quot; / &#39; EXACTLY ONCE (the plain-text
 * part of e-mails must read "Henkel AG & Co. KGaA", not
 * "Henkel AG &amp; Co. KGaA") and NEVER double-decode. &lt; / &gt; are
 * deliberately kept inertly encoded in the plain text — the defense-in-depth
 * contract pinned by tests/security/xss.test.ts: the text alternative must
 * never contain raw angle brackets.
 */
import { describe, expect, it } from "vitest";
import { htmlToText, sanitizeEmailHtml } from "@/lib/email-sanitize";

describe("htmlToText — entity decoding (exactly one pass)", () => {
  it("decodes &amp;, &quot;, &#39; and &#x27;", () => {
    expect(htmlToText("&amp;")).toBe("&");
    expect(htmlToText("&quot;Angebot&quot;")).toBe('"Angebot"');
    expect(htmlToText("it&#39;s")).toBe("it's");
    expect(htmlToText("it&#x27;s")).toBe("it's");
  });

  it("decodes case-insensitively (&AMP;, &QUOT;)", () => {
    expect(htmlToText("&AMP;")).toBe("&");
    expect(htmlToText("&QUOT;Angebot&QUOT;")).toBe('"Angebot"');
  });

  it("never double-decodes: &amp;X stays the literal text &X", () => {
    // "&amp;quot;" renders as the visible text "&quot;" in a browser — the
    // plain text must match that, and must NOT collapse into '"'.
    expect(htmlToText("&amp;quot;")).toBe("&quot;");
    expect(htmlToText("&amp;amp;")).toBe("&amp;");
    expect(htmlToText("&amp;lt;")).toBe("&lt;");
  });

  it("keeps &lt; / &gt; inertly encoded (security contract: no raw angle brackets in the text part)", () => {
    // Markup that is entity-escaped in a stored body must NOT resurface as
    // raw "<" / ">" text in the plain-text alternative.
    expect(htmlToText("&lt;script&gt;alert(1)&lt;/script&gt;")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(htmlToText("a &lt; b &amp; b &gt; a")).toBe("a &lt; b & b &gt; a");
    const text = htmlToText("&lt;img src=x onerror=alert(1)&gt;");
    expect(text).not.toContain("<");
    expect(text).not.toContain(">");
  });

  it("decodes AFTER stripping markup (a stripped tag can never resurface)", () => {
    expect(htmlToText("<b>Henkel AG &amp; Co. KGaA</b>")).toBe("Henkel AG & Co. KGaA");
    expect(htmlToText("<p onclick='x()'>hi &amp; bye</p>")).toBe("hi & bye");
  });

  it("the real send pipeline: sanitized HTML → human-readable plain text", () => {
    const stored = sanitizeEmailHtml("<p>anbei mein Anschreiben für Henkel AG &amp; Co. KGaA</p>");
    expect(stored).toContain("&amp;"); // the stored HTML stays entity-encoded
    expect(htmlToText(stored)).toBe("anbei mein Anschreiben für Henkel AG & Co. KGaA");
  });

  it("keeps the tag-stripping security contract", () => {
    expect(htmlToText("<script>alert(1)</script>hi")).toBe("hi");
    const text = htmlToText('"><script>alert(1)</script>');
    expect(text).not.toContain("<");
    expect(text).not.toContain(">");
  });

  it("normalizes whitespace; <br> becomes a separator", () => {
    expect(htmlToText("a&nbsp;b<br>c")).toBe("a b c");
    expect(htmlToText("  many   spaces  ")).toBe("many spaces");
  });
});
