/**
 * Migration SQL regression — reserved-word identifiers.
 *
 * Production incident: 20261020000000_deckblatt_usage.sql declared
 *
 *   create or replace function public.get_deckblatt_usage_status(...)
 *   returns table (
 *     limit integer,      -- ERROR 42601: syntax error at or near "limit"
 *     ...
 *   )
 *
 * LIMIT is a FULLY RESERVED PostgreSQL word and cannot be an unquoted
 * identifier (column, RETURNS TABLE field, parameter, variable). The whole
 * migration aborted in the Supabase SQL editor, so none of the deckblatt
 * quota RPCs ever existed in production and /deckblatt degraded to
 * "Die Nutzungsbegrenzung konnte nicht geprüft werden."
 *
 * The TypeScript gates never caught this because they do not execute SQL.
 * This suite statically scans EVERY migration for fully-reserved words in
 * declaration positions (create table columns, returns table fields,
 * function parameters, plpgsql DECLARE variables). It also records the
 * exact deckblatt rename (`limit` → `daily_limit`) and the matching
 * TypeScript mapping.
 *
 * The set contains ONLY fully reserved PostgreSQL words — non-reserved
 * words that are legal identifiers in PostgreSQL (user, date, type,
 * status, value, key, ...) are deliberately excluded so the scan does not
 * produce false positives on migrations that run in production.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (relative: string) => readFileSync(resolve(root, relative), "utf8");

/** Fully reserved words of PostgreSQL (cannot be unquoted identifiers). */
const RESERVED = new Set([
  "all", "analyse", "analyze", "and", "any", "array", "as", "asc", "asymmetric",
  "authorization", "binary", "both", "case", "cast", "check", "collate",
  "collation", "column", "concurrently", "constraint", "create", "cross",
  "current_catalog", "current_date", "current_role", "current_schema",
  "current_time", "current_timestamp", "current_user", "default", "deferrable",
  "desc", "distinct", "do", "else", "end", "except", "false", "fetch", "for",
  "foreign", "freeze", "from", "full", "grant", "group", "having", "ilike",
  "in", "initially", "intersect", "into", "is", "isnull", "join", "lateral",
  "leading", "left", "like", "limit", "localtime", "localtimestamp", "natural",
  "not", "notnull", "null", "offset", "on", "only", "or", "order", "outer",
  "overlaps", "placing", "primary", "references", "returning", "right",
  "select", "session_user", "similar", "some", "symmetric", "table",
  "tablesample", "then", "to", "trailing", "true", "union", "unique", "using",
  "variadic", "verbose", "when", "where", "window", "with",
]);

/** Words that legitimately START a table-level constraint item (their NAME
 *  is checked instead). */
const TABLE_CONSTRAINT_LEADS = new Set([
  "constraint", "primary", "foreign", "check", "unique", "exclude",
]);

/** The first bare (unquoted) identifier of a declaration item; null when the
 *  item is quoted (legal) or not an identifier. */
function firstIdent(item: string): string | null {
  const clean = item.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();
  const match = clean.match(/^("[^"]*"|[\p{L}_][\p{L}0-9_]*)/u);
  if (!match) return null;
  if (match[1].startsWith('"')) return null;
  return match[1].toLowerCase();
}

/** Depth-aware extraction of the parenthesised list whose opening '(' is at
 *  (or after) `from`. Skips '...' string literals. Returns the content
 *  BETWEEN the matched outer parentheses. */
function parenListFrom(sql: string, from: number): string | null {
  let open = from;
  while (open < sql.length && sql[open] !== "(") open += 1;
  if (open >= sql.length) return null;
  let depth = 1; // the '(' at `open` is already open
  let inString = false;
  for (let i = open + 1; i < sql.length; i += 1) {
    const ch = sql[i];
    if (inString) {
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") {
      inString = true;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return sql.slice(open + 1, i);
    }
  }
  return null;
}

/** Split a declaration list on top-level commas (string-literal aware). */
function topLevelItems(list: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let inString = false;
  let current = "";
  for (const ch of list) {
    if (inString) {
      current += ch;
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") {
      inString = true;
      current += ch;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      items.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) items.push(current);
  return items;
}

interface DeclaredIdentifier {
  name: string;
  context: string;
  file: string;
}

/** Every unquoted identifier in a declaration position of one migration. */
function declaredIdentifiers(sql: string, file: string): DeclaredIdentifier[] {
  const out: DeclaredIdentifier[] = [];
  // Contexts 1-3 live OUTSIDE function bodies: strip $$...$$ first so
  // DDL text inside plpgsql bodies cannot confuse the scanners.
  const outside = sql.replace(/\$\$[\s\S]*?\$\$/g, " $$BODY$$ ");

  for (const match of outside.matchAll(
    /create\s+table\s+(?:if\s+not\s+exists\s+)?[\w.]+/gi,
  )) {
    const list = parenListFrom(outside, match.index + match[0].length);
    if (!list) continue;
    for (const item of topLevelItems(list)) {
      const name = firstIdent(item);
      if (name === null) continue;
      if (TABLE_CONSTRAINT_LEADS.has(name)) {
        // Standalone "unique (…)" / "primary key (…)" / "check (…)" items
        // carry no name; only "constraint <name> …" declares one.
        if (name === "constraint") {
          const constraintName = firstIdent(item.replace(/^\s*constraint\s+/i, ""));
          if (constraintName !== null) {
            out.push({ name: constraintName, context: "table-constraint", file });
          }
        }
        continue;
      }
      out.push({ name, context: "table-column", file });
    }
  }

  for (const match of outside.matchAll(/returns\s+table\s*\(/gi)) {
    const list = parenListFrom(outside, match.index + match[0].length - 1);
    if (!list) continue;
    for (const item of topLevelItems(list)) {
      const name = firstIdent(item);
      if (name !== null) out.push({ name, context: "returns-table-field", file });
    }
  }

  for (const match of outside.matchAll(
    /create\s+(?:or\s+replace\s+)?function\s+[\w.]+\s*\(/gi,
  )) {
    const list = parenListFrom(outside, match.index + match[0].length - 1);
    if (!list || !list.trim()) continue;
    for (const item of topLevelItems(list)) {
      const name = firstIdent(item);
      if (name !== null) out.push({ name, context: "function-param", file });
    }
  }

  // Context 4: plpgsql DECLARE variables — only inside function bodies.
  for (const body of sql.matchAll(/\$\$([\s\S]*?)\$\$/g)) {
    for (const block of body[1].matchAll(/\bdeclare\b([\s\S]*?)\bbegin\b/gi)) {
      for (const item of block[1].split(";")) {
        const name = firstIdent(item);
        if (name !== null) out.push({ name, context: "plpgsql-declare", file });
      }
    }
  }

  return out;
}

describe("migration SQL — reserved identifiers (42601 regression)", () => {
  const migrationDir = resolve(root, "supabase/migrations");
  const files = readdirSync(migrationDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  it("all migrations exist and at least the deckblatt quota migration is present", () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(files).toContain("20261020000000_deckblatt_usage.sql");
  });

  it("NO migration uses a fully reserved PostgreSQL word as an unquoted identifier", () => {
    const problems: string[] = [];
    for (const file of files) {
      const sql = read(`supabase/migrations/${file}`);
      for (const { name, context } of declaredIdentifiers(sql, file)) {
        if (RESERVED.has(name)) {
          problems.push(`${file}: ${context} "${name}" is a fully reserved word`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("deckblatt: the per-day cap field is daily_limit (the reserved 'limit' is gone)", () => {
    const deckblatt = read("supabase/migrations/20261020000000_deckblatt_usage.sql");
    expect(deckblatt).toContain("daily_limit integer,");
    // The old broken declaration must not come back.
    expect(deckblatt).not.toMatch(/returns table \(\s*\n\s*limit\s+integer/i);
  });

  it("deckblatt: the TypeScript mapping reads the renamed field (row.daily_limit)", () => {
    const usageLib = read("src/lib/deckblatt/usage.ts");
    expect(usageLib).toContain("row.daily_limit");
    expect(usageLib).not.toContain("row.limit");
  });

  it("negative control: the scanner DETECTS the original broken declaration", () => {
    // The exact construct that failed in production (42601 at "limit").
    const broken = [
      "create or replace function public.broken_status(target_user_id uuid)",
      "returns table (",
      "  limit integer,",
      "  used integer",
      ")",
      "language sql as $$",
      "  select 2, 1",
      "$$;",
    ].join("\n");
    const ids = declaredIdentifiers(broken, "broken.sql");
    expect(
      ids.some((entry) => entry.name === "limit" && entry.context === "returns-table-field"),
      "scanner must flag 'limit' as a returns-table field",
    ).toBe(true);
  });

  it("the scanner actually sees the deckblatt declarations (sanity, no silent no-op)", () => {
    const deckblatt = read("supabase/migrations/20261020000000_deckblatt_usage.sql");
    const ids = declaredIdentifiers(deckblatt, "deckblatt");
    const names = new Set(ids.map((entry) => entry.name));
    // table columns
    for (const expected of ["user_id", "usage_date", "generations_used", "run_id"]) {
      expect(names.has(expected), `column ${expected} detected`).toBe(true);
    }
    // returns table fields
    expect(
      ids.some((entry) => entry.name === "daily_limit" && entry.context === "returns-table-field"),
    ).toBe(true);
    // function parameters
    for (const expected of ["target_user_id", "p_run_id"]) {
      expect(
        ids.some((entry) => entry.name === expected && entry.context === "function-param"),
      ).toBe(true);
    }
    // plpgsql declare variables
    expect(
      ids.some((entry) => entry.name === "before_row" && entry.context === "plpgsql-declare"),
    ).toBe(true);
  });
});

describe("migration SQL — CREATE TYPE IF NOT EXISTS (42601 regression)", () => {
  // Second production incident of the same shape: 20261112000000_bewerbung_
  // automation.sql started with
  //
  //   CREATE TYPE IF NOT EXISTS public.bew_campaign_status AS ENUM (...)
  //
  // — a syntax error (42601 at "not"), because PostgreSQL has IF NOT EXISTS
  // for TABLE/INDEX but NOT for TYPE. The Supabase SQL editor aborted the
  // whole file, so no bew_* object was created. The fix keeps the EXACT enum
  // values but guards creation with a pg_type probe inside DO blocks.

  const migrationDir = resolve(root, "supabase/migrations");
  const files = readdirSync(migrationDir).filter((n) => n.endsWith(".sql")).sort();
  const readMigration = (file: string) => read(`supabase/migrations/${file}`);
  const BEW = "20261112000000_bewerbung_automation.sql";

  /** Strip plpgsql $$…$$ bodies, `--` line comments and single-quoted
   *  string literals so the scan sees only real DDL (guard code lives
   *  inside a DO $$ body). Comments come BEFORE string stripping: an
   *  apostrophe in a comment (e.g. "campaign's") would otherwise flip the
   *  quote parity and swallow real DDL. None of the outside-of-$$ string
   *  literals in this repo contain `--`, so this order is lossless here. */
  function ddlOnly(sql: string): string {
    return sql
      .replace(/\$\$[\s\S]*?\$\$/g, " ")
      .replace(/--[^\n]*/g, " ")
      .replace(/'(?:[^']|'')*'/g, " ");
  }

  it("the bew migration is present", () => {
    expect(files).toContain(BEW);
  });

  it("NO migration uses the unsupported `create type if not exists` syntax", () => {
    const offenders = files.filter((file) =>
      /create\s+type\s+if\s+not\s+exists/i.test(ddlOnly(readMigration(file))),
    );
    expect(offenders).toEqual([]);
  });

  it("bew: both enums are pg_type-guarded (idempotent) with the exact value contract", () => {
    const sql = readMigration(BEW);
    // Guard: probe pg_type in the public schema before creating.
    expect(sql).toMatch(
      /do\s*\$\$[\s\S]*?pg_type[\s\S]*?typname = 'bew_campaign_status'[\s\S]*?\$\$;/i,
    );
    expect(sql).toMatch(
      /do\s*\$\$[\s\S]*?pg_type[\s\S]*?typname = 'bew_app_status'[\s\S]*?\$\$;/i,
    );
    // Exact value lists — the send engine and the UI depend on these
    // strings verbatim; a reworded list would silently break round-trips.
    expect(sql).toMatch(
      /'draft',\s*'generating',\s*'sending',\s*'completed',\s*'partially_failed',\s*'cancelled'/,
    );
    expect(sql).toMatch(
      /'pending',\s*'generating',\s*'generated',\s*'excluded',\s*'queued',\s*'sending',\s*'sent',\s*'failed',\s*'needs_attention',\s*'cancelled'/,
    );
  });

  it("bew: every create policy / create trigger is drop-guarded (rerun-safe)", () => {
    const raw = readMigration(BEW);
    const sql = ddlOnly(raw).replace(/\s+/g, " ");

    // CREATE POLICY has no IF NOT EXISTS: each of the four owner-SELECT
    // policies must be preceded by its own `drop policy if exists`.
    const policies = [...raw.matchAll(/create policy\s+"([^"]+)"\s+on\s+(\S+)/gi)];
    expect(policies.length).toBe(4);
    for (const [, name, table] of policies) {
      const createIdx = sql.indexOf(`create policy "${name}" on ${table}`);
      const dropIdx = sql.indexOf(`drop policy if exists "${name}" on ${table}`);
      expect(dropIdx, `drop guard missing for policy "${name}"`).toBeGreaterThan(-1);
      expect(dropIdx, `drop guard must precede create for "${name}"`).toBeLessThan(createIdx);
    }

    // CREATE TRIGGER likewise: both updated_at triggers are drop-guarded.
    const triggers = [
      ...raw.matchAll(/create trigger\s+(\w+)\s+(?:before|after|instead of)[\s\S]{0,200}?on\s+(\S+)/gi),
    ];
    expect(triggers.length).toBe(2);
    for (const [, name, table] of triggers) {
      const createIdx = sql.indexOf(`create trigger ${name}`);
      const dropIdx = sql.indexOf(`drop trigger if exists ${name} on ${table}`);
      expect(dropIdx, `drop guard missing for trigger ${name}`).toBeGreaterThan(-1);
      expect(dropIdx, `drop guard must precede create for ${name}`).toBeLessThan(createIdx);
    }

    // The privileged RPCs stay create-or-replace (idempotent) and are only
    // granted to service_role after a full revoke from client roles.
    expect(
      sql.match(
        /create or replace function public\.(claim_next_bew_application|bew_record_email_sent|bew_cancel_queued)\b/gi,
      ),
    ).toHaveLength(3);
    for (const fn of [
      "claim_next_bew_application(uuid, uuid)",
      "bew_record_email_sent(uuid, date)",
      "bew_cancel_queued(uuid, uuid)",
    ]) {
      expect(sql).toContain(`revoke all on function public.${fn} from public, anon, authenticated`);
      expect(sql).toContain(`grant execute on function public.${fn} to service_role`);
    }
  });
});
