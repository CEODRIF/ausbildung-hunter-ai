import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
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
}

function isSourceStatus(value: unknown): value is DiscoverySourceStatus["status"] {
  return (
    value === "ok" ||
    value === "running" ||
    value === "unavailable" ||
    value === "skipped"
  );
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
      ...(typeof item.candidates === "number" ? { candidates: item.candidates } : {}),
    });
  }
  return out;
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

export interface FinishRunOutcome {
  status: "completed" | "partial" | "failed";
  foundCompanies: number;
  offersAnalyzed: number;
  uniqueCompanies: number;
  duplicatesRemoved: number;
  companiesRejected: number;
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
  const { data, error } = await admin
    .from("discovery_runs")
    .update({
      status: outcome.status,
      found_companies: outcome.foundCompanies,
      offers_analyzed: outcome.offersAnalyzed,
      unique_companies: outcome.uniqueCompanies,
      duplicates_removed: outcome.duplicatesRemoved,
      companies_rejected: outcome.companiesRejected,
      sources: outcome.sources,
      error: outcome.error ?? null,
      finished_at: new Date().toISOString(),
    })
    .eq("run_id", runId)
    .eq("user_id", userId)
    .in("status", ["pending", "running"])
    .select("*")
    .maybeSingle();
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
    >
  >,
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
  if (sources !== undefined) patch.sources = sources;
  if (Object.keys(patch).length === 0) return;
  const { error } = await admin
    .from("discovery_runs")
    .update(patch)
    .eq("run_id", runId)
    .eq("user_id", userId)
    .eq("status", "running");
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
  const { data, error } = await admin
    .from("discovery_companies")
    .insert({
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
    })
    .select("id")
    .single();
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

/** One stored public email with its mandatory provenance. */
export interface RunCompanyEmail {
  email: string;
  sourceUrl: string | null;
  sourceType: DiscoveryEmailSource;
  confidence: "high" | "medium" | "low" | null;
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

  const { data: emailRows, error: emailError } = await admin
    .from("discovery_company_emails")
    .select("company_id, email, email_source_url, email_source_type, confidence")
    .in(
      "company_id",
      rows.map((row) => row.id),
    );
  if (emailError) throw emailError;

  const byCompany = new Map<string, RunCompanyEmail[]>();
  for (const row of emailRows ?? []) {
    const record = row as {
      company_id: string;
      email: string;
      email_source_url: string | null;
      email_source_type: DiscoveryEmailSource;
      confidence: "high" | "medium" | "low" | null;
    };
    const list = byCompany.get(record.company_id) ?? [];
    list.push({
      email: record.email,
      sourceUrl: record.email_source_url,
      sourceType: record.email_source_type,
      confidence: record.confidence,
    });
    byCompany.set(record.company_id, list);
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
    emails: byCompany.get(row.id) ?? [],
  }));
}

/**
 * Store a public email for a company (idempotent per (company_id, email)).
 * The address is stored exactly as published — never derived from a name.
 */
export async function recordCompanyEmail(
  companyId: string,
  email: string,
  sourceUrl: string | null,
  sourceType: DiscoveryEmailSource,
  confidence: "high" | "medium" | "low" | null = null,
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("discovery_company_emails")
    .upsert(
      {
        company_id: companyId,
        email,
        email_source_url: sourceUrl,
        email_source_type: sourceType,
        confidence,
      },
      { onConflict: "company_id,email", ignoreDuplicates: true },
    );
  if (error) throw new Error("Failed to record the company email.");
}
