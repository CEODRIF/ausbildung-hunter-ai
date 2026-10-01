import "server-only";

import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeIdentity } from "../web-discovery";

/**
 * Per-company enrichment cache (AI Search 2.0).
 *
 * Contact discovery is a COMPANY-level asset: all vacancies of the same
 * company share one website / impressum result. Caching per company
 * (not per vacancy) is what keeps the pipeline fast and gentle:
 *
 * - memory:    per-process LRU-ish map (Vercel instances) — instant.
 * - database:  `company_enrichment` (service-role only, same posture as
 *              opportunity_cache) — survives cold starts / redeploys.
 *
 * TTL is outcome-aware: a found email is re-checked at most every 30
 * days; a negative result ("no public email") only every 24 hours, so a
 * contact the company publishes later shows up quickly.
 *
 * The cache stores RESULTS (facts + provenance URLs), never credentials;
 * read/write failures degrade to "no cache" — the pipeline never fails
 * because of the cache.
 */

const POSITIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MEMORY_MAX_ENTRIES = 500;

export interface CompanyEnrichmentRecord {
  company_key: string;
  company_name: string;
  /** True when the checks actually ran (→ not_found is honest). */
  checked: boolean;
  website_url: string | null;
  website_source: string | null;
  career_url: string | null;
  ausbildung_url: string | null;
  email: string | null;
  email_source: string | null;
  phone: string | null;
  phone_source: string | null;
  contact_name: string | null;
  contact_source: string | null;
  data_confidence: "high" | "medium" | "low" | null;
  last_verified_at: string | null;
}

interface MemoryEntry {
  record: CompanyEnrichmentRecord;
  expiresAt: number;
}

const memory = new Map<string, MemoryEntry>();

/** Stable cache key from the source-documented company name.
 *  Empty string = no documented company name (enrichment impossible). */
export function companyKeyOf(companyName: string | null): string {
  return normalizeIdentity(companyName);
}

function ttlFor(record: CompanyEnrichmentRecord): number {
  return record.email !== null || record.website_url !== null
    ? POSITIVE_TTL_MS
    : NEGATIVE_TTL_MS;
}

function readMemory(companyKey: string): CompanyEnrichmentRecord | null {
  const entry = memory.get(companyKey);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    memory.delete(companyKey);
    return null;
  }
  return entry.record;
}

function writeMemory(record: CompanyEnrichmentRecord): void {
  if (memory.size >= MEMORY_MAX_ENTRIES) {
    // Evict the oldest-inserted entry (Map preserves insertion order).
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
  memory.set(record.company_key, {
    record,
    expiresAt: Date.now() + ttlFor(record),
  });
}

/** Read a fresh cached enrichment (memory first, then DB). Null on miss. */
export async function readCompanyCache(
  companyKey: string,
): Promise<CompanyEnrichmentRecord | null> {
  if (!companyKey) return null;
  const mem = readMemory(companyKey);
  if (mem) return mem;
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("company_enrichment")
      .select("data, expires_at")
      .eq("company_key", companyKey)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as { data: unknown; expires_at: string };
    if (new Date(row.expires_at).getTime() <= Date.now()) return null;
    const parsed = CompanyEnrichmentRecordShape.safeParse(row.data);
    if (!parsed.success) return null;
    writeMemory(parsed.data);
    return parsed.data;
  } catch {
    return null; // cache read is best-effort
  }
}

/** Persist an enrichment result (memory always; DB best-effort). */
export async function writeCompanyCache(
  record: CompanyEnrichmentRecord,
): Promise<void> {
  if (!record.company_key) return;
  writeMemory(record);
  try {
    const admin = createAdminClient();
    const { error } = await admin.from("company_enrichment").upsert(
      {
        company_key: record.company_key,
        company_name: record.company_name,
        data: record,
        fetched_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + ttlFor(record)).toISOString(),
      },
      { onConflict: "company_key" },
    );
    if (error) console.warn("[enrichment-cache] upsert failed", error.message);
  } catch (error) {
    console.warn(
      "[enrichment-cache] upsert unavailable",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Test hook: clear the in-process cache. */
export function clearCompanyMemoryCache(): void {
  memory.clear();
}

// Local shape (avoids a server-only import cycle with the parent index).
const confidence = z.enum(["high", "medium", "low"]);
const urlOrNull = z.string().url().max(500).nullable();
export const CompanyEnrichmentRecordShape = z.object({
  company_key: z.string().min(1).max(160),
  company_name: z.string().min(1).max(200),
  checked: z.boolean(),
  website_url: urlOrNull,
  website_source: urlOrNull,
  career_url: urlOrNull,
  ausbildung_url: urlOrNull,
  email: z.string().max(254).nullable(),
  email_source: urlOrNull,
  phone: z.string().max(64).nullable(),
  phone_source: urlOrNull,
  contact_name: z.string().max(160).nullable(),
  contact_source: urlOrNull,
  data_confidence: confidence.nullable(),
  last_verified_at: z.string().nullable(),
});
