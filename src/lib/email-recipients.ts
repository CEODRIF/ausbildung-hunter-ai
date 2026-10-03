/**
 * Shared recipient normalization for EVERY email-list input path of the Email
 * Sender / Email Composer: pasted lists, TXT/CSV upload, drag & drop and the
 * server-side recipient validator that guards draft saving, prefilling and the
 * campaign sender.
 *
 * DEFECT THIS FIXES (production bug):
 * the previous validation regex was
 *
 *     /^[^\s@]+@[^\s@]+\.[^\s@]+$/
 *
 * whose `[^\s@]` classes happily accept ':', ';', ',' and '|'. A line exported
 * from a mail client — "melvin.loinette@windstream.net:Lake2018" — therefore
 * validated as ONE address and was stored and sent as
 * "melvin.loinette@windstream.net:lake2018": the recipient was corrupt AND the
 * password ended up in the database and in the send list.
 *
 * RULE: keep the FIRST valid address on the line and discard everything after
 * it. The address itself is never modified (no rewriting, no case folding of
 * the local part beyond the lowercasing the product already did).
 *
 * SECURITY: anything following an address — a password, a note, a second
 * address — is UNTRUSTED input. It is never stored as a recipient, never sent
 * and never logged. This module performs no logging at all: a raw line may
 * contain credentials, so callers must not log it either.
 *
 * Pure module (no server imports, no I/O) → usable from client components and
 * from server actions alike, and fully unit-testable.
 */

/**
 * Strict, anchored single address.
 *
 * Deliberately NOT `[^\s@]+`: the classes below cannot contain ':' ';' ',' '|'
 * or whitespace, so an address with a trailing suffix simply does not match —
 * which is what makes the extraction stop at the end of the address. The local
 * part is a dot-atom (no leading/trailing/consecutive dots) and the domain is
 * a sequence of real labels with a TLD.
 */
export const RECIPIENT_EMAIL_RE =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** RFC 5321 caps: 64 chars local part, 254 chars total. */
const MAX_LOCAL_PART = 64;
const MAX_ADDRESS = 254;

/** Hard cap so a hostile file cannot build an unbounded list (the campaign
 *  sender refuses more than 1,000 recipients anyway). */
export const MAX_RECIPIENTS = 1000;

/** Characters a token may be wrapped in by address-book exports. */
const WRAPPING = /^[<([{"']+|[>)\]}"']+$/g;

export function isValidRecipientEmail(value: string): boolean {
  if (!value || value.length > MAX_ADDRESS) return false;
  if (!RECIPIENT_EMAIL_RE.test(value)) return false;
  const local = value.slice(0, value.indexOf("@"));
  return local.length <= MAX_LOCAL_PART;
}

/** Strip address-book wrappers: "<a@b.com>", "\"a@b.com\"", "(a@b.com)". */
function unwrap(token: string): string {
  return token.replace(WRAPPING, "").trim();
}

/** Delimiters that separate an address from anything that follows it. */
const SEPARATORS = /[\s\t,;|:]+/;

/**
 * Every valid address on one line, in order, lowercased.
 *
 * Handles — without ever modifying an address:
 *   email@example.com            → [email@example.com]
 *   email@example.com:password   → [email@example.com]
 *   email@example.com;password   → [email@example.com]
 *   email@example.com,password   → [email@example.com]
 *   email@example.com|password   → [email@example.com]
 *   email@example.com password   → [email@example.com]
 *   "Name" <email@example.com>   → [email@example.com]
 *   a@x.com, b@y.com             → [a@x.com, b@y.com]   (peer addresses kept)
 *   invalid-line                 → []
 *
 * Why plural and not strictly "the first": the feature already accepted
 * comma/semicolon/space separated lists on a single line, and silently dropping
 * every address after the first would break that working behaviour. A trailing
 * password never matches the address grammar, so it can never become one of
 * the returned entries — the security part of the contract holds either way.
 */
export function extractRecipientsFromLine(line: string): string[] {
  if (!line) return [];
  // Strip a UTF-8 BOM that some editors/TXT exports prepend.
  const cleaned = line.replace(/^\uFEFF/, "").trim();
  if (!cleaned) return [];

  // Address-book form: the address sits inside angle brackets and the text
  // before it is a display name (never an address).
  const bracketed = cleaned.match(/<([^>]*)>/);
  const tokens = bracketed
    ? [bracketed[1], ...cleaned.split(SEPARATORS)]
    : cleaned.split(SEPARATORS);

  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const candidate = unwrap(token).toLowerCase();
    if (!isValidRecipientEmail(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
  }
  return out;
}

/** The FIRST valid address on a line, or null. */
export function extractRecipientFromLine(line: string): string | null {
  return extractRecipientsFromLine(line)[0] ?? null;
}

/**
 * Normalize ONE recipient value coming from the client or the database: if the
 * value carries an address, return that address; otherwise null. This is the
 * server-side guard — a polluted value can never reach storage.
 */
export function normalizeRecipientEmail(raw: string): string | null {
  return extractRecipientFromLine(raw ?? "");
}

export interface ParsedRecipients {
  /** Unique addresses, in first-seen order, lowercased. */
  emails: string[];
  /** Lines that contained no valid address (empty lines are not counted). */
  skipped: number;
  /** True when the input exceeded MAX_RECIPIENTS and was cut. */
  truncated: boolean;
}

/**
 * Parse a pasted list or an uploaded TXT/CSV body.
 *
 * Contract: trim each line, keep the address(es) on it and drop the rest,
 * remove case-insensitive duplicates, ignore empty lines and lines without a
 * valid address, and never return more than MAX_RECIPIENTS entries.
 */
export function parseRecipientInput(text: string): ParsedRecipients {
  const emails: string[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let truncated = false;

  for (const line of (text ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const found = extractRecipientsFromLine(line);
    if (!found.length) {
      skipped += 1;
      continue;
    }
    for (const email of found) {
      if (seen.has(email)) continue;
      if (emails.length >= MAX_RECIPIENTS) {
        truncated = true;
        break;
      }
      seen.add(email);
      emails.push(email);
    }
    if (truncated) break;
  }

  return { emails, skipped, truncated };
}
