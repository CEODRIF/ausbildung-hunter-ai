import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import type { CompanyEvidenceItem } from "./confidence";
import type { ResearchMemoryStore } from "./planner";
import { isUnknownColumnError, isUnknownTableError } from "./errors";
import {
  type DiscoveryCandidate,
  type DiscoveryEmailSource,
  type DiscoveryProgress,
  type DiscoveryRun,
  type DiscoveryRunParams,
  type DiscoveryRunStatus,
  type DiscoverySourceStatus,
  TERMINAL_RUN_STATUSES,
  discoveryRunParamsSchema,
} from "./types";

/**
 * Discovery run store (Phase 1 — run model).
 *
 * All persistence for Company & Email Discovery lives here. Posture matches
 * the rest of the platform: the browser never touches these tables — every
 * read/write goes through the API routes with the service-role client, and
 * the user id always comes from the authenticated session, never the body.
 *
 * Invariants:
 *  - create validates with the shared zod schema (the API route validates
 *    again at the edge; both use the same schema object);
 *  - lifecycle: pending → running → (completed | partial | cancelled |
 *    failed). Cancel is idempotent and a terminal run never starts work —
 *    the orchestrator re-checks the status before every new work unit
 *    (Stop Search contract);
 *  - candidate/company/email records are idempotent and keyed by natural
 *    identity — retries never duplicate rows, and
 *    `unique (run_id, company_key)` makes "1 company = 1 result" a
 *    structural guarantee, not a convention;
 *  - counters are set (not incremented) by the single writer of a run;
 *  - every write failure throws a controlled error (the route maps it to a
 *    500); no secrets, no raw stack traces cross this boundary.
 */

interface DiscoveryRunRow {
  run_id: string;
  user_id: string;
  params: unknown;
  status: string;
  target_companies: number;
  found_companies: number;
  offers_analyzed: number;
  unique_companies: number;
  duplicates_removed: number;
  companies_rejected: number;
  /** Added by the multi-source migration; absent on a database that has not
   *  received it yet, which is why every read falls back to 0. */
  emails_found?: number;
  no_public_email?: number;
  sources_blocked?: number;
  companies_processed?: number;
  /** Live research state (agentic-research migration); absent pre-migration. */
  current_query?: string | null;
  current_source?: string | null;
  /** Research memory + live strategy (research-memory migration);
   *  absent pre-migration. */
  current_strategy?: string | null;
  research_memory?: unknown;
  sources: unknown;
  credits_charged: number;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

/** Raw `discovery_companies` row (snake_case, exactly as stored). */
interface DiscoveryCompanyRow {
  id: string;
  company_key: string;
  company_name: string;
  website_url: string | null;
  role: string | null;
  field: string | null;
  offer_type: string | null;
  city: string | null;
  state: string | null;
  beginn: string | null;
  salary_label: string | null;
  offer_source: string | null;
  offer_url: string | null;
  status: string;
  reject_reason: string | null;
  /** The three-outcome literal; added by the multi-source migration. */
  email_status?: string | null;
  /** Verification facts; added by the agentic-research migration. */
  application_url?: string | null;
  beginn_year_confirmed?: boolean | null;
  confidence_score?: number | null;
  /** Evidence ledger (research-memory migration); absent pre-migration. */
  evidence?: unknown;
  confidence_reasons?: unknown;
  conflict?: boolean | null;
}

function isSourceStatus(value: unknown): value is DiscoverySourceStatus["status"] {
  return (
    value === "ok" ||
    value === "running" ||
    value === "unavailable" ||
    value === "skipped" ||
    value === "blocked" ||
    value === "skipped_by_policy" ||
    value === "error"
  );
}

/** The known source families (§3.2 + the internet-discovery expansion). */
const SOURCE_CATEGORIES: readonly string[] = [
  "ausbildung",
  "chamber",
  "jobs",
  "local-jobs",
  "government",
  "search",
  "company-site",
  "directory",
  "platform",
];

function isSourceCategory(value: unknown): boolean {
  return typeof value === "string" && SOURCE_CATEGORIES.includes(value);
}

/**
 * Columns that only exist once `…_discovery_multi_source.sql` has been applied.
 * A write that mentions one of them on a database without it is retried
 * WITHOUT them and logged: losing an audit detail must never lose the user's
 * result, and must never fail the run (the same posture the campaign bridge
 * already takes for schema drift).
 */
const MIGRATION_DEPENDENT_KEYS = [
  "emails_found",
  "no_public_email",
  "sources_blocked",
  "companies_processed",
  "email_status",
  "verification_status",
  "verification_method",
  "domain_match",
  "evidence_snippet",
  "discovered_at",
  // 20261024000000_discovery_agentic_research.sql:
  "current_query",
  "current_source",
  "application_url",
  "beginn_year_confirmed",
  "confidence_score",
  // 20261025000000_discovery_research_memory.sql:
  "current_strategy",
  "research_memory",
  "evidence",
  "confidence_reasons",
  "conflict",
] as const;

/** The patch without the migration-dependent keys. */
function withoutMigrationKeys(
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const reduced: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if ((MIGRATION_DEPENDENT_KEYS as readonly string[]).includes(key)) continue;
    reduced[key] = value;
  }
  return reduced;
}

/** Parse a stored sources jsonb into the typed list (defensive). */
function parseSources(raw: unknown): DiscoverySourceStatus[] {
  if (!Array.isArray(raw)) return [];
  const out: DiscoverySourceStatus[] = [];
  for (const entry of raw) {
    const item = entry as Record<string, unknown> | null;
    if (!item || typeof item.id !== "string") continue;
    const status = item.status;
    if (!isSourceStatus(status)) continue;
    out.push({
      id: item.id,
      status,
      ...(typeof item.displayName === "string"
        ? { displayName: item.displayName }
        : {}),
      ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
      ...(typeof item.policy === "string"
        ? { policy: item.policy as DiscoverySourceStatus["policy"] }
        : {}),
      ...(isSourceCategory(item.category)
        ? { category: item.category as DiscoverySourceStatus["category"] }
        : {}),
      ...(typeof item.candidates === "number" ? { candidates: item.candidates } : {}),
      ...(
        item.stats &&
        typeof item.stats === "object" &&
        typeof (item.stats as Record<string, unknown>).queriesExecuted === "number" &&
        typeof (item.stats as Record<string, unknown>).resultsInspected === "number"
          ? {
              stats: {
                queriesExecuted: (item.stats as Record<string, unknown>).queriesExecuted as number,
                resultsInspected: (item.stats as Record<string, unknown>)
                  .resultsInspected as number,
              },
            }
          : {}
      ),
    });
  }
  return out;
}

/** Parse a stored evidence jsonb into the typed ledger (defensive — a bad
 *  value degrades to an empty ledger, never a crash). */
function parseEvidence(raw: unknown): CompanyEvidenceItem[] {
  if (!Array.isArray(raw)) return [];
  const out: CompanyEvidenceItem[] = [];
  for (const entry of raw) {
    const item = entry as Record<string, unknown> | null;
    if (!item || typeof item.url !== "string" || item.url.length === 0) continue;
    if (typeof item.fact !== "string" || typeof item.checkedAt !== "string") continue;
    const sourceType = item.sourceType;
    if (
      typeof sourceType !== "string" ||
      !/^[a-z_]+$/.test(sourceType)
    ) continue;
    out.push({
      url: item.url,
      sourceType: sourceType as CompanyEvidenceItem["sourceType"],
      fact: item.fact,
      ...(typeof item.quote === "string" ? { quote: item.quote } : {}),
      checkedAt: item.checkedAt,
    });
    if (out.length >= 20) break; // a ledger is an audit trail, not a dump
  }
  return out;
}

/** Parse a stored confidence-reasons jsonb (defensive). */
function parseStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((value): value is string => typeof value === "string")
    .slice(0, 20);
}

function rowToRun(row: DiscoveryRunRow): DiscoveryRun {
  const parsed = discoveryRunParamsSchema.parse(row.params);
  const status = row.status as DiscoveryRunStatus;
  const progress: DiscoveryProgress = {
    status,
    targetCompanies: row.target_companies,
    foundCompanies: row.found_companies,
    offersAnalyzed: row.offers_analyzed,
    uniqueCompanies: row.unique_companies,
    duplicatesRemoved: row.duplicates_removed,
    companiesRejected: row.companies_rejected,
    emailsFound: row.emails_found ?? 0,
    noPublicEmail: row.no_public_email ?? 0,
    sourcesBlocked: row.sources_blocked ?? 0,
    // Migration-dependent column — older rows simply have no processed count.
    companiesProcessed: row.companies_processed ?? 0,
    // Live research state — null on a database without the columns.
    currentQuery: row.current_query ?? null,
    currentSource: row.current_source ?? null,
    currentStrategy: row.current_strategy ?? null,
    sources: parseSources(row.sources),
  };
  return {
    runId: row.run_id,
    status,
    params: parsed,
    progress,
    creditsCharged: row.credits_charged,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/** Create a new run in status `pending`. Throws on invalid params / DB error. */
export async function createDiscoveryRun(
  userId: string,
  rawParams: unknown,
): Promise<DiscoveryRun> {
  // Throws a ZodError for invalid input — the route maps it to a 400.
  const params: DiscoveryRunParams = discoveryRunParamsSchema.parse(rawParams);
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("discovery_runs")
    .insert({
      user_id: userId,
      params,
      status: "pending",
      target_companies: params.targetCompanies,
      sources: [] as DiscoverySourceStatus[],
    })
    .select("*")
    .single();
  if (error || !data) {
    throw new Error(error?.message ?? "Failed to create the discovery run.");
  }
  return rowToRun(data as DiscoveryRunRow);
}

/** Fetch one of the user's runs, or null (unknown id, other user, no row). */
export async function getDiscoveryRun(
  runId: string,
  userId: string,
): Promise<DiscoveryRun | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("discovery_runs")
    .select("*")
    .eq("run_id", runId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  return rowToRun(data as DiscoveryRunRow);
}

/**
 * Strict variant of {@link getDiscoveryRun} for the API routes: a MISSING row
 * still returns null, but a persistence failure THROWS instead of being
 * reported as "not found". A database outage must surface as a database
 * error, never as a 404 the user would misread as "run deleted".
 */
export async function getDiscoveryRunStrict(
  runId: string,
  userId: string,
): Promise<DiscoveryRun | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("discovery_runs")
    .select("*")
    .eq("run_id", runId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return rowToRun(data as DiscoveryRunRow);
}

/** pending → running (sets started_at once). Idempotent when already running. */
export async function startDiscoveryRun(
  runId: string,
  userId: string,
): Promise<DiscoveryRun> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("discovery_runs")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("run_id", runId)
    .eq("user_id", userId)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  if (error) throw new Error("Failed to start the discovery run.");
  if (data) return rowToRun(data as DiscoveryRunRow);
  // Already running (idempotent) or reached a terminal state meanwhile.
  const existing = await getDiscoveryRun(runId, userId);
  if (!existing) throw new Error("Discovery run not found.");
  return existing;
}

/**
 * Stop Search: PENDING/RUNNING → CANCELLED. Idempotent — a run that is
 * already terminal is returned unchanged (the client sees the final state).
 */
export async function cancelDiscoveryRun(
  runId: string,
  userId: string,
): Promise<DiscoveryRun> {
  const run = await getDiscoveryRun(runId, userId);
  if (!run) throw new Error("Discovery run not found.");
  if (TERMINAL_RUN_STATUSES.includes(run.status)) return run;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("discovery_runs")
    .update({ status: "cancelled", finished_at: new Date().toISOString() })
    .eq("run_id", runId)
    .eq("user_id", userId)
    .in("status", ["pending", "running"])
    .select("*")
    .maybeSingle();
  if (error) throw new Error("Failed to cancel the discovery run.");
  if (data) return rowToRun(data as DiscoveryRunRow);
  // Lost the race with a finishing orchestrator → return the final row.
  const final = await getDiscoveryRun(runId, userId);
  if (!final) throw new Error("Discovery run not found.");
  return final;
}

/**
 * Continue Research: the batch-continuation transition.
 *
 * A run that reached its invocation limit before the target finishes as
 * `partial` — its persisted companies and counters are the CHECKPOINT.
 * Continuing reopens it (`partial → running`, `finished_at` cleared) so a new
 * batch can process only the companies the checkpoint has not verified yet.
 *
 * Rules (mirroring cancel's race posture):
 *  - idempotent for a `running` run (the client just gets the live row);
 *  - ONLY `partial` or `pending` may be continued: a `completed` run reached
 *    its target (nothing to do), `cancelled`/`failed` were terminal by
 *    decision or fault and are never silently reopened;
 *  - the update is conditional on the status, so a run that finished
 *    meanwhile is returned as-is, never overwritten.
 */
export async function continueDiscoveryRun(
  runId: string,
  userId: string,
): Promise<DiscoveryRun> {
  const run = await getDiscoveryRun(runId, userId);
  if (!run) throw new Error("Discovery run not found.");
  if (run.status === "running" || run.status === "pending") return run;
  if (run.status !== "partial") {
    throw new Error("Only a run that ended before its target can be continued.");
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("discovery_runs")
    .update({ status: "running", finished_at: null })
    .eq("run_id", runId)
    .eq("user_id", userId)
    .eq("status", "partial")
    .select("*")
    .maybeSingle();
  if (error) throw new Error("Failed to continue the discovery run.");
  if (data) return rowToRun(data as DiscoveryRunRow);
  // Lost the race with another continuation/finisher → return the final row.
  const current = await getDiscoveryRun(runId, userId);
  if (!current) throw new Error("Discovery run not found.");
  return current;
}

/**
 * The run's persisted research memory (one snapshot per goal pass), or null
 * when none is stored yet (fresh run / pre-migration database / column
 * absent). The continue path restores each planner from it — a defensive
 * parse keeps a malformed value from breaking the run (a bad memory degrades
 * to a fresh planner).
 */
export async function getResearchMemory(
  runId: string,
  userId: string,
): Promise<ResearchMemoryStore | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("discovery_runs")
    .select("research_memory")
    .eq("run_id", runId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    if (!isUnknownColumnError(error)) throw error;
    // Column not deployed yet — no memory, the run continues fresh.
    return null;
  }
  const raw = (data as { research_memory?: unknown } | null)?.research_memory;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const store: ResearchMemoryStore = {};
  for (const [goal, snap] of Object.entries(raw as Record<string, unknown>)) {
    if (goal !== "ausbildung" && goal !== "arbeit") continue;
    if (!snap || typeof snap !== "object") continue;
    if ((snap as { v?: unknown }).v !== 1) continue;
    store[goal] = snap as ResearchMemoryStore[typeof goal];
  }
  return Object.keys(store).length > 0 ? store : null;
}

export interface FinishRunOutcome {
  status: "completed" | "partial" | "failed";
  foundCompanies: number;
  offersAnalyzed: number;
  uniqueCompanies: number;
  duplicatesRemoved: number;
  companiesRejected: number;
  /** The three-outcome counters (§4.8). */
  emailsFound?: number;
  noPublicEmail?: number;
  sourcesBlocked?: number;
  companiesProcessed?: number;
  sources: DiscoverySourceStatus[];
  error?: string | null;
}

/** Terminal write for a run (the orchestrator calls this exactly once). */
export async function finishDiscoveryRun(
  runId: string,
  userId: string,
  outcome: FinishRunOutcome,
): Promise<DiscoveryRun> {
  const admin = createAdminClient();
  const patch: Record<string, unknown> = {
    status: outcome.status,
    found_companies: outcome.foundCompanies,
    offers_analyzed: outcome.offersAnalyzed,
    unique_companies: outcome.uniqueCompanies,
    duplicates_removed: outcome.duplicatesRemoved,
    companies_rejected: outcome.companiesRejected,
    emails_found: outcome.emailsFound ?? 0,
    no_public_email: outcome.noPublicEmail ?? 0,
    sources_blocked: outcome.sourcesBlocked ?? 0,
    companies_processed: outcome.companiesProcessed ?? 0,
    sources: outcome.sources,
    error: outcome.error ?? null,
    finished_at: new Date().toISOString(),
  };
  let { data, error } = await admin
    .from("discovery_runs")
    .update(patch)
    .eq("run_id", runId)
    .eq("user_id", userId)
    .in("status", ["pending", "running"])
    .select("*")
    .maybeSingle();
  if (error && isUnknownColumnError(error)) {
    // The counter columns are not deployed yet: finish the run anyway, keep
    // the counters the schema does have, and make the drift loud.
    console.error(
      "[company-discovery] discovery_runs counter columns are missing — finishing the run without (emails_found/no_public_email/sources_blocked/companies_processed). Apply supabase/migrations/20261019000000_discovery_multi_source.sql.",
    );
    ({ data, error } = await admin
      .from("discovery_runs")
      .update(withoutMigrationKeys(patch))
      .eq("run_id", runId)
      .eq("user_id", userId)
      .in("status", ["pending", "running"])
      .select("*")
      .maybeSingle());
  }
  if (error) throw new Error("Failed to finish the discovery run.");
  if (!data) {
    const final = await getDiscoveryRun(runId, userId);
    if (!final) throw new Error("Discovery run not found.");
    return final;
  }
  return rowToRun(data as DiscoveryRunRow);
}

/**
 * Progress counters for the live UI (real values only). The single writer of
 * a run SETS the absolute counter values it holds after each batch.
 */
export async function setRunCounters(
  runId: string,
  userId: string,
  counters: Partial<
    Pick<
      DiscoveryProgress,
      | "foundCompanies"
      | "offersAnalyzed"
      | "uniqueCompanies"
      | "duplicatesRemoved"
      | "companiesRejected"
      | "emailsFound"
      | "noPublicEmail"
      | "sourcesBlocked"
  | "companiesProcessed"
  | "currentQuery"
  | "currentSource"
  | "currentStrategy"
    >
  > & {
    /** The run's research memory (persisted on every batch checkpoint). */
    researchMemory?: ResearchMemoryStore | null;
  },
  sources?: DiscoverySourceStatus[],
): Promise<void> {
  const admin = createAdminClient();
  const patch: Record<string, unknown> = {};
  if (counters.foundCompanies !== undefined)
    patch.found_companies = counters.foundCompanies;
  if (counters.offersAnalyzed !== undefined)
    patch.offers_analyzed = counters.offersAnalyzed;
  if (counters.uniqueCompanies !== undefined)
    patch.unique_companies = counters.uniqueCompanies;
  if (counters.duplicatesRemoved !== undefined)
    patch.duplicates_removed = counters.duplicatesRemoved;
  if (counters.companiesRejected !== undefined)
    patch.companies_rejected = counters.companiesRejected;
  if (counters.emailsFound !== undefined) patch.emails_found = counters.emailsFound;
  if (counters.noPublicEmail !== undefined)
    patch.no_public_email = counters.noPublicEmail;
  if (counters.sourcesBlocked !== undefined)
    patch.sources_blocked = counters.sourcesBlocked;
  if (counters.companiesProcessed !== undefined)
    patch.companies_processed = counters.companiesProcessed;
  // Live research state (the "Current query / Current source" UI).
  if (counters.currentQuery !== undefined)
    patch.current_query = counters.currentQuery;
  if (counters.currentSource !== undefined)
    patch.current_source = counters.currentSource;
  if (counters.currentStrategy !== undefined)
    patch.current_strategy = counters.currentStrategy;
  // Research memory (Continue never re-issues; survives a kill).
  if (counters.researchMemory !== undefined)
    patch.research_memory = counters.researchMemory;
  if (sources !== undefined) patch.sources = sources;
  if (Object.keys(patch).length === 0) return;
  let { error } = await admin
    .from("discovery_runs")
    .update(patch)
    .eq("run_id", runId)
    .eq("user_id", userId)
    .eq("status", "running");
  if (error && isUnknownColumnError(error)) {
    // Progress must keep flowing on a database without the new counters.
    ({ error } = await admin
      .from("discovery_runs")
      .update(withoutMigrationKeys(patch))
      .eq("run_id", runId)
      .eq("user_id", userId)
      .eq("status", "running"));
  }
  if (error) throw new Error("Failed to update the discovery run counters.");
}

// ---------------------------------------------------------------------------
// Result persistence (idempotent — the orchestrator may safely retry)
// ---------------------------------------------------------------------------

/** Record a raw candidate offer (deduped by candidate_ref within the run). */
export async function recordCandidate(
  runId: string,
  candidate: DiscoveryCandidate,
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("discovery_candidates").upsert(
    {
      run_id: runId,
      candidate_ref: candidate.candidateRef,
      source: candidate.source,
      title: candidate.title,
      company_name: candidate.companyName,
      city: candidate.city,
      goal: candidate.goal,
      beginn: candidate.beginn,
      salary_label: candidate.salaryLabel,
      url: candidate.url,
    },
    { onConflict: "run_id,candidate_ref" },
  );
  if (error) throw new Error("Failed to record the discovery candidate.");
}

/**
 * The facts of one unique company for the run. (The email is stored in its
 * own table via `recordCompanyEmail` — provenance stays separate.)
 */
export interface CompanyRecord {
  companyKey: string;
  companyName: string;
  websiteUrl: string | null;
  websiteSourceUrl: string | null;
  role: string | null;
  field: string;
  offerType: "ausbildung" | "arbeit";
  city: string | null;
  state: string | null;
  beginn: string | null;
  salaryLabel: string | null;
  offerSource: string | null;
  offerUrl: string | null;
  status: "accepted" | "rejected";
  rejectReason?: string | null;
  /**
   * The company-level outcome (§4.4). Stored separately from `rejectReason`
   * so `source_blocked` can never be misread as `no_public_email`.
   */
  emailStatus?: "email_found" | "no_public_email" | "source_blocked" | null;
  /** The application/career page actually inspected this run, or null
   *  (never a URL derived from the domain). */
  applicationUrl?: string | null;
  /** The counted offer's documented start matches the run's concrete beginn
   *  year (true), is documented but different (false), or is not documented
   *  at all (null — never guessed). */
  beginnYearConfirmed?: boolean | null;
  /** 0–100, derived from the stored evidence of the verified email, or null
   *  when the company has no public email. */
  confidenceScore?: number | null;
  /** The company's evidence ledger — the pages actually opened and what each
   *  documented (stored facts only, never guessed). */
  evidence?: CompanyEvidenceItem[] | null;
  /** One human-readable reason per applied confidence weight. */
  confidenceReasons?: string[] | null;
  /** True when documented facts contradict each other (never silently
   *  dropped — it also lowers the score). */
  conflict?: boolean | null;
}

/**
 * Batch-record candidate offers (idempotent per (run_id, candidate_ref)).
 * Chunked upserts keep statement size bounded; the natural-key conflict
 * keeps retries duplicate-free.
 */
export async function recordCandidates(
  runId: string,
  candidates: DiscoveryCandidate[],
): Promise<void> {
  if (candidates.length === 0) return;
  const admin = createAdminClient();
  const rows = candidates.map((candidate) => ({
    run_id: runId,
    candidate_ref: candidate.candidateRef,
    source: candidate.source,
    title: candidate.title,
    company_name: candidate.companyName,
    city: candidate.city,
    goal: candidate.goal,
    beginn: candidate.beginn,
    salary_label: candidate.salaryLabel,
    url: candidate.url,
  }));
  for (let i = 0; i < rows.length; i += 50) {
    const { error } = await admin
      .from("discovery_candidates")
      .upsert(rows.slice(i, i + 50), {
        onConflict: "run_id,candidate_ref",
        ignoreDuplicates: true,
      });
    if (error) throw new Error("Failed to record the discovery candidates.");
  }
}

/**
 * Record a unique company (idempotent per (run_id, company_key)).
 *
 * `created` is false when the company already exists in this run — the
 * dedupe guarantee the whole engine relies on. The FIRST accepted row keeps
 * its counting facts; the unique constraint is the structural backstop.
 */
export async function recordCompany(
  runId: string,
  company: CompanyRecord,
): Promise<{ companyId: string; created: boolean }> {
  const admin = createAdminClient();
  const existing = await admin
    .from("discovery_companies")
    .select("id")
    .eq("run_id", runId)
    .eq("company_key", company.companyKey)
    .maybeSingle();
  if (existing.data) {
    return { companyId: existing.data.id as string, created: false };
  }
  const patch: Record<string, unknown> = {
    run_id: runId,
    company_key: company.companyKey,
    company_name: company.companyName,
    website_url: company.websiteUrl,
    website_source_url: company.websiteSourceUrl,
    role: company.role,
    field: company.field,
    offer_type: company.offerType,
    city: company.city,
    state: company.state,
    beginn: company.beginn,
    salary_label: company.salaryLabel,
    offer_source: company.offerSource,
    offer_url: company.offerUrl,
    status: company.status,
    reject_reason: company.rejectReason ?? null,
    email_status: company.emailStatus ?? null,
    // Verification facts (agentic-research migration): undefined → omitted,
    // so a pre-migration database is never asked for columns it lacks.
    ...(company.applicationUrl !== undefined
      ? { application_url: company.applicationUrl }
      : {}),
    ...(company.beginnYearConfirmed !== undefined
      ? { beginn_year_confirmed: company.beginnYearConfirmed }
      : {}),
    ...(company.confidenceScore !== undefined
      ? { confidence_score: company.confidenceScore }
      : {}),
    // Evidence ledger (research-memory migration): stored facts only.
    ...(company.evidence !== undefined ? { evidence: company.evidence } : {}),
    ...(company.confidenceReasons !== undefined
      ? { confidence_reasons: company.confidenceReasons }
      : {}),
    ...(company.conflict !== undefined
      ? { conflict: company.conflict ?? false }
      : {}),
  };
  let { data, error } = await admin
    .from("discovery_companies")
    .insert(patch)
    .select("id")
    .single();
  if (error && isUnknownColumnError(error)) {
    // The outcome column is not deployed yet: keep the row, lose the label.
    console.error(
      "[company-discovery] discovery_companies.email_status is missing — storing the company without its outcome label. Apply supabase/migrations/20261019000000_discovery_multi_source.sql.",
    );
    ({ data, error } = await admin
      .from("discovery_companies")
      .insert(withoutMigrationKeys(patch))
      .select("id")
      .single());
  }
  if (error || !data) {
    throw new Error("Failed to record the discovered company.");
  }
  return { companyId: data.id as string, created: true };
}

/**
 * The user's most recent run, or null when they never started one. Used by the
 * page to render the LAST persisted result instead of an empty form after a
 * refresh or a re-login (results are never kept in client state only).
 */
export async function getLatestDiscoveryRun(
  userId: string,
): Promise<DiscoveryRun | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("discovery_runs")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return rowToRun(data as DiscoveryRunRow);
}

/** One stored public email with its mandatory provenance (§4.5). */
export interface RunCompanyEmail {
  email: string;
  /** The primary page (highest-priority source), or null for legacy rows. */
  sourceUrl: string | null;
  sourceType: DiscoveryEmailSource;
  confidence: "high" | "medium" | "low" | null;
  /** Every page the address was literally found on, primary first. */
  sourceUrls: string[];
  verificationStatus: string | null;
  verificationMethod: string | null;
  domainMatch: boolean | null;
  evidenceSnippet: string | null;
  discoveredAt: string | null;
}

/** A discovered company of a run, with the addresses published for it. */
export interface RunCompanyResult {
  companyId: string;
  companyKey: string;
  companyName: string;
  websiteUrl: string | null;
  role: string | null;
  field: string | null;
  offerType: string | null;
  city: string | null;
  state: string | null;
  beginn: string | null;
  salaryLabel: string | null;
  offerSource: string | null;
  offerUrl: string | null;
  status: string;
  rejectReason: string | null;
  /** The company-level outcome (§4.4), or null on a non-migrated database. */
  emailStatus: string | null;
  /** The application/career page actually inspected, or null. */
  applicationUrl: string | null;
  /** Documented start matches the run's beginn year / documented but
   *  different / not documented at all. */
  beginnYearConfirmed: boolean | null;
  /** 0–100 evidence-derived company confidence, or null. */
  confidenceScore: number | null;
  /** The evidence ledger (pages actually opened + what they documented);
   *  empty on a pre-migration row. */
  evidence: CompanyEvidenceItem[];
  /** One reason per applied confidence weight (the score is readable). */
  confidenceReasons: string[];
  /** Documented facts contradict each other (e.g. start year differs). */
  conflict: boolean;
  /** Empty when the company published no address — the UI says so explicitly. */
  emails: RunCompanyEmail[];
}

/**
 * The persisted outcome of a run: every discovered company with the public
 * addresses stored for it. This is what makes a result survive a refresh or a
 * re-login — the UI never reconstructs it from client state.
 *
 * Ownership is enforced here (user_id filter via the run), so a caller can
 * never read another user's companies. A missing run returns an empty list;
 * callers that need to distinguish "no run" from "no rows" use
 * {@link getDiscoveryRunStrict} first.
 */
export async function listRunCompaniesWithEmails(
  runId: string,
  userId: string,
): Promise<RunCompanyResult[]> {
  const admin = createAdminClient();
  const { data: run, error: runError } = await admin
    .from("discovery_runs")
    .select("run_id")
    .eq("run_id", runId)
    .eq("user_id", userId)
    .maybeSingle();
  if (runError) throw runError;
  if (!run) return [];

  const { data: companies, error: companyError } = await admin
    .from("discovery_companies")
    .select("*")
    .eq("run_id", runId)
    .order("discovered_at", { ascending: true });
  if (companyError) throw companyError;
  const rows = (companies ?? []) as DiscoveryCompanyRow[];
  if (rows.length === 0) return [];

  const companyIds = rows.map((row) => row.id);
  let emailRows: unknown[] | null;
  const primaryEmailQuery = await admin
    .from("discovery_company_emails")
    .select(
      "id, company_id, email, email_source_url, email_source_type, confidence, verification_status, verification_method, domain_match, evidence_snippet, discovered_at",
    )
    .in("company_id", companyIds);
  if (primaryEmailQuery.error && isUnknownColumnError(primaryEmailQuery.error)) {
    // The verification columns are not deployed yet: read the base columns.
    console.error(
      "[company-discovery] discovery_company_emails verification columns are missing — reading the base columns only. Apply supabase/migrations/20261019000000_discovery_multi_source.sql.",
    );
    const fallbackQuery = await admin
      .from("discovery_company_emails")
      .select("id, company_id, email, email_source_url, email_source_type, confidence")
      .in("company_id", companyIds);
    if (fallbackQuery.error) throw fallbackQuery.error;
    emailRows = fallbackQuery.data;
  } else {
    if (primaryEmailQuery.error) throw primaryEmailQuery.error;
    emailRows = primaryEmailQuery.data;
  }

  const byCompany = new Map<string, RunCompanyEmail[]>();
  const emailIds: string[] = [];
  const byEmailId = new Map<string, RunCompanyEmail>();
  for (const row of emailRows ?? []) {
    const record = row as {
      id: string;
      company_id: string;
      email: string;
      email_source_url: string | null;
      email_source_type: DiscoveryEmailSource;
      confidence: "high" | "medium" | "low" | null;
      verification_status?: string | null;
      verification_method?: string | null;
      domain_match?: boolean | null;
      evidence_snippet?: string | null;
      discovered_at?: string | null;
    };
    const entry: RunCompanyEmail = {
      email: record.email,
      sourceUrl: record.email_source_url,
      sourceType: record.email_source_type,
      confidence: record.confidence,
      sourceUrls: record.email_source_url ? [record.email_source_url] : [],
      verificationStatus: record.verification_status ?? null,
      verificationMethod: record.verification_method ?? null,
      domainMatch: record.domain_match ?? null,
      evidenceSnippet: record.evidence_snippet ?? null,
      discoveredAt: record.discovered_at ?? null,
    };
    const list = byCompany.get(record.company_id) ?? [];
    list.push(entry);
    byCompany.set(record.company_id, list);
    if (record.id) {
      emailIds.push(record.id);
      byEmailId.set(record.id, entry);
    }
  }

  // Every page an address was found on (the additive provenance table). Its
  // absence is tolerated: the primary URL recorded above is always there.
  if (emailIds.length > 0) {
    const { data: sourceRows, error: sourceError } = await admin
      .from("discovery_company_email_sources")
      .select("email_id, source_url")
      .in("email_id", emailIds);
    if (sourceError) {
      if (!isUnknownTableError(sourceError)) throw sourceError;
      console.error(
        "[company-discovery] discovery_company_email_sources is missing — only the primary source URL is available. Apply supabase/migrations/20261019000000_discovery_multi_source.sql.",
      );
    } else {
      for (const row of sourceRows ?? []) {
        const record = row as { email_id: string; source_url: string };
        const entry = byEmailId.get(record.email_id);
        if (!entry) continue;
        if (!entry.sourceUrls.includes(record.source_url)) {
          entry.sourceUrls.push(record.source_url);
        }
      }
    }
  }

  return rows.map((row) => ({
    companyId: row.id,
    companyKey: row.company_key,
    companyName: row.company_name,
    websiteUrl: row.website_url,
    role: row.role,
    field: row.field,
    offerType: row.offer_type,
    city: row.city,
    state: row.state,
    beginn: row.beginn,
    salaryLabel: row.salary_label,
    offerSource: row.offer_source,
    offerUrl: row.offer_url,
    status: row.status,
    rejectReason: row.reject_reason,
    emailStatus: row.email_status ?? null,
    applicationUrl: row.application_url ?? null,
    beginnYearConfirmed: row.beginn_year_confirmed ?? null,
    confidenceScore: row.confidence_score ?? null,
    evidence: parseEvidence(row.evidence),
    confidenceReasons: parseStringList(row.confidence_reasons),
    conflict: row.conflict ?? false,
    emails: byCompany.get(row.id) ?? [],
  }));
}

/**
 * Store an ACCEPTED public email for a company, with its full provenance.
 *
 * The address is written exactly as it was literally read — never derived from
 * a name, never re-composed. Idempotent per `(company_id, email)`, and every
 * page the address was found on is preserved in the additive provenance table
 * (§4.5), the primary source staying in `email_source_url`.
 *
 * Returns the stored row id so the caller can attach the extra source URLs.
 */
export async function recordCompanyEmail(
  companyId: string,
  accepted: {
    email: string;
    sourceUrl: string;
    sourceType: DiscoveryEmailSource;
    sourceUrls?: string[];
    verificationStatus?: string;
    verificationMethod?: string;
    domainMatch?: boolean;
    evidenceSnippet?: string;
    confidence?: "high" | "medium" | "low" | null;
  },
): Promise<string | null> {
  const admin = createAdminClient();
  const sourceUrls = [
    ...new Set([accepted.sourceUrl, ...(accepted.sourceUrls ?? [])]),
  ].filter((url) => url.length > 0);

  const patch: Record<string, unknown> = {
    company_id: companyId,
    email: accepted.email,
    email_source_url: accepted.sourceUrl,
    email_source_type: accepted.sourceType,
    confidence: accepted.confidence ?? null,
    verification_status: accepted.verificationStatus ?? "verified",
    verification_method: accepted.verificationMethod ?? null,
    domain_match: accepted.domainMatch ?? null,
    evidence_snippet: accepted.evidenceSnippet ?? null,
  };

  let { data, error } = await admin
    .from("discovery_company_emails")
    .upsert(patch, { onConflict: "company_id,email", ignoreDuplicates: true })
    .select("id")
    .maybeSingle();
  if (error && isUnknownColumnError(error)) {
    // Provenance detail is not deployed yet: store the address and its primary
    // page, which is the part a campaign needs, and report the drift.
    console.error(
      "[company-discovery] discovery_company_emails verification columns are missing — storing the address without them. Apply supabase/migrations/20261019000000_discovery_multi_source.sql.",
    );
    ({ data, error } = await admin
      .from("discovery_company_emails")
      .upsert(
        withoutMigrationKeys(patch),
        { onConflict: "company_id,email", ignoreDuplicates: true },
      )
      .select("id")
      .maybeSingle());
  }
  if (error) throw new Error("Failed to record the company email.");

  let emailId = (data?.id as string | undefined) ?? null;
  if (!emailId) {
    // `ignoreDuplicates` returns no row when the address was already stored.
    const existing = await admin
      .from("discovery_company_emails")
      .select("id")
      .eq("company_id", companyId)
      .eq("email", accepted.email)
      .maybeSingle();
    emailId = (existing.data?.id as string | undefined) ?? null;
  }

  if (emailId && sourceUrls.length > 0) {
    const { error: sourceError } = await admin
      .from("discovery_company_email_sources")
      .upsert(
        sourceUrls.map((sourceUrl) => ({
          email_id: emailId,
          source_url: sourceUrl,
          source_type: accepted.sourceType,
        })),
        { onConflict: "email_id,source_url", ignoreDuplicates: true },
      );
    if (sourceError) {
      if (!isUnknownTableError(sourceError)) {
        console.error(
          "[company-discovery] storing the extra email sources failed",
          sourceError,
        );
      }
    }
  }

  return emailId;
}
