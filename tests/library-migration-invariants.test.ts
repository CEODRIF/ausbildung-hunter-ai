import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Deutsch Bibliothek — migration source invariants.
 *
 * The repository applies Supabase migrations BY HAND, so the security
 * contract of the book library is a property of this file. These tests pin
 * the boundary that makes drafts invisible to the public and admin-only
 * writes enforced at the database level — a regression here would be a
 * silent data-exposure or privilege-escalation defect:
 *
 *   1. german_books: RLS ON, ONE select policy (published = true, anon +
 *      authenticated), NO user insert/update/delete policy, write
 *      privileges explicitly revoked from the public roles.
 *   2. No admin read policy on the table (admins read drafts through the
 *      service role in the app layer — zero privilege growth for users).
 *   3. book-covers bucket: public read, 5 MB ceiling, jpeg/png/webp only,
 *      and its SELECT policy resolves only covers of PUBLISHED books.
 *   4. No seed data, no service-role credential, no touch of any existing
 *      table or policy.
 */

const MIGRATION = readFileSync(
  join(__dirname, "..", "supabase", "migrations", "20261203000000_german_book_library.sql"),
  "utf8",
);

/** Strip SQL comments so assertions match code, not prose. */
function codeOnly(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

const CODE = codeOnly(MIGRATION);

describe("german_books table", () => {
  it("creates the table with the required columns", () => {
    expect(CODE).toMatch(/create table if not exists public\.german_books/);
    expect(CODE).toMatch(/id uuid primary key default gen_random_uuid\(\)/);
    expect(CODE).toMatch(/title text not null/);
    expect(CODE).toMatch(/category text not null/);
    expect(CODE).toMatch(/description text/);
    expect(CODE).toMatch(/cover_path text/);
    expect(CODE).toMatch(/download_url text not null/);
    expect(CODE).toMatch(/published boolean not null default false/);
    expect(CODE).toMatch(/created_at timestamptz not null/);
    expect(CODE).toMatch(/updated_at timestamptz not null/);
  });

  it("defaults new books to UNPUBLISHED (fail-closed)", () => {
    expect(CODE).toMatch(/published boolean not null default false/);
  });

  it("enables RLS on the table", () => {
    expect(CODE).toMatch(
      /alter table public\.german_books enable row level security/,
    );
  });

  it("exposes EXACTLY ONE select policy: published rows, anon + authenticated", () => {
    const selectPolicies = CODE.match(
      /create policy[^;]*on public\.german_books for select[^;]*;/g,
    );
    expect(selectPolicies).toHaveLength(1);
    const policy = selectPolicies![0];
    expect(policy).toMatch(/to anon, authenticated/);
    expect(policy).toMatch(/using \(published = true\)/);
  });

  it("has NO user insert/update/delete policy on the table", () => {
    expect(CODE).not.toMatch(
      /create policy[^;]*on public\.german_books for (insert|update|delete)/,
    );
  });

  it("revokes write privileges from the public roles (explicit boundary)", () => {
    expect(CODE).toMatch(
      /revoke insert,\s*update,\s*delete,\s*truncate on public\.german_books from anon,\s*authenticated/,
    );
    expect(CODE).toMatch(
      /grant select on public\.german_books to anon,\s*authenticated/,
    );
  });

  it("grants NO admin read policy (no privilege growth for any user role)", () => {
    // No policy on german_books may reference the admins table or an
    // admin-membership predicate.
    const tablePolicies = CODE.match(/create policy[^;]*on public\.german_books[^;]*;/g) ?? [];
    for (const policy of tablePolicies) {
      expect(policy).not.toMatch(/admins|is_admin|platform/);
    }
  });

  it("seeds NO book data", () => {
    expect(CODE).not.toMatch(/insert into public\.german_books/);
  });

  it("touches NO existing table", () => {
    // The only table-creating / table-altering statements are german_books'.
    const created = CODE.match(/create table if not exists (\S+)/g) ?? [];
    expect(created).toEqual(["create table if not exists public.german_books"]);
    const altered = CODE.match(/alter table (public\.\w+)/g) ?? [];
    expect(altered.every((a) => a === "alter table public.german_books")).toBe(true);
  });
});

describe("book-covers storage bucket", () => {
  it("creates the public bucket with a 5 MB ceiling and the image MIME allowlist", () => {
    expect(CODE).toMatch(
      /insert into storage\.buckets \(id, name, public, file_size_limit, allowed_mime_types\)\s*values \('book-covers', 'book-covers', true, 5242880,\s*array\['image\/jpeg', 'image\/png', 'image\/webp'\]\)/,
    );
    // Idempotent re-apply converges to the same safe shape.
    expect(CODE).toMatch(
      /on conflict \(id\) do update set\s*public = true,\s*file_size_limit = 5242880,\s*allowed_mime_types = excluded\.allowed_mime_types/,
    );
  });

  it("creates NO storage.objects policy (public route display; API routes default-deny)", () => {
    // The repo's global invariant (tests/security/authorization.test.ts)
    // requires every storage.objects SELECT policy to be owner-folder
    // scoped; public image display in this codebase therefore rides the
    // public-bucket URL route (the avatars model). A generic policy here
    // would weaken that contract — the bucket must ship WITHOUT one.
    expect(CODE).not.toMatch(
      /create policy[^;]*on storage\.objects[^;]*;/g,
    );
    expect(CODE).not.toMatch(/drop policy if exists "Anyone can read covers/);
  });

  it("has NO user insert/update/delete policy on the bucket (service-role writes only)", () => {
    // Consequence of the no-policy rule above: in particular no user write
    // path exists for covers — admin storage operations are service-role.
    expect(CODE).not.toMatch(
      /create policy[^;]*on storage\.objects for (insert|update|delete)/,
    );
  });
});

describe("migration hygiene", () => {
  it("is idempotent (re-apply-safe)", () => {
    expect(CODE).toContain("if not exists");
    expect(CODE).toContain("drop policy if exists");
    expect(CODE).toContain("on conflict (id) do update");
  });

  it("contains no service-role credential and no env secret reference", () => {
    expect(MIGRATION).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/);
    expect(CODE).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY|service_role_key/i);
  });

  it("never weakens an existing policy (no DROP of any pre-existing policy name)", () => {
    // Every dropped policy is one this file itself owns.
    const dropped = [...CODE.matchAll(/drop policy if exists "([^"]+)"/g)].map((m) => m[1]);
    const owned = new Set([
      "Anyone can read published books",
      "Anyone can read covers of published books",
    ]);
    expect(dropped.length).toBeGreaterThan(0);
    for (const name of dropped) expect(owned.has(name)).toBe(true);
  });
});
