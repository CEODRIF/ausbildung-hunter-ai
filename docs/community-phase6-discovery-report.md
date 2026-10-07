# Community Phase 6 — Discovery & Planning Report

Date: 2026-10-07 · Mode: **READ-ONLY discovery** — no code, migration, or config was modified in this session. No Git command was executed. Phase 6 implementation NOT started.
Baseline verified: 2872 tests / typecheck / lint 0-0 / build — all green (Phase 5 final state, `docs/community-phase5-final-report.md`).

---

## 1. Current Community architecture

**Surfaces (15 app files):**
- Pages: `community/` (home), `[room]/` (chat + Q&A list), `questions/new`, `questions/[id]`, `search`, `moderation`, `friends`, `messages` + `messages/[conversationId]`, `notifications`, `layout.tsx` (nav + availability gate).
- Server actions: `actions.ts` (messages/social), `advanced-actions.ts` (10 Phase 5 actions), `voice-actions.ts` (count reconcile).

**21 components** (`src/components/community/`): shell/nav, home, chat (room-chat 1.7k LOC + composer + message-row + mention-text + presence), DM (dm-chat, dm-inbox), friends, notifications, profile-card, identity-dialog, members-panel, social-unavailable, settings, voice (use-voice 535 LOC + voice-panel), Phase 5 (search-view, question-create, question-detail, moderation-view, report-dialog).

**23 library modules** (`src/lib/community/`): rooms, social, relationship, identity, typing, presence, chime, notification-bus/kinds, social-pages, availability (kill-switch `COMMUNITY_COMING_SOON = false` → LIVE), Phase 5: search, qa, pins, reports, roles, moderation, reputation, events (strict broadcast parsers).

**21 API routes** (`/api/community/**`): messages CRUD + reactions, DM inbox/messages/reactions, friends + requests, members list/profile, blocks, badges, rooms, voice/token, Phase 5: search, questions (+answers), reports.

**Database**: 7 community migrations (`20261014` v1 → `20261031` v6) — ~30 tables, 4 SQL functions for voice (join/sync-count, security definer), `community_search` (full-text: `to_tsvector('simple')` stored columns + **GIN indexes** on messages/questions/answers + `websearch_to_tsquery`), role-hierarchy functions, RLS everywhere, 3 invariant indexes (single accepted, pin uniqueness, pending-report dedupe).

**Cross-cutting**: Postgres-backed fixed-window rate limiting (migration `20261002`, atomic, shared across instances, documented fail-open; all 30+ scopes incl. 9 Community Phase 5 scopes), security headers + strict CSP (build-time), `/api/health` probe, root error boundary, CI gate (`typecheck → lint → test → build`, Node 22, no secrets), `npm run check:env` deploy gate.

**Voice**: `livekit-client` dep; token minting (HS256 JWT, 10-min TTL, minimal grants, server-derived room name, identity = verified `auth.uid()`); aggregate-only participant count over Supabase broadcast `community-voice-<roomId>` (no identities, no polling, convergent-count SQL).

## 2. Phase 5 final state

All confirmed in the Phase 5 report + re-verified this session: Phases 1–5 green; **2872/2872 tests**; lint **0 errors / 0 warnings**; typecheck PASS; build PASS; 10 audits 9 PASS + 1 PASS-with-notes, zero FAILs; RLS protected; no polling / no new `setInterval` / no `dangerouslySetInnerHTML` / no service-role in client; DMs excluded from global search; Voice/LiveKit untouched; tree uncommitted.

## 3. Explicit Phase 6 requirements found

**None exist in the repository.** The only "Phase 6" references are the *Opportunities* system's completed application-prefill feature (`opportunity-prefill.ts`, migration `20260930`, README) — a different, finished workstream. No file defines, defers to, or plans a Community Phase 6. Per the discovery rule, the roadmap below is **evidence-derived** (deferred items + gaps found in this audit), not repo-mandated.

## 4. Deferred Phase 5 items

From `docs/community-phase5-final-report.md` §23 (all non-blocking, all still valid):
1. `app/layout.tsx` — 2 static bootstrap `<script dangerouslySetInnerHTML>` (theme/lang preload; non-Community, no user input).
2. `question-detail.tsx` user-image `<img>` — a `next/image` remotePatterns config would be a cross-cutting app change.
3. `room-chat` React-Compiler latest-value-ref pattern (prop-seeded initializer + declaration-before-first-use) — re-verify on any React/ESLint bump (covered by the 0-error lint gate).

## 5. Technical debt (existing + newly discovered)

| # | Item | Location | Severity |
|---|---|---|---|
| TD-1 | **GDPR account deletion does NOT sweep `community-images`** — `STORAGE_BUCKETS` = `ai-files`, `application-attachments`, `avatars` only. Room images (`{userId}/{msg}/…`), question images (`{userId}/{qid}/…`) and **DM images** (`dm/{conv}/{userId}/…` — not even user-prefixed) persist after "delete my account". DB rows cascade; files do not. | `src/lib/account-data.ts:41` | **HIGH** (compliance, German SaaS) |
| TD-2 | **GDPR data export inventory** omits `community-images` (same bucket list) — export is incomplete for community members. | `src/lib/account-data.ts:154` | MEDIUM |
| TD-3 | **Storage orphan janitor** (`/api/internal/storage-reconcile`) covers only `ai-files` + `application-attachments`; community delete paths clean up best-effort and log on failure — failed cleanups accumulate uncollected. | `src/lib/storage-reconcile.ts:53` | MEDIUM |
| TD-4 | Room/question image **read policy is any-authenticated** (not room-membership scoped) — a logged-in user who knows/guesses a URL can read another room's images. | v3 storage policies (non-`dm` select) | MEDIUM |
| TD-5 | No per-user **volume quota** on community image uploads (only 2MB/file + 10–30/min rate scopes) — bounded but unbounded total storage per user. | questions route / composer | MEDIUM |
| TD-6 | **Voice token cannot be revoked on suspension**: a suspended user already in a voice call keeps the SFU session for the token's life (ICE reconnect reuses the token; no LiveKit server-side removal call exists). | `voice-actions.ts`, moderation suspend action | MEDIUM |
| TD-7 | `check:env` external-seams report does **not** list the 3 `LIVEKIT_*` vars (added after the Phase 21/22 seams work) — an operator deploying without them gets silently voice-less Community with no gate warning. | `scripts/check-env.mjs` | LOW |
| TD-8 | Stuck voice conversation rows: a crashed participant (no `count=0`) leaves a stale `active` row until the next join self-heals it (convergent moves). No TTL sweep. | `community_voice_sync_count` (v5) | LOW |
| TD-9 | No `hide_question` / `delete_question` moderation action — a hateful/off-topic question can only be **closed** (title+body stay visible in lists and search). | `advanced-actions.ts`, `moderation.ts` | MEDIUM (product + abuse) |
| TD-10 | Community logging is `console.*` only (127 call sites) — no structured logs/leveling/correlation ids; app has no APM/telemetry dependency at all. | community libs/actions | MEDIUM (ops) |

**E (completed — do NOT repeat):** Phases 1–5 Community (all), app Phases 11–22 (GDPR core, rate limiting, CSP, worker durability, storage janitor core, env gate, health, error boundary), Opportunities "Phase 6" prefill, LiveKit token architecture.

## 6. Security findings (post-Phase 5)

| # | Finding | Class | Notes / evidence |
|---|---|---|---|
| S-1 | Community images survive GDPR account deletion (TD-1) | **HIGH** | `account-data.ts:41` bucket list; community FKs cascade but storage does not; DM images doubly uncovered (non-user prefix). |
| S-2 | Image read access not room-scoped (TD-4) | **MEDIUM** | v3 policy: `for select to authenticated using (bucket_id='community-images' and foldername[1] <> 'dm')` — any member, any room. DM images ARE membership-scoped (correct). |
| S-3 | No per-user upload volume quota (TD-5) | **MEDIUM** | Per-file 2MB + magic-byte validation + 10–30/min scopes; total volume unbounded within rate envelope. |
| S-4 | Voice session outlives suspension (TD-6) | **MEDIUM** | Write-gate blocks NEW joins; active SFU session not revoked (no LiveKit server API integration). |
| S-5 | Member-profile enumeration via `GET /members/:userId` | **LOW** | 404 vs 200 distinguishes known community UUIDs; UUID key space makes this impractical; payload already privacy-minimal (identity fields only, no email/plan — structural). |
| S-6 | Supabase broadcast transport is unauthenticated (voice count channel, room channels) | **INFO** | DB writes remain fully gated (RLS + security-definer SQL + rate limits); broadcasts carry display-only metadata (integer counts, validated pin ids). A client can spam display data but cannot mutate state. |
| S-7 | Rate limiting fail-open (documented design) | **INFO** | Limiter outage allows requests; every route keeps independent authn/authz + RLS. Intentional availability trade-off, documented in `rate-limit.ts`. |
| S-8 | CSRF | **INFO** | Cookie-based Supabase SSR auth + same-origin Next server actions/API; no cross-site token flows. Mitigated by design; no change proposed. |
| S-9 | LiveKit token security | **INFO (positive)** | Minimal grants (one server-derived room, audio publish/subscribe only — no data-publish, no video, no admin claims), 10-min TTL, random jti, identity = verified session uid, secret server-only, 503 when unconfigured. |
| S-10 | IDOR on reports/moderation/memberships | **INFO (positive)** | Report rows own-only (RLS + API scope), moderation/audit read-only for users, role changes admin-only with owner + escalation guards — all test-guarded (63 API/invariant tests). |
| S-11 | Service-role boundary | **INFO (positive)** | `@/lib/supabase/admin` imported only by `server-only` modules; zero client references (invariant-tested). |

No CRITICAL findings. No new XSS/privilege-escalation/RLS gaps found in this pass (Phase 5 invariants + v6 guards re-verified).

## 7. Performance findings

**Positive (verified):**
- Every community library query is bounded (`moderation` 11, `qa` 8, `rooms` 4, `social` 2, `pins`/`reports`/`roles` 1–2 `.limit()` calls; no unbounded `select` found).
- Search: single security-definer RPC, GIN-indexed `to_tsvector('simple')` + `websearch_to_tsquery`, keyset pagination only, 20/page cap, degraded-empty on failure.
- Room page + member profile route use `Promise.all` (no N+1); report/moderation name resolution batches via `in(...)` capped at 100.
- Realtime: zero polling, idempotent mirrors, no duplicate subscriptions; voice count reconciles only on change.

**Gaps (all minor):**
- P-1 (LOW): no runtime performance telemetry — query-cost assumptions (search fan-out across 3 tables per RPC) are unmeasured; fine at current scale, revisit at volume.
- P-2 (LOW): room image/question image reads are direct Supabase storage URLs (no CDN/optimization layer; `<img>` with `max-h` only). Acceptable; related to TD-2/next-image debt.
- P-3 (INFO): `community_search` recomputes blocklist/author joins per call — index-covered (`community_answers_author_idx` etc.); no change.

No N+1, no offset pagination, no oversized payloads, no missing indexes on hot paths were found. **PHASE 6E (Performance) has no P0/P1 work — recommend folding one optional task into 6F or skipping.**

## 8. Voice / LiveKit findings

**CODE COMPLETE (verified in source):**
- Token minting + join route (auth → rate limit → suspended/muted write-gate → config 503 → RLS room check → SQL-derived provider room → minimal 10-min token; no secrets or identities in responses).
- Aggregate participant count: convergent SQL (`≤ current` or `= current+1`), 0 ends conversation, 50 cap, no identities, broadcast-only propagation, no polling, self-healing on next join.
- Client: LiveKit-native ICE reconnect (Wi-Fi/sleep/background), UI state reconciliation on `Reconnected`, page-visibility handling, "voice unavailable" 503 UX, suspended users blocked at join.

**INFRASTRUCTURE / DEPLOYMENT REQUIRED (not code):**
- I-1: LiveKit cluster (cloud or self-hosted SFU) + `LIVEKIT_URL`/`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`.
- I-2: TURN server for mobile/NAT traversal (audio over WebRTC from phones behind CGNAT needs relay).
- I-3: Per-room participant limit on the cluster matching the code cap (50); LiveKit room TTL/empty-room cleanup settings.
- I-4: Monitoring: LiveKit dashboard/alerts (room count, bytes, reconnects); app side has no metrics today (TD-10).
- I-5: Decision: E2EE off (audio-only, membership-gated rooms; acceptable — document the choice).
- I-6: `check:env` seam entry for the 3 vars (TD-7) — small code change, operator-facing.

**CODE gaps tied to production (Phase 6D candidates):** S-4/TD-6 (suspend-mid-call revocation — needs a small LiveKit **server API** client: `room.participants.remove` or `room.delete`, called from the suspend action) and TD-8 (stale-row TTL sweep).

## 9. UX / product findings (evidence-based only)

- U-1 (MEDIUM): **No moderator hide/delete for questions** (TD-9) — closed questions remain visible in room list + search; no way to remove abusive Q&A content except deleting individual answers.
- U-2 (LOW): Question author cannot **edit** their own question (no edit route/action; body/title immutable after post). Answers can't be edited either (by design? no edit endpoint exists).
- U-3 (LOW): Search has no recent/saved searches; no "search within this room" shortcut from room nav.
- U-4 (LOW): Moderation queue has no reason/severity/status filters (single newest-first list, limit 50).
- U-5 (INFO): Report filers see status in My Reports (open/reviewing/resolved/rejected) — no notification when a report is resolved (acceptable).
- U-6 (INFO): Onboarding, empty states, loading skeletons, error recovery, 4-locale parity, RTL, mobile geometry — all present and test-covered; no gaps found beyond the above.
- U-7 (INFO): Voice unavailable-state is explicit and graceful (503 → "voice is not available yet").

## 10. Production readiness findings

**CODE (in-repo, shippable):**
- C-1: GDPR sweep/export gap for `community-images` (TD-1/TD-2) — the single most important code item for a German SaaS going to real users.
- C-2: Storage quota + janitor coverage (TD-3/TD-5).
- C-3: Image read policy scoping (TD-4) — additive storage-policy migration.
- C-4: Suspend → voice revocation (TD-6) — small LiveKit server-API integration (testable only with a cluster; code can land with an unconfigured-degradation path like the token route).
- C-5: `check:env` LiveKit seam (TD-7).
- C-6: Stale voice conversation sweep (TD-8) — SQL function + janitor hook.
- C-7: Moderator hide/delete question (TD-9/U-1).
- C-8: Logging strategy (TD-10) — at minimum: structured prefix + correlation id convention, or an APM dependency decision.
- C-9 (optional): question edit (U-2), saved searches (U-3), queue filters (U-4).

**INFRASTRUCTURE (out of repo):**
- I-1…I-5 (Voice cluster, TURN, room limits, monitoring, E2EE decision) — §8.
- I-6: Supabase storage plan/quota awareness; Postgres scaling (search volume).
- I-7: Backups = Supabase-managed PITR (documented assumption — no repo work).
- I-8: Migration safety: all community migrations are additive/idempotent (`drop policy if exists`, `create or replace`) — rollback = run-down or restore snapshot; no destructive community migrations exist.

## 11. Infrastructure requirements (consolidated)

| Requirement | Kind | Blocks |
|---|---|---|
| LiveKit cluster + 3 env vars | infra | voice feature live |
| TURN for mobile NAT | infra | mobile voice quality |
| Room participant limit = 50, empty-room TTL | infra config | voice ops |
| LiveKit monitoring/alerts | infra | voice ops |
| `check:env` LiveKit seam entry | code (tiny) | operator clarity |
| Storage quota/plan review (community-images) | infra + code | abuse resistance |
| APM/logging decision | infra + code | observability |
| Supabase backups (PITR) | infra (managed) | recovery |

## 12. Proposed Phase 6 roadmap

Only categories with evidence support: **6A, 6B, 6C, 6D, 6F** (6E Performance has no P0/P1 work — see §7; one optional item folded into 6F).

### PHASE 6A — Production Hardening (compliance + abuse)
| Task | Objective | Files likely affected | DB impact | API impact | Security impact | Testing | Risk | Deps | Migration? | Deploy config? |
|---|---|---|---|---|---|---|---|---|---|---|
| A-1 | Community images in GDPR **deletion** sweep (user-prefixed + `dm/{conv}/{userId}/` paths) | `src/lib/account-data.ts`, tests | none (admin storage ops) | none | **closes S-1 (HIGH)** | new deletion-sweep tests (mocked storage: both prefix shapes), full suite | LOW (additive bucket list) | none | **NO** | NO |
| A-2 | Community images in GDPR **export** inventory | `src/lib/account-data.ts`, `settings/data` UI (maybe) | none | none | closes TD-2 | export tests incl. community bucket | LOW | A-1 | NO | NO |
| A-3 | Per-user community image **volume quota** (e.g. 100MB/user, server-checked pre-upload, 413 `storage_quota`) | questions route, social.ts (message image path), `supabase/migrations/…_v7` (quota view/RPC) | additive RPC (aggregate `storage.objects` by user) | 413 code added | closes S-3 | quota tests (under/at/over), route 413, no-quota-failure mode (fail-open vs fail-closed decision) | MEDIUM (new migration, hot path) | A-1 (inventory knowledge) | **YES** (additive) | NO |
| A-4 | Storage janitor: add `community-images` bucket spec (orphan = no live row in messages/questions/answers/DM tables) | `src/lib/storage-reconcile.ts`, tests | none | internal endpoint only | closes TD-3 | reconcile tests (dry-run + execute, orphan detection per prefix shape) | MEDIUM (false-positive deletion is catastrophic — require row-reference proof + dry-run default) | A-1 | NO | janitor cadence (ops) |

### PHASE 6B — Security Hardening
| Task | Objective | Files | DB | API | Security | Testing | Risk | Deps | Migration? | Deploy? |
|---|---|---|---|---|---|---|---|---|---|---|
| B-1 | Image read policy scoped to **room membership** (room + question images; DM policy unchanged) | new migration (drop/recreate storage policy with membership subquery) | **YES** (additive policy swap) | none | closes S-2 | migration-guard tests (policy text), behavior tests (member vs non-member read) | MEDIUM (RLS on storage — a bad subquery could break ALL image reads → feature regression) | none | YES | NO |
| B-2 | Suspend/reinstate → **LiveKit server-side revocation** (remove participant / delete room via API key+secret, best-effort, logged; no-op when unconfigured) | `src/lib/voice/livekit-api.ts` (new), suspend action, `voice-actions.ts` | none | none | closes S-4 | mocked LiveKit API tests (URL, auth header, room name derivation, failure→log-no-throw, unconfigured→no-op) | MEDIUM (new external call in a moderation path — must never block/throw the sanction) | LiveKit cluster for manual E2E (code lands testable without it) | NO | YES (same 3 vars) |

### PHASE 6C — Reliability / Observability
| Task | Objective | Files | DB | API | Security | Testing | Risk | Deps | Migration? | Deploy? |
|---|---|---|---|---|---|---|---|---|---|---|
| C-1 | `check:env` LiveKit seam entry (flag the 3 vars in the external-seams report) | `scripts/check-env.mjs`, tests | none | none | operator clarity (TD-7) | check-env tests (names-only, status matrix) | LOW | none | NO | NO |
| C-2 | Stale voice conversation **TTL sweep** (mark `ended` when `updated_at` older than e.g. 15 min and count unchanged — via RPC or janitor tick) | `supabase/migrations/…_v7`, janitor or room-page read path | YES (additive function) | none | none (display data) | convergence tests (fresh vs stale), no-join self-heal preserved | LOW | none | NO | NO |
| C-3 | Community **logging convention**: structured `[community] <area>` prefix + level discipline + optional correlation id on moderation/report flows (no new dependency unless APM is chosen as a separate decision) | community libs/actions (touch 127 sites minimally — convention + hot-path upgrades only) | none | none | none | existing suites + spot checks | LOW | none | NO | NO |
| C-4 (decision, may be non-code) | APM/telemetry choice (Sentry/other vs console+logs) — **document decision** before writing code | `package.json`, config | — | — | secrets hygiene if configured | CI stays secret-free | LOW | infra budget | NO | maybe |

### PHASE 6D — Voice Production Readiness
| Task | Objective | Files | DB | API | Security | Testing | Risk | Deps | Migration? | Deploy? |
|---|---|---|---|---|---|---|---|---|---|---|
| D-1 | **Provisioning runbook** (cluster, keys, TURN, room limit 50, empty-room TTL, monitoring/alerts, E2EE-off rationale) | `docs/community-voice-runbook.md` (new doc) | none | none | secret handling documented | n/a (doc) | LOW | cluster access | NO | **YES (core)** |
| D-2 | B-2 integration verification E2E (join → suspend mid-call → evicted; mobile reconnect via TURN) | manual test plan in runbook | none | none | closes S-4 end-to-end | scripted manual pass | LOW | D-1, B-2 | NO | YES |

### PHASE 6E — Performance Optimization
**Not proposed** — §7 found no P0/P1 performance gap. Optional low-priority items (image CDN/next-image remotePatterns = deferred TD-2; search telemetry = P-1) stay parked unless production data says otherwise.

### PHASE 6F — Final UX Polish
| Task | Objective | Files | DB | API | Security | Testing | Risk | Deps | Migration? | Deploy? |
|---|---|---|---|---|---|---|---|---|---|---|
| F-1 | **Moderator hide/delete question** (action + lib + queue button + audit row `hide_question`/`delete_question`; delete also removes question image storage, reusing A-1 path knowledge) | `advanced-actions.ts`, `qa.ts`, `moderation.ts` (action enum), moderation-view, i18n ×4, tests | **YES** (action whitelist CHECK + optional `hidden` column or reuse close) | none | closes U-1/TD-9 (abuse content removal) | action tests (roles, audit, storage cleanup), i18n parity re-run | MEDIUM (touches QA state machine + invariants) | A-1 (cleanup pattern) | YES |
| F-2 | Moderation queue **filters** (status/reason) server-side, bounded | `moderation.ts`, `GET /api/community/reports`? (no — separate queue lib) + moderation-view | none | queue read only | none | filter tests | LOW | F-1 (same surface) | NO | NO |
| F-3 (optional) | Question **edit** (author, open+unsolved only, no tag/room change, audit-free, rate `community_question`) | questions route PATCH, qa.ts, question-detail | none | new PATCH | IDOR-safe (author-only RLS update policy exists pattern) | edit tests (author/non-author/closed) | MEDIUM (new mutation surface) | F-1 decision (keep or cut) | NO | NO |
| F-4 (optional) | Recent searches (localStorage, bounded, client-only) | search-view | none | none | none | client tests | LOW | none | NO | NO |

## 13. Priority ranking

1. **A-1 + A-2** — GDPR deletion/export for community images (S-1 HIGH; compliance blocker for real German users).
2. **B-2** — voice revocation on suspension (S-4; security + trust).
3. **B-1** — room-scoped image reads (S-2).
4. **A-3** — upload volume quota (S-3; abuse resistance before scale).
5. **A-4** — janitor coverage (TD-3; pairs with A-1/A-3).
6. **C-1** — check:env LiveKit seam (trivial, operator clarity).
7. **F-1** — moderator hide/delete question (U-1; moderation completeness before heavy use).
8. **C-2** — stale voice sweep (TD-8; cosmetic reliability).
9. **C-3** — logging convention (TD-10).
10. **D-1/D-2** — voice runbook + E2E (INFRA-gated; can be ordered any time cluster exists).
11. **F-2 / F-3 / F-4 / C-4** — optional polish/decisions.
12. **6E** — none (parked).

## 14. Dependencies

- A-2 → A-1 (bucket knowledge); A-4 → A-1 (path shapes).
- B-2 → LiveKit cluster for E2E only (unit-testable without it).
- F-1 → A-1 (image cleanup pattern); F-2 → F-1 (same surface); F-3 independent but decided alongside F-1.
- C-2 independent. C-1 independent. D-1/D-2 → infra provisioning (external).
- Migrations: A-3, B-1, C-2, F-1 each need their own additive migration — recommend **ONE consolidated v7 migration** (`community_v7_production`) containing all four (quota RPC, storage policy swap, voice TTL fn, question action CHECK) to keep migration order simple. **Decision point at 6A kickoff.**

## 15. Risk assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A-4 janitor false-positive deletes live images | LOW (design: row-reference proof required) | **HIGH** (user content loss) | dry-run default, two independent row checks, path-prefix guard, test with adversarial fixtures; ship execute:false default |
| B-1 storage policy swap breaks all image rendering | MEDIUM (subquery error) | HIGH (feature-wide) | keep old policy until new verified in migration order (drop+create is atomic enough per policy; feature-test before/after; rollback = recreate old policy) |
| B-2 LiveKit API call blocks/fails a moderation action | MEDIUM | MEDIUM | best-effort, timeout, log-no-throw, no-op when unconfigured (mirrors token route degradation) |
| A-3 quota on hot upload path adds latency | LOW | LOW | single aggregate RPC, 100MB threshold rarely hit, fail-closed with clear 413 |
| 2872-baseline regression from any change | LOW | MEDIUM | full gate after EVERY sub-phase (typecheck/lint/test/build), no test deletions, additive-only where possible |
| Voice infra slips (external) | MEDIUM | LOW (feature degrades gracefully to 503 UX) | D-1 is a doc; nothing in app code blocks on it |

## 16. Testing strategy

- **Per task**: new unit/integration tests in the existing vitest pattern (scripted Supabase mocks recording every DB op; real route handlers; source-scan invariants) — same style as `tests/community-phase5-api.test.ts`.
- **Per sub-phase (6A…6F)**: full gate sequence `typecheck → lint → test → build` in that order; **2872 baseline must be preserved or increased** (no deletions/weakening — the Phase 5 non-regression rule applies to Phase 6).
- **Migration-guard tests**: every v7 statement gets a source-scan assertion (policy text, CHECK whitelist extension, function existence, grants), mirroring the Phase 5 v6 guards.
- **i18n**: full-subtree 4-locale parity re-run after any 6F string addition (479-key suite).
- **Invariants**: existing no-polling / no-timer / no-XSS / no-service-role-in-client / DM-exclusion suites must stay green and are extended to new files (e.g., `livekit-api.ts` must be `server-only`).
- **E2E (manual, infra-gated)**: D-2 voice suspend-eviction pass once a cluster exists.

## 17. Non-regression requirements

Unless a Phase 6 task **explicitly requires** it (only A-3, B-1, C-2, F-1 touch schema/policies — all additive), the following remain unchanged:
- Phase 1 chat/rooms/identity · Phase 2 social (DMs/friends/notifications) · Phase 3 deep links/realtime · Phase 4 voice architecture (token grants, count model, no-poll invariants) · Phase 5 search/Q&A/reports/pins/moderation/reputation/i18n.
- **DM exclusion from global search** (migration-guarded) · **RLS** (all 7 v6 tables + v1–v5) · **server-side authorization** (3-layer: session actor → role re-resolve → lib re-check → RLS).
- Baseline **2872 tests**; Phase 6 may only add tests.
- LiveKit/Voice client code frozen except B-2's additive `livekit-api.ts` + suspend hook.
- No git operations by the assistant; tree stays uncommitted per project convention.

## 18. Recommended implementation order

1. **6A kickoff → consolidated v7 migration design** (decision: single v7 with A-3+C-2+F-1 DB parts, B-1 storage policies).
2. **A-1 → A-2** (GDPR sweep + export; independent of v7; highest priority, lowest risk).
3. **B-1** (storage policy swap in v7) + feature tests.
4. **A-3** (quota RPC in v7 + route integration).
5. **A-4** (janitor bucket spec — after A-1/A-3 path shapes are stable).
6. **B-2** (LiveKit API client + suspend hook; cluster-E2E deferred).
7. **C-1** (check:env seam — one-day task, ship early).
8. **F-1 → F-2** (question hide/delete + queue filters; v7 CHECK part).
9. **C-2** (voice TTL sweep; v7 fn part) — can slide before 8 if v7 is already open.
10. **C-3** (logging convention) as a thin sweep across 6A–6F touch points (avoid a standalone 127-site rewrite).
11. **D-1** runbook (any time; before first real cluster), **D-2** E2E (after cluster).
12. **C-4 / F-3 / F-4** — decision-gated, last.
13. **Full gate + Phase 6 final report** (mirror of the Phase 5 24-section report) — 2872+ tests.

---

### Final declaration

Discovery complete: architecture mapped, repo searched (no explicit Community Phase 6 mandate exists — roadmap is evidence-derived), security (1 HIGH, 4 MEDIUM, 1 LOW, 5 INFO), performance (no P0/P1), Voice (code complete; infra required), UX (7 evidence-based items), production readiness (code vs infra separated), 5 sub-phases proposed with per-task impact/dependency/risk detail, and a 2872-test non-regression contract established.

**PHASE 6 DISCOVERY COMPLETE — IMPLEMENTATION NOT STARTED**
