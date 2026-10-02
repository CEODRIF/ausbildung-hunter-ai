/**
 * Company Discovery — the API error contract shared by the routes and the UI.
 *
 * Why this module exists: the UI used to collapse EVERY failure (401 / 400 /
 * 404 / 429 / 500 / network) into one generic message — the user could not
 * tell an expired session from a missing database table. The routes now
 * answer with a stable, machine-readable `code`; the UI maps that code to a
 * translated, actionable message. Internal details (Postgres messages, stack
 * traces, secrets) never cross this boundary — they stay in the server log.
 *
 * Pure/isomorphic on purpose: the React client and the route handlers import
 * the SAME mapping (no duplicated string literals, no drift).
 */

/** Stable error codes returned as `{ code }` by every discovery route. */
export type DiscoveryErrorCode =
  | "unauthorized"
  | "rate_limited"
  | "invalid_params"
  | "not_found"
  | "database_not_ready"
  | "source_unavailable"
  | "search_failed"
  | "cancelled";

/** Code → i18n key (all keys live under `companyDiscovery.error.*`). */
export const DISCOVERY_ERROR_KEYS: Record<DiscoveryErrorCode, string> = {
  unauthorized: "companyDiscovery.error.unauthorized",
  rate_limited: "companyDiscovery.error.rateLimited",
  invalid_params: "companyDiscovery.error.invalidParams",
  not_found: "companyDiscovery.error.notFound",
  database_not_ready: "companyDiscovery.error.databaseNotReady",
  source_unavailable: "companyDiscovery.error.sourceUnavailable",
  search_failed: "companyDiscovery.error.searchFailed",
  cancelled: "companyDiscovery.error.cancelled",
};

/** Last-resort key when neither a known code nor a known status is present. */
export const DISCOVERY_ERROR_FALLBACK_KEY = "companyDiscovery.error.generic";

/** Key for the failed Stop Search action (separate from a failed run). */
export const DISCOVERY_STOP_FAILED_KEY = "companyDiscovery.error.stopFailed";

/** Failure body of the discovery API (fields beyond `code` are optional). */
export interface DiscoveryErrorBody {
  /** Machine-readable code (the source of truth for the UI). */
  code?: string;
  /** Human-readable English detail for logs/debugging — never shown raw. */
  error?: string;
  /** Zod issues for `invalid_params` (field paths, not values). */
  issues?: string[];
  /** Seconds until a rate-limit window resets. */
  retry_after?: number;
}

export function isDiscoveryErrorCode(value: unknown): value is DiscoveryErrorCode {
  return typeof value === "string" && value in DISCOVERY_ERROR_KEYS;
}

/**
 * The i18n key for a failed discovery request.
 *
 * A known `code` always wins; otherwise the HTTP status decides; otherwise the
 * generic key. The server's `error` string is deliberately NOT rendered.
 */
export function discoveryErrorKey(status: number, code?: unknown): string {
  if (isDiscoveryErrorCode(code)) return DISCOVERY_ERROR_KEYS[code];
  if (status === 400) return DISCOVERY_ERROR_KEYS.invalid_params;
  if (status === 401 || status === 403) return DISCOVERY_ERROR_KEYS.unauthorized;
  if (status === 404) return DISCOVERY_ERROR_KEYS.not_found;
  if (status === 429) return DISCOVERY_ERROR_KEYS.rate_limited;
  if (status >= 500) return DISCOVERY_ERROR_KEYS.search_failed;
  return DISCOVERY_ERROR_FALLBACK_KEY;
}

/**
 * Seconds to wait before retrying a rate-limited request — from the body
 * (`retry_after`) or the standard `Retry-After` header. 0 when unknown, so
 * the message still reads correctly.
 */
export function retryAfterSeconds(
  body?: DiscoveryErrorBody | null,
  headerValue?: string | null,
): number {
  const fromBody = body?.retry_after;
  if (typeof fromBody === "number" && Number.isFinite(fromBody) && fromBody > 0) {
    return Math.ceil(fromBody);
  }
  const fromHeader = Number(headerValue ?? "");
  if (Number.isFinite(fromHeader) && fromHeader > 0) return Math.ceil(fromHeader);
  return 0;
}

/**
 * PostgREST / Postgres signatures of a database that is not ready for this
 * feature: a missing relation OR a missing column (the deployed schema is
 * older than the code). A missing column is deliberately part of this: the
 * user-facing truth is "not migrated yet", never "your search failed".
 */
const MISSING_RELATION_RE =
  /PGRST205|PGRST204|42P01|does not exist|could not find the table|schema cache/i;

/**
 * Classify a persistence failure WITHOUT leaking it to the user.
 *
 * A missing relation (the migration was not applied) is an operational
 * readiness problem — `database_not_ready` — not a failed search: the UI must
 * say "not ready", not "try again", and the log carries the real message.
 */
function describeError(error: unknown): string {
  const parts: string[] = [];
  if (typeof error === "string") parts.push(error);
  if (error instanceof Error) parts.push(error.message);
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    for (const key of ["code", "message", "details", "hint"]) {
      const value = record[key];
      if (typeof value === "string") parts.push(value);
    }
  }
  return parts.join(" | ");
}

export function classifyDiscoveryDbError(error: unknown): DiscoveryErrorCode {
  if (MISSING_RELATION_RE.test(describeError(error))) return "database_not_ready";
  return "search_failed";
}

/** PostgREST signature of a column the LIVE schema does not have (drift). */
const UNKNOWN_COLUMN_RE =
  /PGRST204|could not find the '[^']+' column|column [\w."]+ does not exist/i;

/**
 * True when Postgres/PostgREST rejected a statement because a COLUMN does not
 * exist in the deployed schema — the normal state of a database that has not
 * received the newest migration yet.
 *
 * Callers use it to retry the same write WITHOUT the optional column instead of
 * losing the user's work: a draft without its provenance link is still a saved
 * draft, while a failed insert is lost work.
 */
export function isUnknownColumnError(error: unknown): boolean {
  return UNKNOWN_COLUMN_RE.test(describeError(error));
}

/** Whether a persisted run status is terminal (no further work happens). */
export function isTerminalRunStatus(status: string): boolean {
  return (
    status === "completed" ||
    status === "partial" ||
    status === "cancelled" ||
    status === "failed"
  );
}
