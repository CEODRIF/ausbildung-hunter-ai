import "server-only";

import { createHash } from "node:crypto";

import {
  opportunitySchema,
  usesScanWindow,
  type Opportunity,
  type OpportunitySearchParams,
  type OpportunityWindow,
} from "@/lib/opportunities/types";

const SEARCH_URL =
  "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v6/jobs";
const DETAILS_URL =
  "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobdetails";
const PUBLIC_JOB_URL = "https://www.arbeitsagentur.de/jobsuche/jobdetail/";
export const ARBEITSAGENTUR_PROVIDER = "arbeitsagentur";
const SOURCE_NAME = "Bundesagentur für Arbeit – Jobbörse";

/** Bounded scan for server-side filters the BA REST API cannot express. */
const SCAN_PAGE_SIZE = 50;
const SCAN_MAX_PAGES = 10;

export class OpportunityProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpportunityProviderError";
  }
}

export class OpportunityNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpportunityNotFoundError";
  }
}

type RawRecord = Record<string, unknown>;

function config() {
  const apiKey = process.env.ARBEITSAGENTUR_API_KEY || "jobboerse-jobsuche";
  return { apiKey };
}

function base64Ref(ref: string) {
  return Buffer.from(ref, "utf8").toString("base64");
}

/** BA reference charset (digits, letters, dash, underscore). */
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;

export function isArbeitsagenturRef(ref: string): boolean {
  return REF_PATTERN.test(ref);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && !Number.isNaN(Number(value)))
    return Number(value);
  return null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function safeDate(value: unknown): string | null {
  const result = text(value);
  if (!result) return null;
  const parsed = Date.parse(result);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function subObject(value: unknown): RawRecord | null {
  return value && typeof value === "object" ? (value as RawRecord) : null;
}

/**
 * Build the BA v6 search query using only parameters that the API actually
 * honors (verified against the live API):
 *   page, size, angebotsart (1=Arbeit, 4=Ausbildung), was, wo, umkreis,
 *   ver关于entlichtseit=1 (today).
 *
 * Deliberately NOT sent (verified non-functional on the v6 REST API):
 *   - arbeitszeit (remote filter returns 0 results for every value)
 *   - beruf (free-text role returns 0 results)
 *   - arbeitgeber (free-text company returns 0 results)
 * Role/company/freshness(14d,30d) are applied server-side in
 * searchArbeitsagentur() instead of pretending the API handled them.
 */
export function buildSearchQuery(params: {
  goal: "ausbildung" | "arbeit";
  keyword: string;
  location: string;
  radius?: number;
  freshness: "any" | "today" | "14d" | "30d";
  page: number;
  size: number;
}): URLSearchParams {
  const query = new URLSearchParams({
    page: String(params.page),
    size: String(params.size),
    angebotsart: params.goal === "ausbildung" ? "4" : "1",
  });
  if (params.keyword) query.set("was", params.keyword);
  if (params.location) query.set("wo", params.location);
  if (params.radius !== undefined && params.location)
    query.set("umkreis", String(params.radius));
  if (params.freshness === "today") query.set("veroeffentlichtseit", "1");
  return query;
}

function formatDe(value: number): string {
  return new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: value % 1 ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(value);
}

/** Salary is reported only when the source gives amount + known unit. */
function parseSalary(value: RawRecord): {
  amount: number;
  unit: "hourly" | "monthly";
  label: string;
} | null {
  const amount = number(value.festgehalt);
  const kind = text(value.verguetungsangabe)?.toUpperCase() ?? "";
  if (amount === null || amount <= 0) return null;
  if (kind === "STUNDENLOHN")
    return {
      amount,
      unit: "hourly",
      label: `${formatDe(amount)} € / hour`,
    };
  if (kind === "MONATSLOHN" || kind === "GEHALT")
    return {
      amount,
      unit: "monthly",
      label: `${formatDe(amount)} € / month`,
    };
  return null;
}

/** Map BA's geforderterBildungsabschluss to the German school hierarchy. */
function parseEducationRequirement(raw: unknown): {
  raw: string;
  level: "basic" | "intermediate" | "advanced" | "university" | "unknown";
} | null {
  const value = text(raw)?.toUpperCase();
  if (!value) return null;
  if (value === "NICHT_RELEVANT" || value === "KEINE_ANGABEN") return null;
  if (value.includes("ABITUR")) return { raw: value, level: "university" };
  if (value.includes("FACHOBERT")) return { raw: value, level: "advanced" };
  if (value.includes("MITTLERE_REIFE") || value.includes("MITTLERER"))
    return { raw: value, level: "intermediate" };
  if (value.includes("HAUPTSCHUL")) return { raw: value, level: "basic" };
  return { raw: value, level: "unknown" };
}

/**
 * Authoritative goal classification from the source's stellenangebotsart.
 * The fallback is only the category that was queried from the API — used
 * when (contrary to observed behavior) the field is missing.
 */
function classifyGoal(
  value: unknown,
  fallback: "ausbildung" | "arbeit",
): "ausbildung" | "arbeit" {
  const raw = text(value)?.toUpperCase();
  if (!raw) return fallback;
  return raw.includes("AUSBILDUNG") ? "ausbildung" : "arbeit";
}

function parseLocation(value: RawRecord): {
  display: string | null;
  detail: {
    city: string | null;
    region: string | null;
    country: string | null;
    postal_code: string | null;
  } | null;
} {
  const list = Array.isArray(value.stellenlokationen)
    ? value.stellenlokationen
    : [];
  const first = subObject(list[0]);
  const adresse = first ? subObject(first.adresse) : null;
  const city = adresse ? text(adresse.ort) : null;
  const region = adresse ? text(adresse.region) : null;
  const postalCode = adresse ? text(adresse.plz) : null;
  const country = adresse ? text(adresse.land) : null;
  const display =
    postalCode && city ? `${postalCode} ${city}` : city || region || postalCode;
  const detail =
    city || region || country || postalCode
      ? { city, region, country, postal_code: postalCode }
      : null;
  return { display, detail };
}

function parseEmploymentType(value: RawRecord): string | null {
  const full = value.arbeitszeitVollzeit === true;
  const part =
    value.arbeitszeitTeilzeit === true ||
    Object.keys(value).some(
      (key) => key.startsWith("arbeitszeitTeilzeit") && value[key] === true,
    );
  if (full && part) return "Full-time or part-time";
  if (full) return "Full-time";
  if (part) return "Part-time";
  return null;
}

// ---------------------------------------------------------------------------
// Description parsing (details only). Conservative, source-faithful:
// only content that is clearly present in the published text is extracted.
// ---------------------------------------------------------------------------

const TASK_HEADER_RE =
  /^(ihr(e|es)?|dein(e)?)?\s*(aufgaben( und tätigkeiten)?)$/i;
const REQUIREMENT_HEADER_RE =
  /^(ihr(e|es)?|dein(e)?)?\s*(anforderungen|profil|voraussetzungen)$|^wir erwarten( (Sie|dich))?$|^(was wir (von Ihnen|erwarten|von dir))$/i;
const SECTION_RESET_RE = /^(referenznummer|bewerbung|kontakt|ansprechpartner)/i;
const BULLET_RE = /^\s*(?:[-*•◦▪●]\s+|\d{1,2}[.)]\s+)([\s\S]*)$/;
const NAME_LINE_RE = /^[A-ZÄÖÜ][a-zäöüß]+(?:\s+[A-ZÄÖÜ][a-zäöüß]+){1,2}$/;
const EMAIL_RE =
  /\b[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_LABELED_RE =
  /(?:telefon|tel\.?)\s*[:\-–]?\s*(\+49[\s\d()/-]{7,17}|\b0\d{2,5}[\s/-]?\d{4,11}\b)/i;
const PHONE_BARE_RE = /\+49[\s\d()/-]{7,17}/;
const PERSON_RESPONSIBLE_RE =
  /ansprechpartner(?:in)?(?:\s+(?:ist|sind|sind\s+\w+|wird\s+\w+|heißt))?\s*[:\-–]?\s*(?:Frau|Herr|Herrn|Dr\.?)?\s*([A-ZÄÖÜ][a-zA-Zäöüß.\-]+(?:\s+[A-ZÄÖÜ][a-zA-Zäöüß.\-]+){0,2})/;
const PERSON_CONTEXT_RE =
  /\b(?:bei|an)\s+(?:Frau|Herr|Herrn|Dr\.)\s+([A-ZÄÖÜ][a-zA-Zäöüß.\-]+(?:\s+[A-ZÄÖÜ][a-zA-Zäöüß.\-]+){0,2})\s+(?:unter|an|in|mit|über)\b/;

function pushLine(lines: string[], raw: string, max = 50) {
  const line = raw.replace(/\s+/g, " ").trim();
  if (line && line.length <= 300 && lines.length < max && !lines.includes(line))
    lines.push(line);
}

function parseDescriptionSections(description: string): {
  tasks: string[];
  requirements: string[];
} {
  const tasks: string[] = [];
  const requirements: string[] = [];
  let current: "tasks" | "requirements" | null = null;
  for (const rawLine of description.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const header = line.replace(/^#{1,6}\s*/, "").trim();
    if (TASK_HEADER_RE.test(header)) {
      current = "tasks";
      continue;
    }
    if (REQUIREMENT_HEADER_RE.test(header)) {
      current = "requirements";
      continue;
    }
    if (/^#{1,6}\s/.test(rawLine) || SECTION_RESET_RE.test(header)) {
      current = null;
      continue;
    }
    const bullet = line.match(BULLET_RE);
    if (current && bullet) {
      pushLine(current === "tasks" ? tasks : requirements, bullet[1]);
    }
  }
  return { tasks, requirements };
}

function extractEmail(description: string): string | null {
  const matches = description.match(EMAIL_RE) ?? [];
  for (const email of matches) {
    const lower = email.toLowerCase();
    if (
      lower.includes("noreply") ||
      lower.includes("no-reply") ||
      lower.includes("arbeitsagentur.de") ||
      lower.includes("example.") ||
      lower.startsWith("test@")
    )
      continue;
    return email.slice(0, 254);
  }
  return null;
}

function extractPhone(description: string): string | null {
  const labeled = description.match(PHONE_LABELED_RE);
  const raw = labeled?.[1] ?? description.match(PHONE_BARE_RE)?.[0];
  if (!raw) return null;
  return raw.replace(/\s+/g, " ").trim().slice(0, 64);
}

function extractPerson(
  description: string,
  email: string | null,
  phone: string | null,
): string | null {
  const responsible = description.match(PERSON_RESPONSIBLE_RE)?.[1];
  if (responsible) return responsible.trim().slice(0, 160);
  const context = description.match(PERSON_CONTEXT_RE)?.[1];
  if (context) return context.trim().slice(0, 160);
  // Footer heuristic: a name line directly above the contact block.
  const anchor = email ?? phone;
  if (anchor) {
    const lines = description.split(/\r?\n/).map((line) => line.trim());
    const anchorIndex = lines.findIndex((line) => line.includes(anchor));
    if (anchorIndex > 0) {
      const previous = lines[anchorIndex - 1];
      if (NAME_LINE_RE.test(previous)) return previous.slice(0, 160);
    }
  }
  return null;
}

function extractApplicationUrl(description: string): string | null {
  const matches = description.match(/https?:\/\/[^\s)>\]]+/g) ?? [];
  for (const url of matches) {
    if (url.toLowerCase().includes("arbeitsagentur.de")) continue;
    try {
      new URL(url);
      return url.slice(0, 500);
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Application deadline — details only, strictly source-faithful: a real
 * calendar date explicitly stated in the published text next to an
 * application phrase ("Bewerbungsfrist …", "Bewerbung bis …"). Never
 * inferred from posting dates, start dates, or other fields. Returns ISO
 * YYYY-MM-DD or null.
 */
const DEADLINE_FRIST_RE =
  /\bbewerbungsfrist\s*[:\-–]?\s*(?:am|bis(?: zum)?|zum)?\s*(\d{1,2}\.\s?\d{1,2}\.\s?\d{4})/i;
const DEADLINE_BIS_RE =
  /\bbewerbung\w*\s*(?:bitte\s+)?(?:spätestens|bis(?: zum| am)?|noch bis)\s+(\d{1,2}\.\s?\d{1,2}\.\s?\d{4})/i;

function normalizeGermanDate(raw: string): string | null {
  const parsed = raw.replace(/\s+/g, "").match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!parsed) return null;
  const day = Number(parsed[1]);
  const month = Number(parsed[2]);
  const year = Number(parsed[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (year < 2000 || year > 2100) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return date.toISOString().slice(0, 10);
}

export function extractApplicationDeadline(
  description: string,
): string | null {
  for (const pattern of [DEADLINE_FRIST_RE, DEADLINE_BIS_RE]) {
    const match = description.match(pattern);
    if (!match) continue;
    const iso = normalizeGermanDate(match[1]);
    if (iso) return iso;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function normalizeSearchItem(
  item: unknown,
  requestedGoal: "ausbildung" | "arbeit",
): Opportunity | null {
  const value = subObject(item);
  if (!value) return null;
  const ref = text(value.referenznummer) || text(value.refnr);
  const title =
    text(value.stellenangebotsTitel) || text(value.stellenanzeigeTitel);
  if (!ref || !title) return null;
  const goal = classifyGoal(value.stellenangebotsart, requestedGoal);
  const location = parseLocation(value);
  return opportunitySchema.parse({
    id: `${ARBEITSAGENTUR_PROVIDER}:${ref}`,
    provider: ARBEITSAGENTUR_PROVIDER,
    external_id: ref,
    source_name: SOURCE_NAME,
    source_url: `${PUBLIC_JOB_URL}${encodeURIComponent(ref)}`,
    source_type: "official_source",
    application_url: null,
    title,
    goal,
    stellenangebotsart: text(value.stellenangebotsart),
    company_name: text(value.firma) || text(value.arbeitgeber),
    company_url: null,
    location: location.display,
    location_detail: location.detail,
    distance_km: number(value.entfernung),
    latitude: number(value.breite),
    longitude: number(value.laenge),
    profession: text(value.hauptberuf),
    alternative_professions: [text(value.alternativBeruf1)].filter(
      (item2): item2 is string => item2 !== null,
    ),
    description: null,
    tasks: [],
    requirements: [],
    employment_type: parseEmploymentType(value),
    home_office: bool(value.homeofficemoeglich),
    career_change_friendly: bool(value.quereinstiegGeeignet),
    salary: parseSalary(value),
    training_type: goal === "ausbildung" ? text(value.ausbildungsart) : null,
    education_requirement: null, // only present on Ausbildung details
    valid_from:
      safeDate(subObject(value.eintrittszeitraum)?.von) ||
      safeDate(value.eintrittsdatum),
    application_deadline: null, // only parseable from the details description
    posted_at:
      safeDate(value.datumErsteVeroeffentlichung) ||
      safeDate(subObject(value.veroeffentlichungszeitraum)?.von),
    updated_at: safeDate(value.aenderungsdatum),
    retrieved_at: new Date().toISOString(),
    contact: null,
    required_skills: [],
    preferred_skills: [],
    required_languages: [],
    extracted_keywords: [],
    match: null,
  });
}

function normalizeJobDetails(value: RawRecord): Opportunity {
  const ref = text(value.referenznummer) || text(value.refnr) || "";
  const title =
    text(value.stellenangebotsTitel) || text(value.titel) || text(value.beruf);
  const goal = classifyGoal(value.stellenangebotsart, "arbeit");
  const location = parseLocation(value);
  const description =
    text(value.stellenangebotsBeschreibung) ||
    text(value.stellenbeschreibung) ||
    null;
  const sections = description ? parseDescriptionSections(description) : null;
  const email = description ? extractEmail(description) : null;
  const phone = description ? extractPhone(description) : null;
  const person = description ? extractPerson(description, email, phone) : null;
  const applicationUrl = description
    ? extractApplicationUrl(description)
    : null;
  const contact =
    email || phone || person
      ? {
          person: person,
          email: email,
          phone: phone,
        }
      : null;
  return opportunitySchema.parse({
    id: `${ARBEITSAGENTUR_PROVIDER}:${ref}`,
    provider: ARBEITSAGENTUR_PROVIDER,
    external_id: ref,
    source_name: SOURCE_NAME,
    source_url: `${PUBLIC_JOB_URL}${encodeURIComponent(ref)}`,
    source_type: "official_source",
    application_url: applicationUrl,
    title: title || "Untitled vacancy",
    goal,
    stellenangebotsart: text(value.stellenangebotsart),
    company_name: text(value.firma) || text(value.arbeitgeber),
    company_url: null,
    location: location.display,
    location_detail: location.detail,
    distance_km: number(value.entfernung),
    latitude: number(value.breite),
    longitude: number(value.laenge),
    profession: text(value.hauptberuf),
    alternative_professions: [text(value.alternativBeruf1)].filter(
      (item): item is string => item !== null,
    ),
    description,
    tasks: sections?.tasks ?? [],
    requirements: sections?.requirements ?? [],
    employment_type: parseEmploymentType(value),
    home_office: bool(value.homeofficemoeglich),
    career_change_friendly: bool(value.quereinstiegGeeignet),
    salary: parseSalary(value),
    training_type: goal === "ausbildung" ? text(value.ausbildungsart) : null,
    education_requirement: parseEducationRequirement(
      value.geforderterBildungsabschluss,
    ),
    valid_from:
      safeDate(subObject(value.eintrittszeitraum)?.von) ||
      safeDate(value.eintrittsdatum),
    application_deadline: description
      ? extractApplicationDeadline(description)
      : null,
    posted_at:
      safeDate(value.datumErsteVeroeffentlichung) ||
      safeDate(subObject(value.veroeffentlichungszeitraum)?.von),
    updated_at: safeDate(value.aenderungsdatum),
    retrieved_at: new Date().toISOString(),
    contact,
    required_skills: [],
    preferred_skills: [],
    required_languages: [],
    extracted_keywords: [],
    match: null,
  });
}

// ---------------------------------------------------------------------------
// Fetching (controlled retries, failure classification, structured logging)
// ---------------------------------------------------------------------------

/** Internal failure classes. A valid response with zero results is
 *  deliberately NOT a failure (EMPTY_RESULT) — it is a successful answer. */
export type BaFailureKind =
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "SERVER_ERROR"
  | "BLOCKED_OR_CHALLENGED"
  | "INVALID_RESPONSE";

export interface BaFetchOptions {
  /** Per-attempt timeout in ms (production default: 15000 — the existing
   *  value; kept, now bounded by the overall deadline below). */
  timeoutMs?: number;
  /** Total attempts, 1–3 (production default: 3). */
  maxAttempts?: number;
  /** Base delay for the exponential backoff in ms. */
  backoffBaseMs?: number;
  /** Backoff cap in ms. */
  backoffMaxMs?: number;
  /** Overall deadline for the whole operation in ms — guarantees a single
   *  request can never turn into a 30–60 s wait. */
  deadlineMs?: number;
  /** Short label for structured logs ("search" | "scan" | "details"). */
  label?: string;
}

interface ResolvedBaFetchOptions extends Required<
  Omit<BaFetchOptions, "label">
> {
  label: string;
}

/** Production defaults (the per-attempt timeout is the pre-existing 15 s). */
const baFetchDefaults: ResolvedBaFetchOptions = {
  timeoutMs: 15000,
  maxAttempts: 3,
  backoffBaseMs: 750,
  backoffMaxMs: 5000,
  deadlineMs: 25000,
  label: "search",
};

/** Test hook: temporarily override the production fetch defaults (e.g. tiny
 *  timeouts/backoffs) without faking timers. */
export function configureBaFetchDefaults(
  overrides: Partial<ResolvedBaFetchOptions>,
) {
  Object.assign(baFetchDefaults, overrides);
}

/** Provider failure carrying the internal classification. Extends
 *  OpportunityProviderError so every existing `instanceof` handler keeps
 *  working; `retryable` tells the UI whether "Erneut versuchen" makes sense
 *  (transient kinds yes; a deliberate access block/challenge no). */
export class BaFetchFailure extends OpportunityProviderError {
  readonly kind: BaFailureKind;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly attempts: number;

  constructor(
    message: string,
    details: { kind: BaFailureKind; status?: number | null; attempts?: number },
  ) {
    super(message);
    this.name = "BaFetchFailure";
    this.kind = details.kind;
    this.status = details.status ?? null;
    this.attempts = details.attempts ?? 1;
    this.retryable =
      details.kind === "NETWORK_ERROR" ||
      details.kind === "TIMEOUT" ||
      details.kind === "RATE_LIMITED" ||
      details.kind === "SERVER_ERROR";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Structured, log-safe metadata only: event, attempt, status, duration,
 *  result count, and a short hash of the request URL. Never headers, API
 *  keys, query text, or personal data. */
function baLog(event: string, fields: Record<string, string | number | null>) {
  const rendered = Object.entries(fields)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  console.log(
    `[opportunities][bundesagentur] event=${event} ${rendered}`.trimEnd(),
  );
}

/** Short hash of the request URL (query included; the API key is a header
 *  and never part of the URL). Identifies a request in logs without logging
 *  the search content itself. */
function requestHash(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 8);
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/** Exponential backoff (base × 2^(attempt-1), capped) with a small random
 *  jitter (0–30 %) so parallel runs do not re-hit the upstream in lockstep.
 *  A 429 Retry-After header (in seconds) is honoured, capped at 5 s. */
function backoffDelay(
  attempt: number,
  opts: ResolvedBaFetchOptions,
  retryAfterSeconds: number | null,
): number {
  let delay = Math.min(opts.backoffMaxMs, opts.backoffBaseMs * 2 ** (attempt - 1));
  delay = delay * (1 + Math.random() * 0.3);
  if (retryAfterSeconds !== null)
    delay = Math.max(delay, Math.min(retryAfterSeconds * 1000, 5000));
  return Math.round(delay);
}

/**
 * Fetch a BA JSON endpoint with controlled retries and classification.
 *
 * - Maximum 3 attempts (configurable), each bounded by a per-attempt timeout
 *   (AbortSignal.timeout, default 15 s — the existing production value) and
 *   together by an overall deadline (default 25 s) so a search can never
 *   become a 30–60 s wait.
 * - Retries ONLY transient kinds: NETWORK_ERROR, TIMEOUT, RATE_LIMITED (429),
 *   SERVER_ERROR (5xx) — with exponential backoff + jitter (429 honours a
 *   Retry-After header, capped at 5 s).
 * - BLOCKED_OR_CHALLENGED (401/403, or an HTML challenge page where JSON is
 *   expected) is NOT retried: BA's session/access controls are respected,
 *   never pushed through. INVALID_RESPONSE (unparseable body) is not
 *   retried either — retrying the same payload cannot fix it.
 * - A 200 whose body is HTML (challenge/error page) is classified as
 *   BLOCKED_OR_CHALLENGED instead of surfacing as an obscure JSON.parse
 *   error.
 * - Every attempt is logged with safe metadata only (see baLog).
 */
export async function fetchBaJson(
  url: string,
  options: BaFetchOptions = {},
): Promise<RawRecord> {
  const opts: ResolvedBaFetchOptions = { ...baFetchDefaults, ...options };
  opts.maxAttempts = Math.min(3, Math.max(1, opts.maxAttempts));
  const deadlineAt = Date.now() + opts.deadlineMs;
  const hash = requestHash(url);

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt += 1) {
    const attemptStartedAt = Date.now();

    // --- network layer -----------------------------------------------------
    let response: Response | null = null;
    let networkKind: BaFailureKind | null = null;
    try {
      response = await fetch(url, {
        headers: { "X-API-Key": config().apiKey, accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (error) {
      networkKind =
        error instanceof Error && error.name === "TimeoutError"
          ? "TIMEOUT"
          : "NETWORK_ERROR";
    }

    if (response === null || networkKind !== null) {
      const kind = networkKind ?? "NETWORK_ERROR";
      const durationMs = Date.now() - attemptStartedAt;
      baLog(kind === "TIMEOUT" ? "request_timeout" : "request_failed", {
        label: opts.label,
        attempt,
        kind,
        duration_ms: durationMs,
        query_hash: hash,
      });
      const failure = new BaFetchFailure(
        `${SOURCE_NAME} could not be reached right now.`,
        { kind, attempts: attempt },
      );
      if (attempt < opts.maxAttempts && Date.now() + opts.timeoutMs <= deadlineAt) {
        const delay = backoffDelay(attempt, opts, null);
        baLog("retry", {
          label: opts.label,
          attempt,
          kind,
          delay_ms: delay,
          query_hash: hash,
        });
        await sleep(delay);
        continue;
      }
      throw failure;
    }

    // --- HTTP status ---------------------------------------------------------
    if (!response.ok) {
      let kind: BaFailureKind;
      if (response.status === 429) kind = "RATE_LIMITED";
      else if (response.status >= 500) kind = "SERVER_ERROR";
      else if (response.status === 401 || response.status === 403)
        kind = "BLOCKED_OR_CHALLENGED";
      else kind = "INVALID_RESPONSE";
      const durationMs = Date.now() - attemptStartedAt;
      baLog(kind === "RATE_LIMITED" ? "rate_limited" : "request_failed", {
        label: opts.label,
        attempt,
        status: response.status,
        kind,
        duration_ms: durationMs,
        query_hash: hash,
      });
      const retryableKind =
        kind === "RATE_LIMITED" || kind === "SERVER_ERROR";
      const failure = new BaFetchFailure(
        kind === "RATE_LIMITED"
          ? `${SOURCE_NAME} is currently rate-limited. Please try again shortly.`
          : kind === "BLOCKED_OR_CHALLENGED"
            ? `${SOURCE_NAME} is temporarily unavailable (access restricted).`
            : `${SOURCE_NAME} returned HTTP ${response.status}.`,
        { kind, status: response.status, attempts: attempt },
      );
      if (retryableKind && attempt < opts.maxAttempts) {
        const delay = backoffDelay(
          attempt,
          opts,
          parseRetryAfter(response.headers.get("retry-after")),
        );
        if (Date.now() + delay + opts.timeoutMs <= deadlineAt) {
          baLog("retry", {
            label: opts.label,
            attempt,
            kind,
            status: response.status,
            delay_ms: delay,
            query_hash: hash,
          });
          await sleep(delay);
          continue;
        }
      }
      throw failure;
    }

    // --- body validation (2xx) -------------------------------------------------
    const contentType = response.headers.get("content-type") ?? "";
    const bodyText = await response.text();
    const durationMs = Date.now() - attemptStartedAt;
    const looksHtml =
      contentType.includes("text/html") ||
      /^\s*(<!doctype html|<html)/i.test(bodyText);
    if (looksHtml) {
      // An access challenge / interstitial page where JSON is expected:
      // classify it, do NOT retry (respect BA's controls).
      baLog("invalid_response", {
        label: opts.label,
        attempt,
        kind: "BLOCKED_OR_CHALLENGED",
        status: 200,
        duration_ms: durationMs,
        query_hash: hash,
      });
      throw new BaFetchFailure(
        `${SOURCE_NAME} is temporarily unavailable (access restricted).`,
        { kind: "BLOCKED_OR_CHALLENGED", status: 200, attempts: attempt },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      baLog("invalid_response", {
        label: opts.label,
        attempt,
        kind: "INVALID_RESPONSE",
        status: 200,
        duration_ms: durationMs,
        query_hash: hash,
      });
      throw new BaFetchFailure(
        `${SOURCE_NAME} returned a response that could not be parsed.`,
        { kind: "INVALID_RESPONSE", status: 200, attempts: attempt },
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      baLog("invalid_response", {
        label: opts.label,
        attempt,
        kind: "INVALID_RESPONSE",
        status: 200,
        duration_ms: durationMs,
        query_hash: hash,
      });
      throw new BaFetchFailure(
        `${SOURCE_NAME} returned a response that could not be parsed.`,
        { kind: "INVALID_RESPONSE", status: 200, attempts: attempt },
      );
    }
    const raw = parsed as RawRecord;
    baLog("request_succeeded", {
      label: opts.label,
      attempt,
      status: 200,
      duration_ms: durationMs,
      results: Array.isArray(raw.ergebnisliste) ? raw.ergebnisliste.length : null,
      query_hash: hash,
    });
    return raw;
  }

  // Unreachable (every iteration returns or throws); keeps the type narrow.
  throw new BaFetchFailure(`${SOURCE_NAME} could not be reached right now.`, {
    kind: "NETWORK_ERROR",
    attempts: opts.maxAttempts,
  });
}

function berlinDay(offsetDays: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() - offsetDays * 86_400_000));
}

const foldNorm = (value: string) =>
  value
    .toLocaleLowerCase("de-DE")
    .replace(/[^a-z0-9äöüß ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Server-side filters the BA REST API cannot express. Each matcher returns
 * false for items that cannot be verified against the source (no data) rather
 * than guessing.
 */
export function buildMatchers(params: OpportunitySearchParams) {
  const matchers: Array<(item: Opportunity) => boolean> = [];
  if (params.role) {
    const queryTokens = foldNorm(params.role).split(" ").filter(Boolean);
    if (queryTokens.length) {
      matchers.push((item) => {
        const fields = [
          item.profession,
          ...item.alternative_professions,
          item.title,
        ]
          .filter((value): value is string => value !== null)
          .map((value) => new Set(foldNorm(value).split(" ")));
        return fields.some((tokens) =>
          queryTokens.every((token) => tokens.has(token)),
        );
      });
    }
  }
  if (params.company) {
    const company = foldNorm(params.company);
    if (company) {
      matchers.push((item) =>
        item.company_name
          ? foldNorm(item.company_name).includes(company)
          : false,
      );
    }
  }
  if (params.freshness === "14d" || params.freshness === "30d") {
    const cutoff = berlinDay(params.freshness === "14d" ? 14 : 30);
    matchers.push((item) =>
      item.posted_at ? item.posted_at.slice(0, 10) >= cutoff : false,
    );
  }
  if (params.employment === "full_time") {
    matchers.push((item) =>
      (item.employment_type ?? "").toLowerCase().includes("full-time"),
    );
  }
  if (params.employment === "part_time") {
    matchers.push((item) =>
      (item.employment_type ?? "").toLowerCase().includes("part-time"),
    );
  }
  if (params.training_type !== "any") {
    matchers.push((item) => item.training_type === params.training_type);
  }
  if (params.home_office === "yes") {
    matchers.push((item) => item.home_office === true);
  }
  if (params.salary_documented) {
    matchers.push((item) => item.salary !== null);
  }
  if (params.distance_max !== undefined) {
    const max = params.distance_max;
    matchers.push(
      (item) => item.distance_km !== null && item.distance_km <= max,
    );
  }
  return matchers;
}

/**
 * Deterministic sorting on structured source values (never on formatted
 * display strings). Items without the documented value sort last; ties are
 * broken by stable id so pagination pages never interleave arbitrarily.
 * `relevance` keeps the source's native order; `match` is applied in the
 * search layer (it needs per-user scores that must not be cached).
 */
export function sortWindow(
  window: Opportunity[],
  sort: OpportunitySearchParams["sort"],
): Opportunity[] {
  const byId = (a: Opportunity, b: Opportunity) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const withValueLast = (
    a: Opportunity,
    b: Opportunity,
    value: (item: Opportunity) => number | string | null,
    compare: (x: number | string, y: number | string) => number,
  ) => {
    const av = value(a);
    const bv = value(b);
    if (av === null && bv === null) return byId(a, b);
    if (av === null) return 1;
    if (bv === null) return -1;
    const result = compare(av, bv);
    return result !== 0 ? result : byId(a, b);
  };
  switch (sort) {
    case "newest":
      return [...window].sort((a, b) =>
        withValueLast(
          a,
          b,
          (item) => item.posted_at,
          (x, y) =>
            String(x) < String(y) ? 1 : String(x) > String(y) ? -1 : 0,
        ),
      );
    case "oldest":
      return [...window].sort((a, b) =>
        withValueLast(
          a,
          b,
          (item) => item.posted_at,
          (x, y) =>
            String(x) < String(y) ? -1 : String(y) < String(x) ? 1 : 0,
        ),
      );
    case "salary":
      return [...window].sort((a, b) =>
        withValueLast(
          a,
          b,
          (item) => item.salary?.amount ?? null,
          (x, y) => (y as number) - (x as number),
        ),
      );
    case "distance":
      return [...window].sort((a, b) =>
        withValueLast(
          a,
          b,
          (item) => item.distance_km,
          (x, y) => (x as number) - (y as number),
        ),
      );
    case "relevance":
    case "match":
    default:
      return window;
  }
}

/**
 * Fetch the user-independent result window for a search.
 *
 * - `upstream` mode (no post-filters, relevance sort): true API pagination —
 *   one provider call, `total` is the source total, no truncation.
 * - `scan` mode (role/company/freshness filters or non-relevance sort):
 *   bounded scan of at most SCAN_MAX_PAGES × SCAN_PAGE_SIZE source items,
 *   filtered and sorted server-side. `total` is the matched count within the
 *   scanned window; `scan_truncated` tells the UI the window is smaller than
 *   the full source. The window is cached page-independently so turning pages
 *   does not re-hit the provider.
 */
export async function fetchOpportunityWindow(
  params: OpportunitySearchParams,
): Promise<OpportunityWindow> {
  if (!usesScanWindow(params)) {
    const query = buildSearchQuery({
      goal: params.goal,
      keyword: params.keyword,
      location: params.location,
      radius: params.radius,
      freshness: params.freshness,
      page: params.page,
      size: params.pageSize,
    });
    const raw = await fetchBaJson(`${SEARCH_URL}?${query.toString()}`, {
      label: "search",
    });
    const items = Array.isArray(raw.ergebnisliste) ? raw.ergebnisliste : [];
    const window = items
      .map((item) => normalizeSearchItem(item, params.goal))
      .filter((item): item is Opportunity => item !== null);
    return {
      mode: "upstream",
      window,
      total: Number(raw.maxErgebnisse) || window.length,
      scan_truncated: false,
      exhausted: true,
      degraded: false,
    };
  }

  const matchers = buildMatchers(params);
  // Collect the full bounded window before filtering/sorting. We do NOT stop
  // early at `page*pageSize`: with a non-relevance sort the items that sort to
  // the front are not the first items in source (relevance) order, so a
  // partial collection would sort an incomplete subset. The window is cached
  // page-independently, so turning pages never re-hits the provider.
  const collected: Opportunity[] = [];
  const seen = new Set<string>();
  let sourceTotal = Number.MAX_SAFE_INTEGER;
  let exhausted = false;
  let degraded = false;
  for (let page = 1; page <= SCAN_MAX_PAGES; page++) {
    const query = buildSearchQuery({
      goal: params.goal,
      keyword: params.keyword,
      location: params.location,
      radius: params.radius,
      // "today" still maps to the API parameter here; "14d"/"30d" are no-ops
      // for the API and handled by the date matcher above.
      freshness: params.freshness,
      page,
      size: SCAN_PAGE_SIZE,
    });
    let raw: RawRecord;
    try {
      raw = await fetchBaJson(`${SEARCH_URL}?${query.toString()}`, {
        label: "scan",
      });
    } catch (error) {
      // Controlled partial success: when a LATER page fails after controlled
      // retries, the already-collected real results are served as a degraded
      // (partial) window instead of failing the whole search. A first-page
      // failure (no data) and non-retryable failures (blocked/challenged)
      // still propagate.
      if (page > 1 && error instanceof BaFetchFailure && error.retryable) {
        degraded = true;
        break;
      }
      throw error;
    }
    const counted = Number(raw.maxErgebnisse);
    if (Number.isFinite(counted) && counted >= 0) sourceTotal = counted;
    const items = Array.isArray(raw.ergebnisliste) ? raw.ergebnisliste : [];
    for (const item of items) {
      const normalized = normalizeSearchItem(item, params.goal);
      if (!normalized || seen.has(normalized.id)) continue;
      seen.add(normalized.id);
      if (matchers.every((matcher) => matcher(normalized)))
        collected.push(normalized);
    }
    if (items.length < SCAN_PAGE_SIZE || page * SCAN_PAGE_SIZE >= sourceTotal) {
      exhausted = true;
      break;
    }
  }
  const sorted = sortWindow(collected, params.sort);
  return {
    mode: "scan",
    window: sorted,
    total: sorted.length,
    scan_truncated: !exhausted || degraded,
    exhausted,
    degraded,
  };
}

export async function getArbeitsagenturDetails(
  ref: string,
): Promise<Opportunity> {
  if (!isArbeitsagenturRef(ref))
    throw new OpportunityProviderError("Invalid opportunity reference.");
  const raw = await fetchBaJson(`${DETAILS_URL}/${base64Ref(ref)}`, {
    label: "details",
  });
  if (Array.isArray(raw.messages)) {
    const codes = (raw.messages as Array<RawRecord>)
      .map((message) => text(message.code))
      .filter((code): code is string => code !== null);
    if (codes.includes("STELLENANGEBOT_NICHT_GEFUNDEN"))
      throw new OpportunityNotFoundError(
        "This vacancy is no longer available at the source.",
      );
    throw new OpportunityProviderError(
      `${SOURCE_NAME} reported: ${codes.join(", ") || "unknown error"}.`,
    );
  }
  return normalizeJobDetails(raw);
}

/** Parse and validate a stable opportunity key: `${provider}:${externalId}`. */
export function parseOpportunityKey(key: string): {
  provider: string;
  externalId: string;
} {
  const separator = key.indexOf(":");
  if (separator <= 0 || separator >= key.length - 1)
    throw new OpportunityProviderError("Invalid opportunity key.");
  const provider = key.slice(0, separator);
  const externalId = key.slice(separator + 1);
  if (provider !== ARBEITSAGENTUR_PROVIDER)
    throw new OpportunityProviderError(
      `Unsupported opportunity source: ${provider}`,
    );
  if (!isArbeitsagenturRef(externalId))
    throw new OpportunityProviderError("Invalid opportunity key.");
  return { provider, externalId };
}

/** Resolve the canonical opportunity from the authoritative source. */
export async function resolveOpportunity(key: string): Promise<Opportunity> {
  const { provider, externalId } = parseOpportunityKey(key);
  if (provider === ARBEITSAGENTUR_PROVIDER)
    return getArbeitsagenturDetails(externalId);
  throw new OpportunityProviderError(
    `Unsupported opportunity source: ${provider}`,
  );
}
