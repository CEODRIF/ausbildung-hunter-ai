import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { findListingById } from "./providers";
import type {
  HousingSearchParams,
  SavedHousingListing,
  SavedHousingSearch,
  SavedListingStatus,
} from "./types";

/**
 * Housing / "Wohnen" — per-user persistence (saved listings + saved searches).
 *
 * Mirrors the canonical opportunities/saved.ts contract:
 *   * only the provider + source id (and the user's own notes/status) come from
 *     the client; the listing data is re-derived server-side, so clients cannot
 *     inject titles, prices, or URLs;
 *   * every read/write is scoped to `auth.uid()` (RLS enforces this in the DB
 *     AND we always pass user_id from the session);
 *   * explicit column lists kept in sync with the migration.
 */

const SAVED_LISTINGS_SELECT =
  "id, user_id, provider, source_listing_id, url, snapshot, notes, status, saved_at";

const SAVED_SEARCHES_SELECT =
  "id, user_id, name, query, last_run_at, last_count, created_at";

const LISTING_STATUSES: SavedListingStatus[] = [
  "saved",
  "applied",
  "viewing",
  "rejected",
  "closed",
];

export function isSavedListingStatus(value: string): value is SavedListingStatus {
  return (LISTING_STATUSES as string[]).includes(value);
}

// --- Saved listings ----------------------------------------------------------

function rowToListing(row: Record<string, unknown>): SavedHousingListing {
  return {
    id: row.id as string,
    user_id: row.user_id as string,
    provider: row.provider as string,
    source_listing_id: row.source_listing_id as string,
    url: row.url as string,
    snapshot: row.snapshot as SavedHousingListing["snapshot"],
    notes: (row.notes as string | null) ?? null,
    status: (row.status as SavedListingStatus) ?? "saved",
    saved_at: row.saved_at as string,
  };
}

/**
 * Save a listing for the user. The client sends only provider + source id (and
 * optional notes); the snapshot is re-derived server-side.
 */
export async function saveHousingListing(
  userId: string,
  provider: string,
  sourceId: string,
  notes?: string,
): Promise<SavedHousingListing> {
  const listing = findListingById(provider, sourceId);
  if (!listing) {
    throw new Error("Listing not found.");
  }
  const admin = createAdminClient();
  const { error } = await admin
    .from("housing_saved_listings")
    .upsert(
      {
        user_id: userId,
        provider: listing.provider,
        source_listing_id: listing.source_id,
        url: listing.listing_url,
        snapshot: listing,
        notes: notes ?? null,
        status: "saved",
      },
      { onConflict: "user_id,provider,source_listing_id", ignoreDuplicates: true },
    );
  if (error) throw new Error(error.message);
  const row = await getSavedListing(userId, listing.provider, listing.source_id);
  if (!row) throw new Error("Saved listing could not be read back.");
  return row;
}

export async function getSavedListing(
  userId: string,
  provider: string,
  sourceId: string,
): Promise<SavedHousingListing | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("housing_saved_listings")
    .select(SAVED_LISTINGS_SELECT)
    .eq("user_id", userId)
    .eq("provider", provider)
    .eq("source_listing_id", sourceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return rowToListing(data as Record<string, unknown>);
}

export async function listSavedListings(
  userId: string,
): Promise<SavedHousingListing[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("housing_saved_listings")
    .select(SAVED_LISTINGS_SELECT)
    .eq("user_id", userId)
    .order("saved_at", { ascending: false });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map(rowToListing);
}

export async function removeSavedListing(
  userId: string,
  provider: string,
  sourceId: string,
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("housing_saved_listings")
    .delete()
    .eq("user_id", userId)
    .eq("provider", provider)
    .eq("source_listing_id", sourceId);
  if (error) throw new Error(error.message);
}

export async function updateSavedListingNotes(
  userId: string,
  provider: string,
  sourceId: string,
  notes: string,
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("housing_saved_listings")
    .update({ notes })
    .eq("user_id", userId)
    .eq("provider", provider)
    .eq("source_listing_id", sourceId);
  if (error) throw new Error(error.message);
}

export async function updateSavedListingStatus(
  userId: string,
  provider: string,
  sourceId: string,
  status: SavedListingStatus,
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("housing_saved_listings")
    .update({ status })
    .eq("user_id", userId)
    .eq("provider", provider)
    .eq("source_listing_id", sourceId);
  if (error) throw new Error(error.message);
}

// --- Saved searches ----------------------------------------------------------

function rowToSearch(row: Record<string, unknown>): SavedHousingSearch {
  return {
    id: row.id as string,
    user_id: row.user_id as string,
    name: (row.name as string | null) ?? null,
    query: (row.query as HousingSearchParams) ?? ({} as HousingSearchParams),
    last_run_at: (row.last_run_at as string | null) ?? null,
    last_count: (row.last_count as number) ?? 0,
    created_at: row.created_at as string,
  };
}

export async function saveHousingSearch(
  userId: string,
  name: string | null,
  query: HousingSearchParams,
  lastCount: number,
): Promise<SavedHousingSearch> {
  const admin = createAdminClient();
  const ts = new Date().toISOString();
  const { data, error } = await admin
    .from("housing_saved_searches")
    .insert({
      user_id: userId,
      name,
      query,
      last_run_at: ts,
      last_count: lastCount,
      created_at: ts,
    })
    .select(SAVED_SEARCHES_SELECT)
    .single();
  if (error || !data) {
    throw new Error(error?.message ?? "Could not save search.");
  }
  return rowToSearch(data as Record<string, unknown>);
}

export async function listSavedSearches(
  userId: string,
): Promise<SavedHousingSearch[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("housing_saved_searches")
    .select(SAVED_SEARCHES_SELECT)
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map(rowToSearch);
}

export async function removeSavedSearch(
  userId: string,
  searchId: string,
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("housing_saved_searches")
    .delete()
    .eq("user_id", userId)
    .eq("id", searchId);
  if (error) throw new Error(error.message);
}
