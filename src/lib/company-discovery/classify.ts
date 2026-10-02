/**
 * THE central blocked-source classifier (§4.3) — pure, deterministic, and
 * applied to EVERY response before any extraction happens.
 *
 * There is exactly one implementation on purpose. Before this module, blocks
 * were detected in two unrelated places with different vocabularies (the BA
 * provider's `BLOCKED_OR_CHALLENGED` and the page fetcher's `anti_bot`), which
 * is how a blocked source ended up being reported as "no public email". Every
 * fetch path now funnels through {@link classifyResponse}.
 *
 * The classifier is deliberately fail-closed: an interstitial, a challenge
 * header, a login wall or a JavaScript shell counts as BLOCKED even when the
 * HTTP status is a perfectly ordinary 200. A block is never a reason to retry
 * with different headers, a different User-Agent, a proxy or a solver — it is
 * a terminal, per-host decision for the rest of the run.
 *
 * Technical failures (DNS, timeout, TLS, 5xx, non-HTML, oversized body) are NOT
 * blocks and NOT "no email": the caller retries transient ones with bounded
 * backoff and otherwise records them as inconclusive (§4.3).
 */

/** Machine-readable reason a source would not talk to us (§4.4). */
export type BlockedReason =
  | "captcha"
  | "bot_challenge"
  | "login_required"
  | "forbidden"
  | "rate_limited"
  | "robots_disallow"
  | "js_protected"
  | "unreachable";

/**
 * Everything the classifier is allowed to look at. Deliberately plain data so
 * the rules stay unit-testable without a network or a Response object.
 */
export interface ResponseFacts {
  /** The URL actually fetched (after redirects). */
  url: string;
  status: number;
  /** Response headers, keys lower-cased. */
  headers: Record<string, string>;
  contentType?: string | null;
  /** The first ~4 kB of the body (raw HTML, never executed). */
  bodyHead?: string | null;
  /** Length of the visible text the fetcher extracted, when known. */
  visibleTextLength?: number;
  /** The fetcher already decided robots.txt forbids this path. */
  robotsDisallowed?: boolean;
}

export type ResponseClassification =
  | { blocked: false }
  | { blocked: true; reason: BlockedReason; detail: string };

/** Statuses that are a deliberate refusal, never "just an error" (§4.3). */
const BLOCKED_STATUS: Record<number, BlockedReason> = {
  401: "login_required",
  403: "forbidden",
  429: "rate_limited",
  451: "forbidden",
};

/**
 * Headers platform protections set when they stop a request. `cf-mitigated`
 * is Cloudflare's explicit challenge marker; the others are the documented
 * interstitial signatures of DataDome / PerimeterX / Akamai.
 */
const CHALLENGE_HEADERS: ReadonlyArray<[string, string]> = [
  ["cf-mitigated", "challenge"],
  ["x-datadome", ""],
  ["x-dd-b", ""],
  ["x-px", ""],
  ["server", "datadome"],
  ["server", "akamai"],
];

/** Provider-specific CAPTCHA widgets (a challenge, not a mere mention). */
const CAPTCHA_MARKERS: readonly string[] = [
  "g-recaptcha",
  "grecaptcha",
  "recaptcha/api.js",
  "recaptcha/enterprise",
  "www.google.com/recaptcha",
  "hcaptcha.com",
  "h-captcha",
  "challenges.cloudflare.com/turnstile",
  "cf-turnstile",
  "data-sitekey",
];

/** Generic bot walls / interstitials. */
const BOT_WALL_MARKERS: readonly string[] = [
  "cf-challenge",
  "cf_chl_opt",
  "just a moment",
  "checking your browser",
  "attention required! | cloudflare",
  "unusual traffic",
  "verify you are human",
  "are you a human",
  "enable javascript and cookies to continue",
  "sicherheitsüberprüfung",
  "bestätigen sie, dass sie kein roboter sind",
  "captcha",
  "datadome",
  "perimeterx",
  "px-captcha",
  "imperva",
  "incapsula",
  "_incap_ses",
  "akamai bot manager",
  "bot manager",
  "access denied",
];

/** A page that only works with JavaScript (no readable content delivered). */
const JS_SHELL_MARKERS: readonly string[] = [
  "enable javascript",
  "javascript is disabled",
  "aktivieren sie javascript",
  "bitte aktivieren sie javascript",
  "vous devez activer javascript",
  "browser nicht unterstützt",
];

/** Consent walls that must be accepted before content is served. */
const CONSENT_MARKERS: readonly string[] = [
  "cookie-einstellungen akzeptieren",
  "wir verwenden cookies",
  "we use cookies to",
  "consent to continue",
  "einwilligung erteilen",
  "alle cookies akzeptieren",
];

/** Paths that only ever serve a login / registration wall. */
const LOGIN_PATH_RE =
  /(\/(login|signin|sign-in|anmelden|einloggen|authwall|session|register|registrieren|account\/login|uas\/login)\b|\/passwort|\/sso\/)/i;

/**
 * Classify one response. Returns `{blocked:false}` only when nothing indicates
 * an access control — the caller may then extract from the body.
 */
export function classifyResponse(facts: ResponseFacts): ResponseClassification {
  // 1. robots.txt already said no — we must not even have fetched it.
  if (facts.robotsDisallowed) {
    return {
      blocked: true,
      reason: "robots_disallow",
      detail: "robots.txt disallows this path",
    };
  }

  // 2. A deliberate refusal status.
  const statusReason = BLOCKED_STATUS[facts.status];
  if (statusReason) {
    return {
      blocked: true,
      reason: statusReason,
      detail: `HTTP ${facts.status}`,
    };
  }

  // 3. A protection platform told us, in a header, that it intervened.
  for (const [name, needle] of CHALLENGE_HEADERS) {
    const value = facts.headers[name];
    if (value === undefined) continue;
    if (needle === "" || value.toLowerCase().includes(needle)) {
      return {
        blocked: true,
        reason: "bot_challenge",
        detail: `challenge header ${name}`,
      };
    }
  }

  // 4. A redirect landed on a login / registration wall.
  if (loginPathOf(facts.url)) {
    return {
      blocked: true,
      reason: "login_required",
      detail: "redirected to a login wall",
    };
  }

  const head = (facts.bodyHead ?? "").slice(0, 4_000).toLowerCase();

  // 5. CAPTCHA widget.
  if (CAPTCHA_MARKERS.some((marker) => head.includes(marker))) {
    return { blocked: true, reason: "captcha", detail: "CAPTCHA challenge page" };
  }

  // 6. Generic bot wall / interstitial.
  if (BOT_WALL_MARKERS.some((marker) => head.includes(marker))) {
    return {
      blocked: true,
      reason: "bot_challenge",
      detail: "anti-bot interstitial",
    };
  }

  // 7. JavaScript-only shell: HTML arrived but no readable content did. We do
  //    NOT execute scripts, OCR images or decode protection schemes (§4.2a).
  const visible = facts.visibleTextLength;
  if (typeof visible === "number" && visible < 80) {
    if (
      JS_SHELL_MARKERS.some((marker) => head.includes(marker)) ||
      head.includes("<noscript")
    ) {
      return {
        blocked: true,
        reason: "js_protected",
        detail: "content is only reachable by executing JavaScript",
      };
    }
    if (CONSENT_MARKERS.some((marker) => head.includes(marker))) {
      return {
        blocked: true,
        reason: "bot_challenge",
        detail: "consent wall before content",
      };
    }
    if (head.trim().length === 0) {
      // An empty shell is not a page we can honestly claim to have read.
      return {
        blocked: true,
        reason: "js_protected",
        detail: "empty body",
      };
    }
  }

  return { blocked: false };
}

/** The login-like path segment of a URL, or null. */
function loginPathOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    const match = LOGIN_PATH_RE.exec(parsed.pathname);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

/**
 * True when a technical outcome must be treated as INCONCLUSIVE rather than
 * as "no public email" (§4.4). Kept here so the vocabulary stays in one place.
 */
export function isBlockedReason(value: string): value is BlockedReason {
  return (
    value === "captcha" ||
    value === "bot_challenge" ||
    value === "login_required" ||
    value === "forbidden" ||
    value === "rate_limited" ||
    value === "robots_disallow" ||
    value === "js_protected" ||
    value === "unreachable"
  );
}
