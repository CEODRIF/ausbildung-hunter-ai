# Community Phase 6A — Production Hardening: Final Report

**Project:** AusbildungsWeg (`ausbildung-hunter-ai`)
**Phase:** Community 6A (per `docs/community-phase6-discovery-report.md`)
**Date:** 2026-10-07
**Status:** **PHASE 6A COMPLETE — UNCOMMITTED**

---

## 1. Scope

Phase 6A implemented exactly four hardening items (A-1 … A-4) plus one
additive v7 migration, per the discovery report. No other feature was
touched. Explicitly out of scope and **not started**: Phase 6B (room-scoped
storage read policies), 6C (voice TTL), 6D, 6F.

| Item | Description | Status |
|---|---|---|
| A-1 | GDPR **deletion** — Community images (incl. DM images) erased on account deletion | ✅ implemented |
| A-2 | GDPR **export** — Community images (incl. DM images) inventoried in user export | ✅ implemented |
| A-3 | Server-side per-user community image **quota** (100 MB) | ✅ implemented |
| A-4 | Storage **janitor** coverage for `community-images` | ✅ implemented |
| v7 | Additive migration: single quota RPC only | ✅ implemented |

**Files changed:**

- NEW `supabase/migrations/20261101000000_community_v7_image_quota.sql`
- NEW `src/lib/community/image-quota.ts`
- NEW `tests/community-phase6a.test.ts` (40 tests)
- MOD `src/lib/account-data.ts` (A-1, A-2)
- MOD `src/lib/storage-reconcile.ts` (A-4)
- MOD `src/app/api/community/questions/route.ts` (A-3 gate)
- MOD `src/app/api/community/messages/route.ts` (A-3 gate)
- MOD `src/app/api/community/dm/[conversationId]/messages/route.ts` (A-3 gate)
- MOD `tests/account-data.test.ts` (3 baseline tests updated to the new — strictly stronger — deletion/export contract; intent preserved, assertions never weakened)

---

## 2. GDPR Deletion (A-1)

**Problem (discovery, HIGH):** `deleteUserAccount` swept only
`ai-files` / `application-attachments` / `avatars`. Community images —
room messages, questions, and **DM images** — survived account deletion.
DM paths are conversation-prefixed (`dm/{conv}/{sender}/{msg}/image.{ext}`),
so a storage LIST can never attribute them to the deleted user; only the
referencing DB rows can — and the auth cascade deletes those rows.

**Design (`src/lib/account-data.ts`), order matters:**

1. **Community reference inventory FIRST** — `collectCommunityImagePaths`
   reads `image_path` from the user's own rows in
   `community_messages` (`user_id`), `community_questions` (`author_id`),
   `community_direct_messages` (`user_id`), each `limit(1000)`.
   **Any read failure → `null` → the whole deletion aborts** with
   `account_deletion_failed: community reference read` — nothing cascades,
   nothing is swept. A partial inventory is never acted on.
2. `application_drafts` delete (FK RESTRICT guard, unchanged).
3. `admin.auth.admin.deleteUser` (auth cascade, unchanged).
4. Storage sweeps — unchanged 3-bucket user-prefix sweep, then:
   - **exact removal** of every collected path (deduped, batches ≤ 100) —
     the *only* mechanism that reaches DM images;
   - **user-prefix backstop** list+remove on `community-images`
     (`startsWith(userId + "/")`, excluding already-exact paths) —
     catches any room/question object whose row was already gone.

**Safety properties (all tested):**

- **No other user's object is ever deleted** — every removed path is
  either from the user's *own* rows or under the user's *own* prefix.
- **Safe on missing objects / missing references** — remove of absent
  objects and empty inventories are no-ops (`storageSwept` stays `true`).
- **No broad bucket wipe** — every storage LIST uses a user-scoped
  `search` prefix; there is no unfiltered list anywhere in the flow.
- **Existing behavior preserved** — drafts-first, auth cascade, and the
  3 legacy sweeps run in the same order as before; only the inventory is
  prepended and the community block is appended.

---

## 3. GDPR Export (A-2)

**Problem (discovery, HIGH):** the export's storage inventory covered only
the three user-prefixed buckets; community images were invisible to
`/api/account/export`.

**Design (`src/lib/account-data.ts`):**

- The user-prefix inventory loop now also lists `community-images` with
  `search: {userId}/` plus a defensive `startsWith` re-check (search is a
  substring match). Room + question images appear with metadata,
  `size: null` when the bucket has none.
- **DM images:** collected from the user's **own** DM rows only, grouped
  by *sender folder* (`dm/{conv}/{userId}` — first 3 segments), each
  folder listed (up to 100 folders) and **exact-name filtered** against
  the collected own paths. Listing the own sender folder — never the
  whole conversation — means the peer's objects are structurally never
  surfaced. Paths the list could not confirm are still reported as
  references with `size: null` (best-effort inventory; the account data
  sections remain authoritative).
- The whole DM-inventory block is wrapped so a failure degrades to an
  incomplete *inventory* only — it can never break the export itself.

**Safety properties (all tested):** every storage entry in
`storage_files` is either under the user's own prefix or a path taken
from the user's own rows; other users' rows, other users' folders, and
the encrypted-credential table are never queried.

---

## 4. Upload Quota (A-3)

**Problem (discovery):** unbounded per-user growth of `community-images`;
the 2 MB per-image limit does not bound a user's *total*.

**Design:**

- **Single additive RPC** (v7 migration)
  `public.community_image_storage_usage(uuid) → bigint`, counting
  `storage.objects` in `community-images` by path shape:
  - `strpos(name, user||'/') = 1` — room + question images (owner = 1st segment);
  - `name LIKE 'dm/%/'||user||'/%'` — DM images (owner = 3rd segment).
  UUIDs cannot contain LIKE wildcards → injection-safe by construction.
  No path shape can match both branches.
- **`src/lib/community/image-quota.ts`** (server-only):
  `COMMUNITY_USER_IMAGE_QUOTA_BYTES = 100 * 1024 * 1024` (100 MB, the
  discovery value) checked via
  `checkCommunityImageQuota(userId, additionalBytes)` using the
  **service-role admin client**.
  - **Fails CLOSED:** any RPC error → `{ ok: false, code: "quota_check_failed" }`
    → the endpoint answers **500**. A database that cannot report usage
    cannot verify the quota; uploading first would only create orphans.
  - Missing RPC (pre-migration environment) → treated as 0 used; the 2 MB
    per-image limit and rate limits still apply.
- **Gated in all three upload endpoints, server-side, BEFORE the
  storage upload** (after byte validation):
  - `POST /api/community/questions`
  - `POST /api/community/messages`
  - `POST /api/community/dm/[conversationId]/messages`
  Over quota → **413 `{ error: "storage_quota" }`** with no storage
  object created.

**Bypass analysis (audit, §7):** the *only* writers to
`community-images` are these three API routes — verified by full-source
scan (`community-images` appears elsewhere only as read-only
`createSignedUrl` in three client components and `remove` in the
delete/moderation paths). The bucket is private; there is no client
upload path, no alternate endpoint, no admin route. The 2 MB per-image
limit is unchanged and still enforced by byte validation and the bucket
policy.

**Orphan prevention (audit, §7):** the quota gate runs strictly before
`storage.from(...).upload(...)`, so a rejected upload never creates an
object. (Residual orphans from pre-existing failure windows are covered
by the A-4 janitor.)

---

## 5. Storage Janitor (A-4)

**Problem (discovery):** the Phase 17 janitor reconciled only `ai-files`
and `application-attachments`; `community-images` was uncovered.

**Design (`src/lib/storage-reconcile.ts`):**

- New bucket spec: `community-images` with `referenceTables` =
  `community_messages.image_path`, `community_questions.image_path`,
  `community_direct_messages.image_path` (**sender-agnostic**: a
  referenced object survives regardless of whose row points at it — the
  peer's live image is never a candidate), plus `dmScan: true`.
- **Row-reference-proof strategy:** the reference set is the union of
  every live referencing row (paginated, 1000/page, max 50 pages) —
  an object is deletable only when *no live row* references it.
- **DM gate (new):** objects under the conversation-prefixed `dm/`
  namespace are candidates only when
  1. the name matches `dm/{uuid}/{uuid}/…` (`DM_PATH_SHAPE`, strict
     UUID shape, case-insensitive), AND
  2. the **sender** (captured 3rd segment) is a **live profile** —
     otherwise the object is reported (`unknownPrefix`) and **never
     deleted**.
- Everything else reuses the existing, already-audited safety model:
  - **DRY-RUN by default** (`execute === true` required to delete);
  - **24 h age grace** (unknown age → too young, never deleted);
  - **user-prefix gate** for the user-namespace pass;
  - **double-check** — references re-collected immediately before
    deletion; a row appearing between scan and delete wins;
  - **bounded** — `maxDeletes` clamped to 1…100 (storage batch limit);
  - **loud failure** — any DB read or storage LIST error aborts the
    whole tick; per-batch REMOVE errors are counted, never thrown
    (retry-safe: failed batches simply resurface next tick).

**Cross-user deletion is impossible** (tested): a candidate must be
either under the owner's own UUID prefix (deleting the user's *own*
orphan) or a DM object whose own row no longer exists **and** whose
sender prefix still belongs to a live user — in that case the deleted
object is the *deleted sender's* file, which is the correct owner. An
object referenced by any live row (including a peer's row) is always in
`referenced` and skipped.

---

## 6. Migration (v7)

`supabase/migrations/20261101000000_community_v7_image_quota.sql`

- **ADDITIVE ONLY.** Contains exactly one object:
  `create or replace function public.community_image_storage_usage(uuid)`.
  No tables, no policies, no grants on data, no drops, no data
  statements. No 6B/6C/6F content (explicitly documented in the header).
- `security definer` + `set search_path = public` + `stable` — reads
  `storage.objects` (RLS-bypassing, which is why it must be tightly
  locked down) with a deterministic, side-effect-free query.
- `revoke execute … from public, anon;` / `grant execute … to service_role;`
  — **service role only**; the only caller is the server-only quota
  helper.
- Rollback: single documented `drop function` (pure function, no
  dependent objects).
- **Guard tests** (5, in `tests/community-phase6a.test.ts`): the SQL text
  asserts exactly one `create … function`, the RPC name/signature,
  `security definer`, pinned `search_path`, the revoke + service_role
  grant, and the absence of destructive/foreign keywords
  (`drop table`, `alter table`, `create policy`, `truncate`, 6B/6C/6F
  markers). `create or replace` is intentionally excluded from the
  forbidden list (it is the required idempotent form for the one object).

---

## 7. Security Audit (focused, Phase 6A)

All checks performed against the final source; **every item PASS**, no
fix required.

| # | Check | Result |
|---|---|---|
| 1 | GDPR deletion correctness (order: inventory → drafts → cascade → sweeps; abort on unreadable inventory) | PASS — tests: inventory-first assertion, abort-on-inventory-failure, abort tests for drafts/auth failure |
| 2 | Deletion never touches other users' objects (no broad bucket wipe; every list user-scoped, every remove own-row/own-prefix) | PASS — "no broad bucket wipe" test asserts every list has a non-empty user search and every removed path starts with the user id |
| 3 | Deletion safe on missing objects / missing references (no error, `storageSwept=true`) | PASS |
| 4 | Export ownership: own rows only, own prefixes, own DM sender folders, exact-name filter, peer objects never surfaced | PASS — "lists only this user's storage files", "never queries other users' rows or the encrypted-credential table" |
| 5 | Quota bypass: no upload to `community-images` outside the three gated endpoints (full-source scan; clients sign URLs only; bucket private) | PASS |
| 6 | Quota server-side, pre-upload, fail-closed (RPC error → 500, upload skipped → no orphan) | PASS — 9 A-3 tests incl. over-quota 413, under-quota 201, RPC-error 500, all three endpoints |
| 7 | 2 MB per-image limit preserved (byte validation + bucket policy unchanged) | PASS — existing `tests/community.test.ts` image suites unchanged and green |
| 8 | Orphan prevention on rejected uploads (quota gate strictly before `upload()`) | PASS |
| 9 | Janitor false positives: dry-run default, grace, prefix/DM-shape/live-sender gates, double-check, bounded, loud failure | PASS — 11 A-4 tests incl. peer-referenced survival, dead-sender reporting, fresh-row double-check rescue, dry-run never removes |
| 10 | Janitor cross-user deletion impossible (sender-agnostic reference set + owner-scoped candidacy) | PASS |
| 11 | RLS: unchanged (v7 adds no table/policy; no existing policy touched) | PASS |
| 12 | RPC security: service_role-only, definer with pinned search_path, injection-safe UUID patterns | PASS — 5 migration guard tests |
| 13 | Service-role boundaries: `image-quota.ts`, `account-data.ts`, `storage-reconcile.ts` all `import "server-only"`; admin client only in server modules | PASS |

---

## 8. Tests

| Suite | Tests | Result |
|---|---|---|
| NEW `tests/community-phase6a.test.ts` | 40 | 40/40 ✅ |
| MOD `tests/account-data.test.ts` (3 baseline tests updated to the new contract; intent preserved, none weakened) | 20 | 20/20 ✅ |
| **Full suite (`npm test`)** | **2912** | **2912/2912 ✅ (126 files, 0 failures)** |

New coverage by area:

- **A-1 (10):** inventory-before-cascade ordering; abort on unreadable
  inventory; own-row/own-prefix removal only; no broad bucket wipe;
  dedupe + batching; missing objects safe; DM paths reached via exact
  removal; existing sweep order preserved.
- **A-2 (4):** community bucket in user-prefix inventory; DM folder
  listing exact-name filter (peer object present in folder, never
  returned); unconfirmed own path reported with `size: null`; no
  foreign table/row access.
- **A-3 (9):** 100 MB constant; under-quota ok; over-quota rejected;
  exact-boundary; RPC error → `quota_check_failed` (fail closed);
  null data → 0; all three endpoints return 413 `storage_quota` / 500
  `quota_check_failed` **without calling `upload`**.
- **A-4 (11):** dry-run default never deletes; execute deletes orphans
  after double-check; referenced object survives (incl. peer row);
  DM shape gate (malformed shape reported, never deleted); dead-sender
  DM object reported, never deleted; grace period; fresh-row rescue;
  `maxDeletes` clamp; list/read failure aborts tick; remove failure
  counted, retry-safe.
- **v7 guards (5):** see §6.

---

## 9. Typecheck

`npm run typecheck` (`tsc --noEmit`) — **PASS, exit 0, 0 errors** (re-run
after the final test-file edits).

## 10. Lint

`npx eslint .` — **PASS, exit 0, 0 errors, 0 warnings** (re-run after the
final test-file edits). React-Compiler rules (`react-hooks/*`) clean.

## 11. Build

`npm run build` — **PASS, exit 0** ("✓ Compiled successfully"); full route
table emitted (all 30+ routes, Proxy middleware intact).

## 12. Non-regression

- **Baseline:** Phase 5 closed at **2872** tests (2760 + 112).
- **Phase 6A:** full suite = **2912** → baseline **preserved and
  increased by exactly the 40 new Phase 6A tests**; 0 failures.
- The only baseline tests modified are 3 in `tests/account-data.test.ts`
  that encoded the *pre-6A* contract (6-entry inventory, 2-table owner
  map, deletion order without the inventory). Each was updated to the
  new — strictly stronger — contract with the same intent (user-scoped
  reads, ordering safety, no foreign-object removal). **No assertion was
  removed or relaxed anywhere.**
- Phase 5 behaviour (moderation, Q&A, roles, search, reputation,
  rate limits, 2 MB image validation, idempotent message ids) is
  covered by its existing suites, all green.

## 13. Known Warnings / Residual Notes

- **No build/test warnings.**
- *Quota counts from the storage catalog*, not from DB rows: an object
  whose row was already deleted still counts toward the owner's usage
  (correct — the bytes are still on disk). The A-4 janitor converges
  catalog and rows over time.
- *Inventory cap:* the deletion/export inventories use `limit(1000)`
  per source table (consistent with the existing `safeList` convention).
  A user with >1000 image rows in one source table would need the
  existing `safeList` pagination extended in a later phase; the backstop
  sweep + janitor bound the worst case (room/question objects are
  user-prefixed; DM objects beyond the cap are only at risk for users
  with >1000 image DM rows, and the deletion **aborts** rather than
  cascades if any read fails).
- *Quota race:* two concurrent uploads can both pass the pre-upload
  check (TOCTOU) — bounded by the 2 MB per-image limit + per-endpoint
  rate limits (max excess ≈ a few images). Acceptable per discovery; a
  row-level quota table would be the 6B+ option.
- Pre-existing, out of scope: `docs/community-phase5-final-report.md`
  §23 tech-debt items (unchanged by this phase).

## 14. Deferred (Phase 6B / 6C / 6D / 6F)

Explicitly **NOT started**, no code written, no migration content:

- **6B** — room-scoped storage **READ** policies for community images
  (the v7 migration header explicitly excludes read-policy work; the
  Phase 6A spec's "do NOT do the read-policy fix" constraint was
  honored).
- **6C** — voice/LiveKit TTL & infrastructure items.
- **6D** — deferred performance/observability items from discovery.
- **6F** — question moderation actions.
- **Voice/LiveKit: unchanged** — no file under the voice stack was
  touched in this phase.

---

## Final Declarations

1. **Phase 6A is COMPLETE** — A-1, A-2, A-3, A-4, and the v7 migration
   are implemented, tested, and audited as specified.
2. **Phases 6B, 6C, 6D, 6F are NOT started.**
3. **Voice/LiveKit is unchanged** (code complete vs. infrastructure
   required status is exactly as documented in the discovery report).
4. **The 2872-test baseline is preserved and increased** — full suite
   now 2912/2912 (2872 baseline + 40 new; 3 baseline tests re-expressed
   to the stronger contract, none weakened).
5. **Gates:** typecheck ✅ (exit 0) · lint ✅ (exit 0, 0 issues) ·
   `npm test` ✅ (2912/2912) · `npm run build` ✅ (exit 0).
6. **No Git operations were performed** — no commit, push, reset,
   stash, checkout, or clean; the working tree remains uncommitted.
