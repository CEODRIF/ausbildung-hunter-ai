/**
 * Community SQL migrations audit — PostgreSQL-validity regression guards.
 *
 * Full audit: docs/community-sql-migrations-audit-report.md. These guards
 * pin the three PostgreSQL-invalid constructs found by the audit and that
 * broke the production Community rollout (v3 failed with 42601, "syntax
 * error at or near (", when applied manually):
 *
 *   1. v3 — an EXPRESSION (least/greatest) used inside a UNIQUE TABLE
 *      CONSTRAINT. PostgreSQL cannot express that; pair uniqueness must be
 *      a UNIQUE EXPRESSION INDEX (identical semantics).
 *   2. v6 — SUBQUERIES (not exists / exists) inside CHECK CONSTRAINTS.
 *      PostgreSQL rejects subqueries in CHECK expressions; the rule must
 *      live in an IMMUTABLE helper function called from the constraint.
 *   3. generic — a scan over ALL nine community migrations (v1–v9) that
 *      detects both construct classes, so a regression can never ship
 *      again without breaking the suite.
 *
 * Source-level by design: they keep the SQL structurally valid without a
 * live database (the fresh-database application is exercised in the local
 * simulation documented in the report).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MIGRATIONS = "supabase/migrations";

const FILES = {
  v1: `${MIGRATIONS}/20261014000000_community.sql`,
  v2: `${MIGRATIONS}/20261027000000_community_v2.sql`,
  v3: `${MIGRATIONS}/20261028000000_community_v3_social.sql`,
  v4: `${MIGRATIONS}/20261029000000_community_v4_presence_notifications.sql`,
  v5: `${MIGRATIONS}/20261030000000_community_v5_voice.sql`,
  v6: `${MIGRATIONS}/20261031000000_community_v6_advanced.sql`,
  v7: `${MIGRATIONS}/20261101000000_community_v7_image_quota.sql`,
  v8: `${MIGRATIONS}/20261102000000_community_v8_image_read_policies.sql`,
  v9: `${MIGRATIONS}/20261103000000_community_v9_voice_stale_sweep.sql`,
} as const;

type FileKey = keyof typeof FILES;

let sql: Record<FileKey, string>;

beforeAll(() => {
  const loaded = {} as Record<FileKey, string>;
  (Object.keys(FILES) as FileKey[]).forEach((k) => {
    loaded[k] = readFileSync(resolve(root, FILES[k]), "utf8");
  });
  sql = loaded;
});

// ---------------------------------------------------------------------------
// Scanning helpers (comments + dollar quotes respected)
// ---------------------------------------------------------------------------

/** Strip SQL comments (line and block comment forms). */
function stripComments(text: string): string {
  return text.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** Split a script into top-level statements (`;` at quote depth 0). */
function topLevelStatements(text: string): string[] {
  const stmts: string[] = [];
  let buf = "";
  let inDollar = false;
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const two = text.slice(i, i + 2);
    if (inDollar) {
      buf += ch;
      if (two === "$$") {
        buf += "$";
        inDollar = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      buf += ch;
      if (ch === "'") inStr = false;
      continue;
    }
    if (two === "$$") {
      inDollar = true;
      buf += "$$";
      i++;
      continue;
    }
    if (ch === "'") {
      inStr = true;
      buf += ch;
      continue;
    }
    if (ch === ";") {
      stmts.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) stmts.push(buf);
  return stmts;
}

/** Extract the balanced expression of every `check ( ... )` in a statement. */
function checkExpressions(statement: string): string[] {
  const out: string[] = [];
  const re = /\bcheck\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(statement)) !== null) {
    let depth = 1;
    let inStr = false;
    let i = m.index + m[0].length;
    while (i < statement.length && depth > 0) {
      const ch = statement[i];
      if (inStr) {
        if (ch === "'") inStr = false;
      } else if (ch === "'") {
        inStr = true;
      } else if (ch === "(") {
        depth++;
      } else if (ch === ")") {
        depth--;
      }
      i++;
    }
    out.push(statement.slice(m.index + m[0].length, i - 1));
    re.lastIndex = i;
  }
  return out;
}

/**
 * CHECK expressions in CONSTRAINT positions only: inside CREATE TABLE /
 * ALTER TABLE statements (column inline or named constraints). Policy
 * expressions (`create policy ... with check`) may contain subqueries —
 * they are NOT constraints and are excluded on purpose.
 */
function constraintCheckExpressions(file: string): string[] {
  const out: string[] = [];
  for (const stmt of topLevelStatements(stripComments(file))) {
    const head = stmt.trim().toLowerCase();
    if (!head.startsWith("create table") && !head.startsWith("alter table")) {
      continue;
    }
    out.push(...checkExpressions(stmt));
  }
  return out;
}

/** An expression UNIQUE TABLE CONSTRAINT (invalid in PostgreSQL). */
const EXPRESSION_UNIQUE_TABLE_CONSTRAINT =
  /\bconstraint\s+\w+\s+unique\s*\(\s*(least|greatest|lower|upper|md5|coalesce|trim|substring|length|char_length)\s*\(/i;

// ---------------------------------------------------------------------------
// 1. v3 — the production 42601 regression (expression UNIQUE constraint)
// ---------------------------------------------------------------------------

describe("v3 social — expression UNIQUE table constraint regression (production 42601)", () => {
  it("keeps the no-self-conversation CHECK on the table", () => {
    expect(sql.v3).toContain(
      "constraint community_conversations_self check (member_a <> member_b)",
    );
  });

  it("enforces pair uniqueness via a UNIQUE EXPRESSION INDEX", () => {
    expect(sql.v3).toContain("create unique index community_conversations_unique_pair");
    expect(sql.v3).toContain(
      "on public.community_conversations (least(member_a, member_b),",
    );
    expect(sql.v3).toContain("greatest(member_a, member_b));");
  });

  it("contains NO expression UNIQUE table constraint", () => {
    expect(EXPRESSION_UNIQUE_TABLE_CONSTRAINT.test(stripComments(sql.v3))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. v6 — subqueries inside CHECK constraints (invalid in PostgreSQL)
// ---------------------------------------------------------------------------

describe("v6 advanced — subquery-in-CHECK regression", () => {
  it("the question tags rule lives in an IMMUTABLE helper defined BEFORE the table", () => {
    const fnAt = sql.v6.indexOf("create or replace function public.community_question_tags_valid");
    const tableAt = sql.v6.indexOf("create table if not exists public.community_questions");
    expect(fnAt).toBeGreaterThanOrEqual(0);
    expect(tableAt).toBeGreaterThan(fnAt);
    const fnBlock = sql.v6.slice(fnAt, sql.v6.indexOf("$$;", fnAt) + 3);
    expect(fnBlock).toMatch(/^\s*create or replace function[\s\S]*?\bimmutable\b/m);
  });

  it("the questions CHECK calls the helper and carries no subquery", () => {
    const tableStmt = topLevelStatements(stripComments(sql.v6)).find((s) =>
      s.trim().toLowerCase().startsWith("create table if not exists public.community_questions"),
    );
    expect(tableStmt).toBeDefined();
    const exprs = checkExpressions(tableStmt as string);
    const tagsCheck = exprs.find((e) => e.includes("community_question_tags_valid(tags)"));
    expect(tagsCheck).toBeDefined();
    expect(tagsCheck).not.toMatch(/\bselect\b/i);
    expect(tagsCheck).not.toMatch(/\bnot\s+exists\s*\(/i);
  });

  it("the pins room-match rule lives in an IMMUTABLE helper defined BEFORE the table", () => {
    const fnAt = sql.v6.indexOf("create or replace function public.community_pins_room_matches");
    const tableAt = sql.v6.indexOf("create table if not exists public.community_pins");
    expect(fnAt).toBeGreaterThanOrEqual(0);
    expect(tableAt).toBeGreaterThan(fnAt);
    const fnBlock = sql.v6.slice(fnAt, sql.v6.indexOf("$$;", fnAt) + 3);
    expect(fnBlock).toMatch(/^\s*create or replace function[\s\S]*?\bimmutable\b/m);
  });

  it("the pins CHECK calls the helper and carries no subquery", () => {
    const tableStmt = topLevelStatements(stripComments(sql.v6)).find((s) =>
      s.trim().toLowerCase().startsWith("create table if not exists public.community_pins"),
    );
    expect(tableStmt).toBeDefined();
    const exprs = checkExpressions(tableStmt as string);
    const roomCheck = exprs.find((e) =>
      e.includes("public.community_pins_room_matches(message_id, room_id)"),
    );
    expect(roomCheck).toBeDefined();
    expect(roomCheck).not.toMatch(/\bselect\b/i);
    expect(roomCheck).not.toMatch(/\bexists\s*\(\s*select/i);
  });

  it("the pins helper parameters cannot be shadowed by community_messages columns", () => {
    // Inside the helper's subquery, an unqualified `room_id` resolves to
    // community_messages.room_id (the COLUMN), not the function parameter —
    // which silently makes the check a no-op. Parameters therefore must not
    // reuse column names of the table they query.
    const fnAt = sql.v6.indexOf("create or replace function public.community_pins_room_matches");
    const fnBlock = sql.v6.slice(fnAt, sql.v6.indexOf("$$;", fnAt) + 3);
    expect(fnBlock).toContain("(p_message_id uuid, p_room_id uuid)");
    expect(fnBlock).toContain("m.id = p_message_id and m.room_id = p_room_id");
  });

  it("community_search references websearch_to_tsquery from pg_catalog (not public)", () => {
    // websearch_to_tsquery is a pg_catalog builtin — it does not exist in
    // the public schema, so `public.websearch_to_tsquery` fails at CALL
    // time (plpgsql bodies resolve references only when executed).
    expect(sql.v6).not.toContain("public.websearch_to_tsquery");
    expect(sql.v6.match(/pg_catalog\.websearch_to_tsquery\('simple', v_query\)/g)).toHaveLength(5);
  });

  it("community_search names the UNION's question_id column in its first branch", () => {
    // UNION ALL output columns are named by the FIRST branch: an unaliased
    // `null` there becomes ?column?, and the outer s.question_id reference
    // fails at call time with 42703.
    expect(sql.v6).toContain("null::uuid as question_id");
  });
});

// ---------------------------------------------------------------------------
// 3. All nine migrations — the generic PostgreSQL-validity scan
// ---------------------------------------------------------------------------

describe("all community migrations (v1–v9) — PostgreSQL validity scan", () => {
  const keys = Object.keys(FILES) as FileKey[];

  it("extracts CHECK expressions (positive control — the scan is not vacuous)", () => {
    // v5 alone has four inline column checks (provider, provider_room_name
    // regex, status, participant_count); the full set has many more.
    expect(constraintCheckExpressions(sql.v5)).toHaveLength(4);
    const total = keys.reduce(
      (n, k) => n + constraintCheckExpressions(sql[k]).length,
      0,
    );
    expect(total).toBeGreaterThanOrEqual(25);
  });

  it("no CHECK constraint in any migration contains a subquery", () => {
    for (const k of keys) {
      const offenders = constraintCheckExpressions(sql[k]).filter((e) =>
        /\bselect\b/i.test(e),
      );
      expect(offenders, `${k}: CHECK constraint contains a subquery`).toEqual([]);
    }
  });

  it("no expression UNIQUE TABLE CONSTRAINT in any migration", () => {
    for (const k of keys) {
      const stripped = stripComments(sql[k]);
      const match = stripped.match(EXPRESSION_UNIQUE_TABLE_CONSTRAINT);
      expect(match, `${k}: expression UNIQUE table constraint`).toBeNull();
    }
  });

  it("expression UNIQUE INDEXES (the valid form) are untouched where used", () => {
    // v2: lower(display_name) profile uniqueness; v3: least/greatest pair
    // indexes — all expression indexes, none of them table constraints.
    expect(sql.v2).toContain("create unique index community_profiles_username_uq");
    expect(sql.v2).toContain("on public.community_profiles (lower(display_name));");
    expect(sql.v3).toContain("create unique index community_friendships_pair_uq");
  });

  it("no migration reads storage.objects.size — Supabase stores size in metadata", () => {
    // Supabase's storage.objects has NO `size` column (generic PostgreSQL
    // shims often do, which is how this slipped through): the byte count
    // lives in the `metadata` jsonb. v7 shipped with sum(o.size) and failed
    // in Production at CALL time (42703) — corrected to the metadata form
    // below, which a fresh deployment must keep.
    for (const k of keys) {
      const stripped = stripComments(sql[k]);
      expect(stripped, `${k}: references storage.objects.size`).not.toMatch(/\bo\.size\b/);
      expect(stripped, `${k}: references storage.objects.size`).not.toMatch(/storage\.objects\.size/);
    }
    expect(sql.v7).toContain("coalesce(sum(coalesce((o.metadata->>'size')::bigint, 0)), 0)::bigint");
  });
});
