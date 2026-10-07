# Community SQL Migrations — Full Audit Report (v1 → v9)

**Date:** 2026-10-07 · **Scope:** all 9 Community Supabase migrations in `supabase/migrations/`
**Trigger:** production Community page "Etwas ist schiefgelaufen" — production Supabase has NO community migrations registered yet; manual v3 apply failed with `ERROR: 42601 syntax error at or near "("`.

**Headline:** static audit + fresh-database simulation found **6 distinct bugs** (1 in v3, 5 in v6). All were fixed **in place** (these migrations were never applied to production, so correcting the existing files is safe). After the fixes: **12/12 DDL files apply with ZERO SQL errors** to a fresh PostgreSQL 16 database, and **33/33 functional smoke checks pass**.

---

## 1. Executive summary

| # | File (version) | Pre-fix state | Post-fix state |
|---|----------------|---------------|----------------|
| 1 | `20261014000000_community.sql` (v1) | valid | **PASS** (unchanged) |
| 2 | `20261027000000_community_v2.sql` (v2) | valid | **PASS** (unchanged) |
| 3 | `20261028000000_community_v3_social.sql` (v3) | **FAIL — bug 1 (42601)** | **PASS** (fixed in place) |
| 4 | `20261029000000_community_v4_presence_notifications.sql` (v4) | valid | **PASS** (unchanged) |
| 5 | `20261030000000_community_v5_voice.sql` (v5) | valid | **PASS** (unchanged) |
| 6 | `20261031000000_community_v6_advanced.sql` (v6) | **FAIL — bugs 2–6** | **PASS** (fixed in place) |
| 7 | `20261101000000_community_v7_image_quota.sql` (v7) | valid | **PASS** (unchanged) |
| 8 | `20261102000000_community_v8_image_read_policies.sql` (v8) | valid | **PASS** (unchanged) |
| 9 | `20261103000000_community_v9_voice_stale_sweep.sql` (v9) | valid | **PASS** (unchanged) |

## 2. Scope and methodology

1. Every migration file was read **in full** (v1–v9, ~2 400 lines total).
2. Static PostgreSQL-syntax audit: expression UNIQUE constraints, CHECK constraints, indexes, ALTER statements, RLS policies, functions/RPCs, triggers, foreign keys, enums.
3. Migration-order audit: fresh-database dependency simulation (v1 → v9 in exact file order).
4. **Live fresh-database simulation** (local PostgreSQL 16.15, temp cluster, port 55432, database `commaudit`): Supabase compatibility shim + the repo's real platform prerequisites (notifications stack, `set_updated_at()`), then all 9 files with `psql -v ON_ERROR_STOP=1`. Objective: **ZERO SQL errors** — achieved.
5. **Functional smoke test** (33 assertions on the simulated DB): constraint enforcement, RPC behavior, idempotency, FTS search, voice join/sync, sweep, quota.
6. App-code verification: every community table/RPC referenced in `src/` must exist in the migrations.
7. Regression tests added to the suite; full gates re-run.

**Hard constraints honored:** no git commands; production database untouched; no architecture changes; RLS not weakened (all fixes preserve or strengthen constraints); no fix-migration files (existing unpublished files corrected in place, filenames unchanged).

## 3. PostgreSQL rules that were violated (class of findings)

| Rule | Where violated | Effect |
|------|----------------|--------|
| PostgreSQL does **not** support expressions inside a UNIQUE **table constraint** (only UNIQUE *indexes* may use expressions) | v3 `community_conversations` | DDL aborts at CREATE TABLE: **42601** (the production failure) |
| CHECK constraint expressions **cannot contain subqueries** (`EXISTS`/`SELECT`) | v6 `community_questions`, `community_pins` | DDL aborts at CREATE TABLE (would have been the next production failure after v3) |
| In a SQL-function subquery, an **unqualified name that matches a table column resolves to the column**, shadowing the function parameter | v6 `community_pins_room_matches` (param `room_id` vs `community_messages.room_id`) | Constraint silently **becomes a no-op** — a pin could reference a message from a different room (security/consistency bypass). Proven live: helper returned `t` for a zero-UUID room. |
| `websearch_to_tsquery` is a **pg_catalog** builtin — `public.websearch_to_tsquery` does not exist on Supabase | v6 `community_search` (5 call sites) | Every `community_search()` call fails at **runtime** with 42883 (plpgsql bodies resolve references only when executed — DDL passes) |
| `UNION ALL` output columns are named by the **first branch**; an unaliased `null` there is named `?column?` | v6 `community_search` first branch | Every `community_search()` call fails at **runtime** with 42703 (`column s.question_id does not exist`) |

## 4. Migration order audit (fresh-DB dependency simulation)

Dependency chain (each version only extends the previous):

```
platform: auth.users / auth.uid() · storage.* · supabase_realtime publication
          notification(_type/_target_type) + notifications + notification_reads
          public.set_updated_at()
v1 → v2 → v3 → v4 → v5 → v6 → v7 → v8 → v9
```

- v2 adds `room_id` to v1's `community_messages` and references v1's `community_profiles`.
- v3 DM/notifications reference v1 rooms, v2 rooms; v3 adds `notification_type 'social'` consumed by v4.
- v4 `notifications` FKs reference v3 objects (conversations, DMs).
- v5 references v2 rooms. v6 references v1–v5 objects (rooms, messages, profiles, notifications).
- v7/v8 reference `storage.objects` + v1/v3/v6 tables (via path ownership). v9 references v5's `community_voice_conversations`.
- No forward references; no missing prerequisites; no circular DDL. The circular **FK** in v6 (`community_questions.accepted_answer_id` ↔ `community_answers.question_id`) is declared as a separate `ALTER TABLE … ADD CONSTRAINT` after both tables exist — valid.
- Order is correct as-is. Applying v1 → v9 in file order on a fresh DB: **zero errors** (section 15).

## 5. v1 — `20261014000000_community.sql` (178 lines) — **PASS**

**Objects:** `community_profiles` (PK→auth.users, `community_profiles_avatar_valid` check avatar-1..5), `community_messages` (author FK, content 1..5000, image path), `community_read_state` (owner FK, `user_id` unique via PK), 3 `set_updated_at` triggers, RLS (owner-only profile writes, member read), 3 indexes, `community-images` storage bucket (private, 2 MiB, jpeg/png/webp, `on conflict do nothing`), 2 storage policies (upload own-prefix / delete own).
**Verdict:** valid PostgreSQL; applied first cleanly. Realtime block is idempotency-guarded (`DO … if exists publication`).
**Retry hazard (documented, not changed):** plain `CREATE TABLE` / `CREATE INDEX` / `CREATE TRIGGER` (no `IF NOT EXISTS`, no `DROP TRIGGER IF EXISTS`) — re-running the file after full success fails on the first existing object. This is standard Supabase migration practice (migrations apply exactly once, tracked in `supabase_migrations.schema_migrations`); deliberately **not** rewritten with `IF NOT EXISTS` everywhere.

## 6. v2 — `20261027000000_community_v2.sql` (317 lines) — **PASS**

**Objects:** `community_room_categories` + 7 seeded categories, `community_rooms` (21 deterministic-UUID rooms, `slug` unique, category FK, position), `community_messages` +`room_id` (default room 1) +`reply_to_message_id`, `community_message_reactions` (fixed emoji-set check), `community_message_mentions`, `community_room_read_state`, RPC `community_room_unread_summary(p_user)` (SECURITY INVOKER, RLS-scoped counts), profile username remap + `community_profiles_username_uq` unique index on `lower(display_name)` (valid **expression index**), dedupe `DO` block (idempotent), storage delete policy.
**Verdict:** valid. Expression usage is only in `CREATE UNIQUE INDEX` — the legal form. All references resolve against v1/v2 state.
**Retry hazards (documented):** plain `CREATE TABLE` (reactions/mentions/room_read_state), plain `CREATE UNIQUE INDEX community_profiles_username_uq`, plain `CREATE POLICY` without drop-guards.

## 7. v3 — `20261028000000_community_v3_social.sql` (561 lines) — **PASS (after fix)**

**Objects:** `community_friendships` (valid expression unique index `community_friendships_pair_uq` on `least/greatest`), `community_blocks` (`community_blocks_self` + `community_blocks_unique`), `community_conversations`, DM tables (`community_direct_messages`, `community_dm_reactions`, `community_dm_read_state`), `community_dm_summary(p_user)` (SECURITY INVOKER), `community_notifications_unread(p_user)`, `set_status_changed_at()` + trigger, `notification_type + 'social'` (`ADD VALUE IF NOT EXISTS`), 5 realtime table additions (DO-guarded), 4 DM storage policies (path-shape `dm/{conv}/{uid}/{msg}/...` via `storage.foldername`).

**BUG 1 (the production 42601) — fixed:**
```sql
-- BEFORE (invalid: expression in a UNIQUE TABLE CONSTRAINT)
constraint community_conversations_unique_pair
  unique (least(member_a, member_b), greatest(member_a, member_b))
```
PostgreSQL cannot express this — the parser aborts at `(`. Fixed per the exact suggested pattern:
```sql
-- AFTER (table keeps only the plain-column self-check …)
constraint community_conversations_self check (member_a <> member_b)
-- … pair uniqueness moves to a UNIQUE EXPRESSION INDEX (identical semantics)
create unique index community_conversations_unique_pair
  on public.community_conversations (least(member_a, member_b),
                                     greatest(member_a, member_b));
```
**Verified live:** `insert (U2,U1)` after `(U1,U2)` → `23505 duplicate key … community_conversations_unique_pair`; self-pair → `23514 … community_conversations_self`.

**Retry hazards (documented):** plain `CREATE TABLE` ×6, plain `CREATE INDEX`, plain `CREATE TRIGGER community_friendships_status_changed_at`. Idempotent parts: enum value, storage policies (drop-guards), publication DO-blocks.

## 8. v4 — `20261029000000_community_v4_presence_notifications.sql` (255 lines) — **PASS**

**Objects:** 6 new `notification_type` values (all `ADD VALUE IF NOT EXISTS`), `notifications` + `actor_id/room_id/room_message_id/conversation_id/dm_message_id/reaction_emoji` (all `ADD COLUMN IF NOT EXISTS`), `notifications_social_refs` CHECK (pure boolean logic — **no subquery**, valid), partial feed index `IF NOT EXISTS`, `community_profiles` + 9 presence/preference columns (`IF NOT EXISTS`), RPC `community_notify(8 args)` (SECURITY DEFINER, pinned search_path, actor = `auth.uid()`, block-silencing both directions, deterministic md5 `send_key`, `ON CONFLICT (send_key) DO NOTHING`), RPC `community_notifications_page(4 args)` (SECURITY INVOKER, keyset cursor).
**Verdict:** valid. Fully additive.
**Retry hazard (documented, proven by re-apply test):** `ADD CONSTRAINT notifications_social_refs` has no `DROP CONSTRAINT IF EXISTS` guard → second run fails `42710 constraint already exists`. Safe under Supabase's apply-once migration tracking.
**Live-verified:** notify returns a row id on first call, `null` on retry (idempotent per documented contract), exactly 1 row created.

## 9. v5 — `20261030000000_community_v5_voice.sql` (133 lines) — **PASS**

**Objects:** `community_voice_conversations` (provider='livekit' check, `provider_room_name` regex `^croom-<uuid>$`, status check, count 0..50), partial unique index `(room_id) where status = 'active'`, member SELECT policy only (no user write policies — by design), RPC `community_voice_join(p_room)` (`ON CONFLICT (room_id) WHERE status = 'active' DO UPDATE` — partial-index inference is legal in PG), RPC `community_voice_sync_count(p_room, p_count)` (convergent clamps only: decrease or +1; 0 ends).
**Verdict:** valid. The `ON CONFLICT … WHERE` target inference against a partial index is correct and was accepted by the engine.
**Retry hazards (documented):** plain `CREATE TABLE`, plain `CREATE INDEX` ×2, plain `CREATE POLICY`.
**Live-verified:** join creates active row; second join reuses it (partial unique holds); sync 1→2 accepted; sync →0 ends the conversation.

## 10. v6 — `20261031000000_community_v6_advanced.sql` (921 lines) — **PASS (after 5 fixes)**

**Objects:** `community_memberships` + `handle_community_membership()` trigger (role source), `community_user_role/is_moderator/is_admin`, profile moderation flags, room reorg (2 new categories, slug-stable updates), `community_messages` +`hidden_by/hidden_at/search_vector` (generated FTS, GIN), Q&A (`community_questions`, `community_answers` + accepted partial unique, circular FK deferred via ALTER), `community_pins`, `community_reports`, `community_moderation_actions` (append-only), `community_reputation_events`, `notifications` +2 enum values +`question_id/answer_id` + re-created `notifications_social_refs` (drop-guarded), RPC `community_search(9 args)` (SECURITY DEFINER, 5-way UNION, `auth.uid() = p_user` guard), RPC `community_home_activity()`, 2 realtime additions.

**BUG 2 — fixed:** `community_questions_tags_bounded` CHECK contained `NOT EXISTS (SELECT 1 FROM UNNEST …)` — subqueries are illegal in CHECK expressions. → New IMMUTABLE helper `public.community_question_tags_valid(p_tags text[])` (identical logic: 0–5 tags, each 1–24 chars) created **before** the table; CHECK now `check (public.community_question_tags_valid(tags))`.
**BUG 3 — fixed:** `community_pins_room_matches_message` CHECK contained `EXISTS (SELECT …)` — same rule. → New IMMUTABLE helper `public.community_pins_room_matches(p_message_id uuid, p_room_id uuid)` created before the table; CHECK now calls it.
**BUG 4 — fixed (found by functional test):** in the BUG-3 helper, the parameter named `room_id` is **shadowed** by `community_messages.room_id` inside the subquery — the predicate became `m.room_id = m.room_id`, making the check a silent no-op (proven: helper returned `t` for a zero-UUID room). Fixed by renaming parameters to `p_message_id`/`p_room_id` (the `p_` prefix convention also applied to BUG 2's helper for consistency). **Live-verified after fix:** wrong-room pin → `23514 … community_pins_room_matches_message`; matching-room pin accepted; helper returns `f`/`t` correctly.
**BUG 5 — fixed (found by functional test):** `community_search` called `public.websearch_to_tsquery(…)` — that builtin lives in **pg_catalog**, not `public` (true on Supabase too); every call would fail 42883. All 5 call sites → `pg_catalog.websearch_to_tsquery('simple', v_query)` (explicit, search_path-proof; the function pins `search_path = public`).
**BUG 6 — fixed (found by functional test):** in `community_search`'s 5-way `UNION ALL`, the first branch's 10th column was an unaliased `null` → derived-table column named `?column?` → outer `s.question_id` fails 42703 on **every** call. First branch now emits `null::uuid as question_id`.
**Retry hazards (documented):** plain `CREATE INDEX` (question/answer indexes), plain `CREATE POLICY` without drop-guards; tables use `IF NOT EXISTS`, trigger drop-guarded, notifications constraint re-creation drop-guarded, enum values guarded.
**Live-verified after fixes:** 25-char tag rejected, 6 tags rejected, valid question inserted, search as U3 finds "hello community".

## 11. v7 — `20261101000000_community_v7_image_quota.sql` (55 lines) — **PASS**

**Objects:** exactly one — `community_image_storage_usage(p_user uuid) → bigint` (SECURITY DEFINER, pinned path, `strpos`/`LIKE` over the three community path shapes, injection-safe because owners are UUIDs), EXECUTE revoked from `public`/`anon`, granted to `service_role` only.
**Verdict:** valid; **fully re-runnable** (proven: re-apply succeeds).

## 12. v8 — `20261102000000_community_v8_image_read_policies.sql` (105 lines) — **PASS**

**Objects:** drops the broad v1 read policy (drop-guarded); adds 2 row-pinned SELECT policies on `storage.objects` — message images (`m.image_path = name` + id/author text segments match + `hidden_by is null` + room enabled) and question images (+ block check both directions), all via `storage.foldername(name)` segment comparison.
**Verdict:** valid; policies compile and bind on the real path shapes.
**Retry hazard (documented, proven by re-apply test):** re-running fails at the first unguarded `CREATE POLICY` re-creation point — safe under apply-once tracking.

## 13. v9 — `20261103000000_community_v9_voice_stale_sweep.sql` (76 lines) — **PASS**

**Objects:** exactly one — `community_voice_sweep_stale(p_stale_minutes default 15, p_max default 25) → integer` (SECURITY DEFINER, data-modifying CTE, `make_interval`, LIMIT clamped 1..100, fail-closed criteria, `active`→`ended` idempotent transition), service_role only.
**Verdict:** valid; **fully re-runnable** (proven). Live: sweep on a fresh DB returns 0 (no stale rows).

## 14. Idempotency & partial-failure analysis (documented, not blindly rewritten)

Supabase applies each migration exactly once and records it in `supabase_migrations.schema_migrations` — the production path is apply-once, so plain `CREATE` statements are the accepted convention and were **not** rewritten wholesale (per instruction: document, don't blindly add `IF NOT EXISTS`).

| File | Fully re-runnable (proven by live re-apply) | Re-run hazard after full success | Partial-failure note |
|------|--------------------------------------------|----------------------------------|----------------------|
| v1 | no | `CREATE TABLE community_profiles` (first stmt) | a failed run leaves nothing (table is stmt 1) except the role-independent catalog; re-run safe until first table exists |
| v2 | no | first plain `CREATE TABLE` | updates/seed are `ON CONFLICT DO NOTHING` or idempotent `UPDATE … WHERE slug=` |
| v3 | no | first plain `CREATE TABLE` | enum value + storage policies + publications are individually re-runnable |
| v4 | no | `ADD CONSTRAINT notifications_social_refs` (line 68 — proven) | every column/enum/index is guarded; only the constraint add and function revokes (idempotent) remain |
| v5 | no | first plain `CREATE TABLE` | functions are `CREATE OR REPLACE` |
| v6 | no | first plain `CREATE INDEX community_questions_room_idx` | tables `IF NOT EXISTS`; constraint re-creation drop-guarded; triggers drop-guarded |
| v7 | **yes** (proven) | — | pure function file |
| v8 | no | first unguarded `CREATE POLICY` re-creation (line 33 — proven) | all drops guarded |
| v9 | **yes** (proven) | — | pure function file |

**Guidance for a failed manual apply:** always re-apply from `v1` on a **fresh database** (preferred), or inspect `supabase_migrations.schema_migrations` + object state and resume statement-by-statement from the first missing object — never "re-run the whole file" on a partially migrated DB for v1–v6/v8.

## 15. Fresh-database local simulation (ZERO SQL errors)

**Environment:** PostgreSQL 16.15 (Ubuntu), temporary cluster `/tmp/commaudit` (port 55432, `trust` auth), database `commaudit` dropped + recreated per run. **Production was never contacted.**

**Shim (validation-only, in `/tmp`, never committed):** roles `anon`/`authenticated`/`service_role` (nologin); `auth.users` + `auth.uid()` (`request.jwt.claim.sub`); `storage.buckets`/`storage.objects` + `storage.foldername(text) → text[]`; `create publication supabase_realtime` (so the DO-blocks exercise the real `ALTER PUBLICATION ADD TABLE` path); then the repo's **real** platform prerequisites: `20261011000000_notifications.sql` verbatim + `set_updated_at()` from `20250512000000_auth_foundation.sql`.

**Result (exact order: shim → platform → v1 → v2 → … → v9, each with `ON_ERROR_STOP=1`):**

```
PASS  shim.sql
PASS  20261011000000_notifications.sql
PASS  platform_set_updated_at.sql
PASS  v1 .. PASS  v9          ← 12/12 files, ZERO SQL errors
```

Log scan: no ERROR/WARNING; only the expected idempotency `NOTICE`s from `DROP POLICY IF EXISTS … does not exist, skipping` (by design).

**Resulting schema:** 24 public tables · 66 community indexes · 53 RLS policies (public+storage) · 18 community/support functions · `notification_type` = 13 values · private bucket `community-images` (2 097 152 B, jpeg/png/webp) · realtime publication = 7 tables (`notifications`, `community_messages`, `community_friendships`, `community_conversations`… exactly: `community_answers`, `community_direct_messages`, `community_dm_reactions`, `community_friendships`, `community_messages`, `community_questions`, `notifications` — voice excluded by design).

**Functional smoke: 33/33 PASS**, including: reversed conversation pair rejected (23505, expression index); self-conversation rejected (23514); 25-char tag and 6-tag questions rejected (helper CHECK); wrong-room pin rejected (helper CHECK — the no-op bug is gone); pin accepted in matching room; membership trigger auto-creates roles; `community_notify` first call → row id, retry → null, exactly 1 row; DM + reaction + `community_dm_summary` visible to peer; voice join/reuse/partial-unique, sync +1 and end-at-0; sweep returns 0; quota returns 0; `community_search` finds the message for a third user.

## 16. Application-code reference verification

Every community table/RPC referenced in `src/` was matched against the migrations:

- **All 21 `supabase.from("…")` table references resolve** to defined tables (rooms, profiles, messages, reactions, mentions, room_read_state, friendships, blocks, conversations, direct_messages, dm_reactions, dm_read_state, voice_conversations, memberships, questions, answers, pins, reports, moderation_actions, reputation_events).
- **All 16 RPCs used by the app exist:** `community_room_unread_summary`, `community_dm_summary`, `community_notifications_unread`, `community_notify`, `community_notifications_page`, `community_voice_join`, `community_voice_sync_count`, `community_user_role`, `community_is_moderator`, `community_is_admin`, `community_search`, `community_home_activity`, `community_image_storage_usage`, `community_voice_sweep_stale` (+ trigger helpers `handle_community_membership`, `set_status_changed_at`).
- `community_read_state` is defined (v1) and used by server code/tests; the remaining `community_*` tokens in `src/` are JS action/broadcast-channel names, not DB objects.
- No orphan references (no app reference without a migration definition; every `public.*` qualifier in the SQL resolves to a community or platform object).

## 17. Fixes applied + regression tests + gates

**In-place fixes (filenames unchanged, no squash, no new migration files — legitimate because none were ever applied to production):**
- `20261028000000_community_v3_social.sql` — BUG 1 (expression UNIQUE table constraint → unique expression index + self-check).
- `20261031000000_community_v6_advanced.sql` — BUGS 2–6 (two IMMUTABLE CHECK helpers; `p_` parameter rename against column shadowing; `pg_catalog.websearch_to_tsquery` ×5; `null::uuid as question_id` in the first UNION branch).

**Tests:**
- `tests/community-social.test.ts` — the assertion pinning the old invalid text (`… unique (least(member_a, member_b),`) re-expressed to pin the **fixed** pattern: the self-check, `create unique index community_conversations_unique_pair` on `(least…, greatest…)`, and an explicit `not.toContain` against the old invalid form (intent preserved: one row per unordered pair — now DB-enforced the legal way).
- **New `tests/community-migrations-audit.test.ts` (14 tests):** v3 regression (index + self-check + no expression-UNIQUE constraint); v6 regressions (helpers IMMUTABLE and defined **before** their tables, CHECKs call them, no subquery in the extracted CHECK expressions, pins-helper parameter shadowing guard, `pg_catalog.websearch_to_tsquery` ×5 and no `public.` form, `null::uuid as question_id` alias); generic scan over **all 9 files** — no subquery in any constraint CHECK (with positive controls so the scan can't pass vacuously: v5 alone yields exactly 4) and no expression UNIQUE table constraint anywhere.

**Gates (all green after the fixes):**
| Gate | Result |
|------|--------|
| `npm test` | **3009/3009 passed** (129 files) — baseline 2995 + 14 new audit tests |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm run build` | compiled successfully |

## 18. Production rollout procedure (recommended)

1. No data to migrate (production has zero community objects) → apply v1–v9 **in file order** via the Supabase migration pipeline (`supabase db push` / dashboard SQL editor per file) — each file is now known to be individually valid.
2. After v9, verify: `select count(*) from public.community_rooms;` → 21; `select enum_range(null::public.notification_type);` → 13 values; `select * from storage.buckets where id='community-images';` → private, 2 097 152.
3. If any file fails mid-apply: the file is transactional per-statement in the dashboard editor — on error, inspect which object is missing and resume from there (section 14 table), or reset the community objects and re-apply from v1 (production community data does not exist yet).
4. The previously failed manual v3 attempt can be re-run safely — it will now create `community_conversations` with the expression index instead of erroring at `42601`.

## 19. Final verdict

**COMMUNITY SQL AUDIT** (post-fix, fresh-DB proven):

| Migration | Verdict |
|-----------|---------|
| v1 `20261014000000_community.sql` | **PASS** — valid PostgreSQL, applies first, zero errors |
| v2 `20261027000000_community_v2.sql` | **PASS** — valid PostgreSQL, applies clean |
| v3 `20261028000000_community_v3_social.sql` | **PASS** — pre-fix **FAIL**: bug 1, `42601` expression UNIQUE table constraint (the production failure); fixed in place, index verified live |
| v4 `20261029000000_community_v4_presence_notifications.sql` | **PASS** — valid PostgreSQL, applies clean (re-run hazard documented) |
| v5 `20261030000000_community_v5_voice.sql` | **PASS** — valid PostgreSQL, applies clean, partial-unique + ON CONFLICT WHERE verified |
| v6 `20261031000000_community_v6_advanced.sql` | **PASS** — pre-fix **FAIL**: bug 2 (subquery in questions CHECK), bug 3 (subquery in pins CHECK), bug 4 (pins helper parameter shadowing → no-op check), bug 5 (`public.websearch_to_tsquery` runtime 42883), bug 6 (UNION `?column?` → runtime 42703 on every search call); all fixed in place, verified live |
| v7 `20261101000000_community_v7_image_quota.sql` | **PASS** — valid, fully re-runnable |
| v8 `20261102000000_community_v8_image_read_policies.sql` | **PASS** — valid, row-pinned policies verified (re-run hazard documented) |
| v9 `20261103000000_community_v9_voice_stale_sweep.sql` | **PASS** — valid, fully re-runnable, sweep verified live |

**Overall: 9/9 PASS on a fresh database with ZERO SQL errors and 33/33 functional checks.** The three original blockers (v3 42601; v6 ×2 subquery CHECKs) plus three latent runtime bugs (shadowing no-op, `public.websearch_to_tsquery`, UNION column naming — all would have broken the Community feature at first use, not at migration time) are fixed, regression-tested, and gate-verified.
