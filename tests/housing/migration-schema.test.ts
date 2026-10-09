import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for the housing migration (20261106000000_housing_mvp.sql).
 * The app code (saved.ts / application.ts) only ever touches columns that this
 * migration creates, and every user table must be RLS-scoped to auth.uid() =
 * user_id while the listing cache stays server-owned. If the migration and the
 * code drift, this fails — the same production failure mode the opportunities
 * guard protects against (a 42703 from PostgREST on an unmigrated column).
 */

const sql = readFileSync(
  new URL(
    "../../supabase/migrations/20261106000000_housing_mvp.sql",
    import.meta.url,
  ),
  "utf8",
);

const SAVED_LISTINGS_COLS = [
  "id",
  "user_id",
  "provider",
  "source_listing_id",
  "url",
  "snapshot",
  "notes",
  "status",
  "saved_at",
];
const SAVED_SEARCHES_COLS = [
  "id",
  "user_id",
  "name",
  "query",
  "last_run_at",
  "last_count",
  "created_at",
];
const APPLICATIONS_COLS = [
  "id",
  "user_id",
  "listing_ref",
  "title",
  "message_draft",
  "status",
  "timeline",
  "created_at",
  "updated_at",
];

describe("housing migration", () => {
  it("creates all four tables", () => {
    expect(sql).toContain("create table if not exists public.housing_listings");
    expect(sql).toContain("create table if not exists public.housing_saved_listings");
    expect(sql).toContain("create table if not exists public.housing_saved_searches");
    expect(sql).toContain("create table if not exists public.housing_applications");
  });

  it("defines every column the app code reads/writes", () => {
    for (const col of [...SAVED_LISTINGS_COLS, ...SAVED_SEARCHES_COLS, ...APPLICATIONS_COLS]) {
      // Each column name must appear in the migration (as a column definition).
      expect(sql).toMatch(new RegExp(`\\b${col}\\b`));
    }
  });

  it("scopes all three user tables to auth.uid() = user_id", () => {
    for (const table of [
      "housing_saved_listings",
      "housing_saved_searches",
      "housing_applications",
    ]) {
      expect(sql).toMatch(
        new RegExp(
          `on public\\.${table} for all to authenticated\\s+using \\(auth\\.uid\\(\\) = user_id\\)\\s+with check \\(auth\\.uid\\(\\) = user_id\\)`,
        ),
      );
    }
  });

  it("enables RLS on every user table", () => {
    for (const table of [
      "housing_saved_listings",
      "housing_saved_searches",
      "housing_applications",
    ]) {
      expect(sql).toContain(`alter table public.${table} enable row level security;`);
    }
  });

  it("keeps the listing cache server-owned (RLS on, no policy, access revoked)", () => {
    expect(sql).toContain("alter table public.housing_listings enable row level security;");
    expect(sql).toContain(
      "revoke all on public.housing_listings from anon, authenticated;",
    );
    // The cache must NOT get an authenticated user policy.
    expect(sql).not.toMatch(
      /on public\.housing_listings for all to authenticated/,
    );
  });

  it("dedupes saved listings per user on provider identity", () => {
    expect(sql).toContain("unique (user_id, provider, source_listing_id)");
  });

  it("dedupes the listing cache on provider identity", () => {
    expect(sql).toContain("unique (provider, source_id)");
  });

  it("constrains the data_status and lifecycle enums", () => {
    expect(sql).toContain("check (data_status in ('demo', 'live'))");
    expect(sql).toContain(
      "check (status in ('draft', 'prepared', 'contacted', 'viewing', 'accepted', 'declined'))",
    );
  });
});
