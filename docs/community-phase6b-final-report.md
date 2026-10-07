# Community Phase 6B — Security Hardening: Final Report

**Project:** AusbildungsWeg (`ausbildung-hunter-ai`)
**Phase:** Community 6B (per `docs/community-phase6-discovery-report.md`)
**Date:** 2026-10-07
**Status:** **PHASE 6B COMPLETE — UNCOMMITTED**

---

## 1. Scope

Phase 6B implemented exactly the two security-hardening items from the Phase 6
discovery. No other work was touched.

| Item | Description | Status |
|---|---|---|
| B-1 | Room-scoped storage **READ** policies for `community-images` (closes S-2) | ✅ implemented |
| B-2 | Suspend → **LiveKit server-side eviction** (closes S-4) | ✅ implemented (seam + honest states; infra not present in this environment — see §13) |

**Files changed:**

- NEW `supabase/migrations/20261102000000_community_v8_image_read_policies.sql`
- NEW `src/lib/voice/livekit-api.ts` (server-only LiveKit RoomService client)
- MOD `src/lib/community/moderation.ts` (eviction hook inside `suspend_user` only)
- NEW `tests/community-phase6b.test.ts` (48 tests)

**Explicitly out of scope and NOT started:** 6C (voice TTL), 6D
(infrastructure/runbook), 6F (question moderation), UX, performance.
No baseline test was modified in this phase (0 edits to existing test files).
All Phase 6A work (uncommitted) is preserved byte-for-byte except
`moderation.ts` receiving the additive hook.

---

## 2. B-1 Implementation

**Discovery state (verified against migrations, not assumed):**

- Bucket `community-images` is **private** (`public = false`, 2 MB limit,
  MIME allowlist — v1, never flipped by any later migration; guard-tested).
- The single non-DM SELECT policy
  `"Community members can read community images"` (v1, re-issued in v3)
  was: `bucket_id = 'community-images' and (foldername(name))[1] <> 'dm'`
  → **every authenticated user could read every non-DM object by knowing
  its path** — including images of moderator-hidden messages, images in
  disabled rooms, and questions from blocked authors.
- The DM SELECT policy
  `"Members can read dm images of their conversations"` (v3) was **already
  correctly scoped** to `auth.uid() in (member_a, member_b)` of the
  `dm/{conversation}/…` conversation — per the discovery note "DM policy
  unchanged", it was left byte-for-byte intact.
- Insert/delete policies (own-folder uploads; own-image deletes) unchanged.

**Schema fact that shapes the fix (derived from v2/v6, no guessing):**
there is **no per-room membership table**. `community_rooms` are open to
all authenticated members; the room-access gate is `room.enabled = true`
(room read RLS "Community members can read enabled rooms"; the server API
`fetchRoomBySlug` filters `eq("enabled", true)`). `community_messages`
read RLS = `hidden_by is null` (v6); `community_questions` read RLS =
enabled room + no block in either direction (v6). "Room-scoped" therefore
means: *the object must be referenced by a live row that the requester is
already authorized to read under the existing row RLS, in an enabled room*.
No parallel permission model was invented.

**Change:** one migration, one drop, two creates (see §6).

**Compatibility (all verified):**

- `createSignedUrl` runs on the session client → it is RLS-gated → the new
  policies decide exactly who may sign. Authorized users (viewers of
  enabled rooms, non-blocked question readers, DM participants) sign as
  before; everyone else gets no URL. The three display components
  (`room-chat`, `question-detail`, `dm-chat`) are unchanged.
- Moderation, GDPR deletion/export, and the 6A janitor use the
  **service-role** admin client, which bypasses storage RLS — unaffected.
- Upload paths, the 2 MB limit, and the 100 MB quota gate are unchanged
  (re-verified in the audit, §7).

---

## 3. Exact Storage Authorization Model (final state)

| Object shape | Readable by (SELECT policy) | Condition |
|---|---|---|
| `{uid}/{message_id}/image.{ext}` | "Room-scoped members can read message images" (v8) | `exists community_messages m: m.image_path = name ∧ m.id::text = lower(seg2) ∧ m.user_id::text = lower(seg1) ∧ m.hidden_by IS NULL ∧ room(m) enabled` |
| `{uid}/{question_id}/image.{ext}` | "Room-scoped members can read question images" (v8) | `exists community_questions q: q.image_path = name ∧ q.id::text = lower(seg2) ∧ q.author_id::text = lower(seg1) ∧ room(q) enabled ∧ NO community_blocks row in either direction between viewer and author` |
| `dm/{conversation}/{sender}/{msg}/image.{ext}` | "Members can read dm images of their conversations" (v3, **unchanged**) | `exists community_conversations c: c.id = seg2 ∧ auth.uid() IN (c.member_a, c.member_b)` |
| anything else (no live row, malformed segments, top-level, wrong owner folder) | **nobody** (fail-closed) | no policy matches → denied |

Properties (all test-guarded):

- **Path knowledge is never sufficient** — the object must be pinned to a
  live, readable DB row by `image_path = name` plus id/author segment
  equality (text comparison, `lower()`-normalized; no raising casts, so
  garbage paths filter out instead of erroring the read).
- **Hidden ≠ readable** — moderator hiding a message revokes its image
  immediately (RLS + explicit `hidden_by is null`).
- **Disabled room ≠ readable** — matching the room directory and the API.
- **Block-aware for questions** — mirrored verbatim from the question RLS.
- **DMs isolated** — a DM image is readable only by the two conversation
  participants; non-participants are denied even with the exact path.
- **Bucket stays private; nothing granted to anon/public; no write-policy
  change.** Subqueries in the policies also evaluate under the target
  tables' own RLS (defense in depth: the explicit conditions duplicate
  what RLS already enforces).

---

## 4. B-2 Implementation

**Discovery state (verified):** `POST /api/community/voice/token` blocks
suspended/muted users from NEW joins (write gate → 403), but a suspended
user already connected to the SFU kept the live session — no server-side
LiveKit API integration existed. Provider room names are deterministic:
`croom-<room id>` (derived inside `community_voice_join`). `LIVEKIT_*`
env vars are declared in `.env.example` but **not set in this
environment** → voice is in its documented "unconfigured" state.

**Change:** new server-only module `src/lib/voice/livekit-api.ts`
(contract verified against the LiveKit Server API docs + the official
`livekit-server-sdk` source — Twirp JSON over
`POST {http(s)}/twirp/livekit.RoomService/{Method}`, Bearer admin JWT):

1. `createLiveKitAdminToken(apiKey, apiSecret, videoGrant)` — HS256 JWT
   signed with the API secret, `{ iss, nbf, exp(600 s), jti, video }`,
   **no `sub`/identity** (service token), minimal per-call grants:
   `ListRooms → { roomList: true }`, `ListParticipants /
   RemoveParticipant → { roomAdmin: true, room }`. No roomJoin, no
   publish/subscribe, no roomCreate.
2. `liveKitApiBase(wsUrl)` — the official SDK's `wss→https` /
   `ws→http` rewrite of the configured URL.
3. `evictLiveKitParticipant(identity)` — **the SFU is the authoritative
   source** (the DB count shadow is client-reconciled and cosmetic):
   `ListRooms` → keep `croom-*` rooms with participants (cap 50) →
   `ListParticipants` per candidate → collect rooms containing the
   identity → `RemoveParticipant` in each (best-effort per room).
   Every request has a 5 s `AbortSignal.timeout`; the function
   **never throws**.

**Hook (only integration point):** `performModerationAction` →
`suspend_user` branch, after the profile update + audit insert:
`await evictLiveKitParticipant(targetId)` with explicit logging per
outcome (`evicted` → warn; `unavailable` → error with detail;
`not_configured` / `not_in_any_room` → info). The action's return value
still reports only the sanction (`{ ok: true }` = the suspension
definitely happened) — it **never claims** an eviction that did not
happen. `reinstate_user` and all other actions do **not** evict.

**Security:** the evicted identity is `targetId` — the uuid-validated
sanction target of an admin-role-gated server action
(`performModerationActionAction`: `requireRole("moderator")` +
`isAdmin` for suspend/reinstate + rate limit). No client parameter, no
API endpoint, and no client code can select a victim. LiveKit
credentials are read only via the existing server-only
`getLiveKitVoiceConfig()`; nothing in this module is importable from the
browser (`import "server-only"` + invariant tests).

---

## 5. LiveKit Eviction Behavior

| Situation | Result state | Effect |
|---|---|---|
| `LIVEKIT_*` env not set (current environment) | `not_configured` | no-op, no network, logged as info — **not reported as success** |
| SFU reachable, user in no active room | `not_in_any_room` | honest "nothing to evict", no `RemoveParticipant` calls |
| SFU reachable, user removed from every located room | `evicted` + room list | live session(s) terminated; on **LiveKit Cloud** the participant's token is also revoked (no instant rejoin with a cached token) |
| Transport failure / API refusal / partial failure | `unavailable` + detail (what worked, what failed) | logged as ERROR; the sanction itself still succeeds; **no success claim** |

The suspended user's client receives a LiveKit disconnect; any rejoin
attempts are rejected at the token route by the write gate (403
`suspended` — regression-tested). On **self-hosted** LiveKit,
`RemoveParticipant` does not revoke cached tokens (cloud-only feature):
exposure is bounded by the 10-minute join-token TTL, after which only
new tokens could reconnect — and those are refused.

**What this is NOT:** production-verified eviction. No LiveKit cluster is
configured in this environment; the code is fully unit-tested against the
documented API contract, and the D-2 end-to-end pass (join → suspend
mid-call → evicted) requires the provisioned cluster (discovery phase
6D/§13 below).

---

## 6. Migration(s)

**B-1 — `supabase/migrations/20261102000000_community_v8_image_read_policies.sql`:**

- DROPS exactly one policy: `"Community members can read community
  images"` (the broad authenticated read).
- CREATES exactly two SELECT policies (message images, question images)
  — both `to authenticated`, both row-pinned (§3).
- Nothing else: no tables, no columns, no functions, no grants, no data
  statements, no `storage.buckets` change, no insert/update/delete policy
  change, no 6C/6D/6F content. Rollback documented in the header
  (recreate the v3 text). 8 guard tests pin the executable SQL.

**B-2 — no migration** (verified: eviction needs no schema;
`community_voice_conversations` and all voice RPCs untouched).

---

## 7. Security Audit (focused, Phase 6B)

Performed against final source; every item **PASS**, no fix required.

| # | Check | Result |
|---|---|---|
| 1 | Every `community-images` reference (14 sites in src) categorized | PASS — 3 gated upload routes (quota + byte validation before `upload`), 4 service-role remove/GDPR/janitor/quota sites, 3 session-client `createSignedUrl` components; no other write or read surface |
| 2 | Every `storage.objects` SELECT policy (final state across all migrations) | PASS — `community-images` has exactly 3: v3 DM (participant-scoped, unchanged) + v8 message + v8 question (row-pinned). The two broad policies (v1/v3) are dropped; other buckets' policies untouched |
| 3 | Every LiveKit moderation/suspension path | PASS — single call site: `moderation.ts` `suspend_user` branch (admin-gated server action); credentials only in `livekit-token.ts`/`livekit-api.ts` (both server-only) |
| 4 | No alternate image upload path | PASS — full-source scan: the only `.upload(` calls on `community-images` are the three routes, each with the 6A quota gate strictly before the upload |
| 5 | No client-side LiveKit admin operation | PASS — no API route imports `livekit-api` (invariant test); no `use client` file imports `livekit-api`/`livekit-token`/secret; no `removeParticipant`/`roomServiceClient` anywhere in app/components; the only importer is `moderation.ts` |
| 6 | Signed-URL compatibility for authorized users | PASS — components unchanged; policy allows exactly the rows their RLS already allowed |
| 7 | 2 MB limit / 100 MB quota intact | PASS — bucket row untouched; quota helper + gates unchanged (6A tests green) |
| 8 | GDPR deletion / export / janitor intact | PASS — service-role bypasses RLS; 6A suites green (20/20 account-data, 40/40 phase6a) |
| 9 | Suspension cannot be self-triggered / victim-selectable | PASS — admin+ role guard, uuid-validated target, rate-limited, audited; identity for eviction = sanctioned `targetId` |
| 10 | No fake eviction states | PASS — result taxonomy is closed (`not_configured` / `not_in_any_room` / `evicted` / `unavailable`); `unavailable` carries detail; action result never reports eviction success |

---

## 8. Tests

| Suite | Tests | Result |
|---|---|---|
| NEW `tests/community-phase6b.test.ts` | 48 | 48/48 ✅ |
| **Full suite (`npm test`)** | **2960** | **2960/2960 ✅ (127 files, 0 failures)** |

New coverage by area (spec scenarios mapped):

- **v8 migration guards (8):** exact drop of the one obsolete policy;
  exactly two row-pinned SELECT creates; message conditions (exact path,
  id/author segments, `hidden_by is null`, enabled room, no raising
  casts); question conditions (enabled room + block in EITHER direction);
  no broad read reintroduced; bucket/other policies untouched; no
  6C/6D/6F content; v1 `public=false` never flipped.
- **B-1 behavior (13):** scenarios 1–10 — member read ✅; disabled-room
  deny ✅; hidden-message deny ✅; question read ✅; blocked-author deny
  (both directions) ✅; disabled-room question deny ✅; DM participant
  read ✅; DM outsider deny ✅; path-knowledge bypass denied (ghost row,
  malformed, top-level, wrong owner folder) ✅; bucket privacy ✅;
  signed-URL flow unchanged/denied appropriately ✅; 6A surfaces intact ✅;
  case-insensitive id matching ✅.
- **B-2 admin token (4):** HS256 structure, `iss`, no `sub`, exact
  per-call `video` grants, TTL, signature verify/fail, secret leakage.
- **B-2 eviction flow (10):** unconfigured → `not_configured` (0 calls);
  full happy path (exact Twirp URLs, POST, bodies, per-call Bearer
  grants, identity binding); multi-room eviction; empty-room skip;
  camelCase tolerance; `not_in_any_room` (no Remove calls); foreign
  (non-`croom-*`) rooms ignored; network failure → `unavailable`
  (never throws); API refusal → `unavailable` with Twirp message; partial
  failure → `unavailable` with both facts; 50-room cap.
- **B-2 suspension integration (5):** scenario 12 (sanction + eviction,
  identity = target, audit written, warn logged); unconfigured no-op
  (info logged, 0 network); scenario 15 (SFU down → sanction still
  `{ok:true}`, ERROR logged, no eviction claim); `timeout_user` no
  eviction; `reinstate_user` no eviction.
- **B-2 token-route regression (3):** scenario 11 (suspended → 403
  `suspended`); muted → 403 `muted`; scenario 16 (active user → 200 +
  join token, no secret in response).
- **B-2 boundaries (4):** scenarios 13/14 (no endpoint, single importer,
  server-only, no client admin ops, credential surface unchanged).

---

## 9. Typecheck

`npm run typecheck` (`tsc --noEmit`) — **PASS, exit 0, 0 errors**.

## 10. Lint

`npx eslint .` — **PASS, exit 0, 0 errors, 0 warnings**.

## 11. Build

`npm run build` — **PASS, exit 0** ("✓ Compiled successfully").

## 12. Non-regression

- **Baseline:** Phase 6A closed at **2912** tests.
- **Phase 6B:** full suite = **2960** → baseline **preserved and
  increased by exactly the 48 new Phase 6B tests**; 0 failures.
- **Zero existing test files were modified** in this phase (stronger
  guarantee than 6A, where 3 baseline tests were re-expressed).
- Phase 6A behavior (GDPR deletion/export, quota, janitor) and all
  Phase 1–5 invariants remain green (their suites untouched).
- Voice client code frozen per discovery: the only voice change is the
  additive `livekit-api.ts` + the `suspend_user` hook.

## 13. Infrastructure Requirements Still Outstanding

**Not claimed production-ready: LiveKit eviction is code-complete and
unit-verified against the documented API contract, but NO LiveKit
cluster is configured in this environment** (`.env` absent; only
`.env.example`). Required for real operation + verification:

1. **LiveKit cluster** (LiveKit Cloud or self-hosted) — the same three
   vars already used by the token route: `LIVEKIT_URL`,
   `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (deployment item from
   discovery 6D-1; no code change needed — eviction activates
   automatically once configured).
2. **D-2 end-to-end pass** (manual, on the provisioned cluster): join →
   suspend mid-call → participant disconnected; verify token revocation
   on LiveKit Cloud; on self-hosted, confirm the 10-minute cached-token
   bound.
3. **Self-hosted note:** token revocation on `RemoveParticipant` is a
   LiveKit **Cloud** feature; self-hosted deployments should be aware of
   the bounded cached-token window (see §5).
4. **Join-token format verification:** see §14.1 — the existing Phase 4
   join token (frozen) should be validated against a live cluster during
   D-2, as its claim layout differs from the current LiveKit spec.

## 14. Known Limitations

1. **Pre-existing join-token format (frozen, out of scope):**
   `livekit-token.ts` (Phase 4) places grants under a `metadata` claim
   with custom `name`/`avatarId` keys, whereas the current LiveKit spec
   (verified today against docs + official SDK) uses a `video` grants
   field. The Phase 4 file is frozen per the discovery non-regression
   rules and no cluster exists to verify against; the NEW admin token in
   `livekit-api.ts` follows the current verified spec. **Verify the join
   token during the D-2 E2E pass; fix in a follow-up if the cluster
   rejects it.**
2. **Self-hosted cached-token window:** on self-hosted LiveKit, a
   suspended user's cached unexpired join token (≤ 10 min TTL) could
   reconnect once after eviction (cloud revokes). Bounded; new tokens
   are refused by the write gate.
3. **Policy subquery cost:** the v8 policies correlate on
   `image_path` (no index on that column). Signed-URL generation
   evaluates the policy for a single object (storage looks up by unique
   `(bucket_id, name)`), so the practical cost is one small exists-check
   per sign — the same pattern the existing v3 DM policy already uses.
   If object counts grow large, an `image_path` index is the
   follow-up (performance, not security).
4. **Eviction room scan cap:** 50 candidate rooms per eviction
   (`LIVEKIT_MAX_CANDIDATE_ROOMS`). Far above any realistic concurrency
   on a dedicated cluster (one active conversation per community room);
   a shared cluster with >50 simultaneous `croom-*` rooms would need the
   cap raised.
5. **Reinstation is intentionally non-evicting:** a reinstated user keeps
   any live session (they are allowed to be there again); no
   disconnect/reconnect is forced.

## 15. Explicit Confirmation — 6C / 6D / 6F NOT Implemented

- **Phase 6C (voice TTL / reliability, C-1 check:env, C-2 TTL sweep):
  NOT started.** No TTL code, no `community_voice_conversations` change
  (guard-tested in the v8 SQL).
- **Phase 6D (infrastructure runbook, D-1/D-2): NOT started.** No
  runbook doc, no provisioning changes; requirements listed in §13.
- **Phase 6F (question moderation, F-1…F-3): NOT started.** No question
  status/CHECK changes, no new moderation actions (guard-tested).
- **Voice/LiveKit client stack unchanged** except the additive
  `livekit-api.ts` + the `suspend_user` hook (the exact B-2 surface).
- **No Git operations were performed** — no commit, push, reset,
  checkout, stash, clean, or branch change; the working tree remains
  uncommitted (Phase 6A + 6B both pending commit).

---

## Final Declarations

1. **Phase 6B is COMPLETE** — B-1 (v8 row-pinned read policies) and B-2
   (server-side eviction seam with honest state reporting) implemented,
   tested (48 new tests), and audited.
2. **Exact security model:** §3 (object shape → authorizing row →
   condition; fail-closed; bucket private; DMs participant-only).
3. **Eviction is best-effort and never faked:** `not_configured` /
   `not_in_any_room` / `evicted` / `unavailable` — all explicit.
4. **Gates:** typecheck ✅ (exit 0) · lint ✅ (exit 0) · `npm test` ✅
   (**2960/2960** = 2912 baseline + 48 new) · build ✅ (exit 0).
5. **Phases 6C/6D/6F are NOT implemented.**
6. **NO GIT OPERATIONS PERFORMED.**
