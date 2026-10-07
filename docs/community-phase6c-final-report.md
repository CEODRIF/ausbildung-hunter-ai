# Community Phase 6C — Reliability & Observability: Final Report

**Project:** AusbildungsWeg (`ausbildung-hunter-ai`)
**Phase:** Community 6C (per `docs/community-phase6-discovery-report.md`)
**Date:** 2026-10-07
**Status:** **PHASE 6C COMPLETE — UNCOMMITTED**

---

## 1. Scope

Phase 6C implemented exactly the four discovery items C-1…C-4. No 6D
(infrastructure/E2E), no 6F (question moderation), no B-1 policy changes,
no LiveKit token redesign, no unrelated refactors.

| Item | Description | Status |
|---|---|---|
| C-1 | LiveKit environment validation seam (extended `check:env`) | ✅ implemented |
| C-2 | Stale voice-session TTL sweep (v9 RPC + `/api/internal/voice-sweep` seam) | ✅ implemented (6D attaches the poller) |
| C-3 | Structured logging convention for critical voice events | ✅ implemented |
| C-4 | APM decision (documentation only) | ✅ decided: deferred (§5) |

**Files changed:**

- MOD `scripts/check-env.mjs` (C-1: production mode, `wsUrl` kind, 3
  LiveKit checks, `livekit-voice` seam, poller note)
- NEW `src/lib/community/log.ts` (C-3: server-only structured event logger)
- NEW `supabase/migrations/20261103000000_community_v9_voice_stale_sweep.sql` (C-2)
- NEW `src/app/api/internal/voice-sweep/route.ts` (C-2: worker-boundary seam)
- MOD `src/app/api/community/voice/token/route.ts` (C-3 events)
- MOD `src/app/community/voice-actions.ts` (C-3 event)
- MOD `tests/check-env.test.ts` (C-1: GOOD_ENV extended + 8 new tests;
  1 assertion strengthened)
- NEW `tests/community-phase6c.test.ts` (25 tests: v9 guards, sweep route,
  logging)

Phase 6A (2912) and Phase 6B (2960) test suites remain **untouched and
green**; the only pre-existing file modified is `tests/check-env.test.ts`
(extended, never weakened — see §12).

## 2. C-1 — Environment Validation

The repository already has an environment-validation framework
(`npm run check:env` → `scripts/check-env.mjs`, pure unit-tested
`validateEnv`, names+statuses only, per the Phase 20 convention). **It was
extended, not paralleled:**

- **Three new checks:** `LIVEKIT_URL` (new `wsUrl` kind: valid URL
  required; `wss://`/`https://` expected, non-TLS `ws://`/`http://` warns
  "dev only"), `LIVEKIT_API_KEY` (id), `LIVEKIT_API_SECRET` (secret —
  short-value warning like all other secrets).
- **Production vs dev/test distinction:** `required: "production"` — in
  production mode (`validateEnv(env, { production: true })`; the CLI,
  which is the PRE-DEPLOY check, always runs in production mode) a missing
  LiveKit var is a **fail** ("missing (required in production)") that
  gates the exit code; in dev/test mode (default) it is **pass**
  ("not set (optional)") — LiveKit may intentionally be absent and voice
  degrades around it (503 + eviction no-op, Phase 6B).
- **`livekit-voice` external seam** (informational, existing pattern):
  `configured` only when all three vars are set (placeholders excluded by
  the existing `isSet` logic); the poller seam note now lists
  `/api/internal/voice-sweep`.
- **Secret hygiene:** the report emits names, statuses, and static
  messages only — the existing guarantee, now extended by tests that
  assert none of the three LiveKit values appears anywhere in the API
  result or the CLI stdout.
- `.env.example` already documents the three vars (Phase 4) — unchanged.

## 3. C-2 — Stale Voice-Session Cleanup (TTL)

**Architecture facts (inspected, not assumed):** `community_voice_conversations`
rows are **durable badge state only** — the SFU is the authority on
participants; there is no participants table. `updated_at` is refreshed by
`community_voice_join` and every convergent `community_voice_sync_count`
(client-driven on join/leave changes — no heartbeats by design). Rows are
never deleted (`ended` stays as history); at most one `active` row per
room (partial unique index). The schema already provided everything C-2
needs — the sweep is one additive RPC, no new columns.

**The v9 migration** (`20261103000000_community_v9_voice_stale_sweep.sql`)
creates exactly one function, `community_voice_sweep_stale(p_stale_minutes
default 15, p_max default 25) returns integer`:

- **Explicit staleness criterion:** `status = 'active' AND updated_at <
  now() - p_stale_minutes` (threshold clamped `greatest(…, 1)` — the SQL
  itself can never express "sweep everything fresh").
- **Bounded:** oldest first (`order by updated_at asc`), `limit
  least(greatest(p_max, 1), 100)`.
- **Idempotent by predicate:** the sweep sets `status = 'ended'`, which
  the WHERE clause requires to be `'active'` — a re-run matches nothing.
- **Converge-only:** sets `status`/`updated_at` and nothing else — no
  `DELETE`, no `participant_count` change, no room/provider reference
  change, no join to any other table (guard-tested), so no cross-room
  modification is expressible.
- **Fail-closed on malformed records:** any non-`active` status or
  missing timestamp simply does not match.
- **No LiveKit claim:** the function never talks to the SFU. Ending a DB
  record does not remove SFU participants. The documented worst case — a
  *quiet-but-live* room (no join/leave events for 15+ minutes; possible,
  since count sync is event-driven) whose badge flips to `ended` — is
  cosmetic (the aggregate is cosmetic by Phase 4 design) and
  **self-heals on the next join** (`community_voice_join` inserts a fresh
  `active` row). Conversely, a *dead* room (all peers gone, no one left
  to sync) is exactly the record this converges — the SFU drops dead
  WebRTC peers within ~15–30 s, so a real room that still had a live
  participant would have refreshed the row.
- **Secured per project convention** (Phase 4 v5 + Phase 6A v7):
  `security definer`, `set search_path = public`, execute **revoked from
  public/anon, granted to service_role only**.

**The invocation seam** — `POST /api/internal/voice-sweep`:

- Same trust boundary as `/api/internal/storage-reconcile` and
  `/api/internal/email-worker`: the `x-email-worker-secret` header
  (worker == service-level trust) verified **before** any body use,
  fail-closed when the secret is unconfigured (satisfies the existing
  `tests/security/authorization.test.ts` internal-route audit).
- Strict body (`{ staleMinutes?: 1..1440, maxSwept?: 1..100 }`, both
  optional, `strict()` — unknown keys like `execute`/`room` are
  rejected); server clamps; empty JSON object = defaults.
- Calls the RPC via the **service-role** admin client; returns exactly
  `{ swept, staleMinutes, maxSwept }` — an honest DB-record count, **no
  room/participant/eviction claims**; an unknown RPC data shape is
  reported as `swept: 0`; RPC failure → 500 + `community.voice.unavailable`.
- **Nothing schedules it in-repo** (no cron framework built) and no
  client path can reach it — Phase 6D attaches the durable poller once
  real LiveKit infrastructure exists.

## 4. C-3 — Structured Logging

New server-only helper `src/lib/community/log.ts` (deliberately tiny —
the repository has no logger dependency; the existing convention is
`[community] …` console lines, which this formalizes for the voice hot
paths):

- **Stable event catalog** (`community.voice.*`): `join`, `token_issued`,
  `join_denied`, `leave_sync`, `cleanup`, `eviction`, `unavailable`.
- **One machine-parseable line per event:**
  `[community] <event> key=value …` — level discipline: `info` normal
  operation, `warn` denied/degraded, `error` hard failure.
- **Leak-proof by construction:** fields are scalar-typed
  (`string|number|boolean`); any string > 120 chars is truncated to
  12 chars + `…(len=N)` — a mistaken `token=<jwt>` or `url=<signed-url>`
  field can never be emitted in full; newlines/tabs are flattened
  (one event = one line, log-injection safe).
- **Wired hot paths (minimal touch, 14 call sites):**
  - token route: `join` (attempt, userId+roomId), `token_issued`
    (userId/roomId/room/participantCount/ttlSeconds — **never the token
    or SFU URL**), `join_denied` with a stable `reason` for every
    rejection branch (unauthenticated, invalid_room, rate_limited,
    suspended/muted via gate code, voice_unavailable, room_not_found,
    join_failed),
  - count sync: `leave_sync` (userId/roomId/count/result[+detail]),
  - sweep route: `cleanup` (swept/staleMinutes/maxSwept) and
    `unavailable` on RPC failure.
- **Phase 6B eviction lines in `moderation.ts` are intentionally
  untouched** — their exact strings are part of the 6B test contract;
  they already follow the `[community]` convention, and the catalog
  includes `eviction`/`unavailable` for future unification.

## 5. C-4 — APM Decision (documented, no code)

**Decision: no APM/telemetry vendor is installed or integrated in Phase
6C.** Rationale:

1. The structured console events of C-3 plus the existing
   `check:env`/worker-seam model are **sufficient for launch preparation**
   — the application emits stable, machine-parseable lines for every
   critical voice/community reliability and security event.
2. APM is **deferred until actual production traffic and
   observability needs justify it** (a vendor adds cost, a data-flow
   decision for German GDPR, and config surface before the product has
   real users; the decision should be re-taken in 6D with traffic data).
3. **LiveKit infrastructure monitoring** (SFU health, room metrics,
   participant telemetry) will be handled **separately in Phase 6D** as
   part of cluster provisioning — it is an infrastructure concern, not an
   application-APM one.
4. No dependency was added (`package.json` unchanged).

## 6. Migration(s)

Exactly one: `supabase/migrations/20261103000000_community_v9_voice_stale_sweep.sql`
— additive, single `create or replace function` + the two conventional
grant statements. No tables, columns, indexes, policies, data statements;
no B-1/storage content; no 6A quota/GDPR surface; no 6D/6F content.
Rollback documented (single `drop function`). 5 guard tests pin the
executable SQL (criteria, bounds, converge-only, single-table, security,
scope exclusion).

## 7. Security Audit (focused, Phase 6C)

Performed against final source; every item **PASS**:

| # | Check | Result |
|---|---|---|
| 1 | All LiveKit admin calls | PASS — still exactly one module (`src/lib/voice/livekit-api.ts`, server-only, 6B); C-2's RPC talks only to Postgres; no new admin surface |
| 2 | All voice cleanup paths | PASS — `community_voice_sweep_stale` referenced by exactly the v9 migration, the internal seam route, and tests; the seam requires the worker secret before body use (existing authorization audit now covers it and passes); RPC is service-role-only; converge-only SQL cannot delete or cross rooms |
| 3 | All environment diagnostics | PASS — `check:env` prints names/statuses/static messages only; tests assert none of the three LiveKit values appears in the API result or CLI stdout; dev mode does not fail without LiveKit |
| 4 | All new logging calls (14 sites) | PASS — fields are scalar metadata only (userId/roomId/room/count/ttl/reason/result/detail/swept); no tokens, no SFU URL in `token_issued`, no message/image contents; truncation + newline flattening guard the rest; `log.ts` is `server-only` |
| 5 | Sensitive-data leakage | PASS — full-console capture tests: a complete token-issuance + denial flow emits no `LIVEKIT_API_SECRET`, no API key, no JWT fragment (`eyJ`), no signed-URL chunk; 6B "never contains the server secret" tests still green |
| 6 | 6A/6B guarantees preserved | PASS — v8 storage policies byte-identical (untouched), GDPR/quota/janitor suites green, suspended users still 403 at the token route (6B test green), eviction still server-authorized with server-derived identity (6B tests green) |

## 8. Tests

| Suite | Tests | Result |
|---|---|---|
| NEW `tests/community-phase6c.test.ts` | 25 | 25/25 ✅ |
| MOD `tests/check-env.test.ts` (extended; 1 assertion strengthened) | 28 (was 20) | 28/28 ✅ |
| **Full suite (`npm test`)** | **2993** | **2993/2993 ✅ (128 files, 0 failures)** |

Spec-scenario mapping:

- **C-1:** (1) prod missing URL → fail+named ✅ (2) missing key ✅
  (3) missing secret ✅ (4) configured prod passes + seam configured ✅
  (5) secrets never in output (API + CLI) ✅ (6) dev/test absent →
  pass/optional + seam pending ✅ — plus malformed-URL fail,
  non-TLS ws:// warn, placeholder fail+seam-pending.
- **C-2:** (7) stale record qualifies per explicit criteria (SQL guard +
  route forwards threshold/budget, honest count) ✅ (8) fresh/active
  survive (min-1-minute floor, no bypass flag, `staleMinutes: 0` → 400)
  ✅ (9) idempotent + re-run → 0 ✅ (10) bounded (clamps; out-of-range →
  400) ✅ (11) no cross-room modification (two scalars only; `room`
  selector rejected) ✅ (12) unauthorized client cannot trigger (401
  ×3, RPC never reached; only importer is the internal route) ✅
  (13) malformed fails closed (invalid JSON / non-integer / unknown
  keys → 400) ✅ (14) no LiveKit state claimed (exact response keys;
  log has no participant/room/eviction language; RPC error → 500 +
  `unavailable`; unknown shape → `swept: 0`) ✅.
- **C-3:** (15) stable catalog exact + route emits `join`/`token_issued`/
  `join_denied` (suspended, unconfigured) with stable names/fields ✅
  (16) no secret/key/token ever emitted (full capture incl. JWT-fragment
  check) ✅ (17) signed URLs truncated, never full ✅ (18) long
  contents truncated, newlines flattened (one line per event) ✅
  (19) eviction honesty preserved (6B contract intact) ✅ (20)
  unavailable states represented honestly (event + ERROR level +
  detail) ✅.

## 9. Typecheck

`npm run typecheck` (`tsc --noEmit`) — **PASS, exit 0, 0 errors**.

## 10. Lint

`npx eslint .` — **PASS, exit 0, 0 errors, 0 warnings**.

## 11. Build

`npm run build` — **PASS, exit 0** ("✓ Compiled successfully"; the new
`/api/internal/voice-sweep` route appears in the route table).

## 12. Non-regression

- **Baseline:** Phase 6B closed at **2960** tests.
- **Phase 6C:** full suite = **2993** → baseline **preserved and
  increased by exactly the 33 new tests** (25 new file + 8 new
  check-env tests); 0 failures.
- **No existing assertion was weakened.** The only pre-existing test file
  modified is `tests/check-env.test.ts`: `GOOD_ENV` gained the three
  LiveKit vars (required for the CLI's production mode to represent a
  *valid* production environment — the existing "fully configured
  production" and CLI exit-0 tests now model reality), and the
  "never prints secret values" test gained two value-absence assertions
  (strengthened). All 20 pre-existing tests still assert exactly what
  they asserted before and still pass.
- Phase 6A suites (40) and Phase 6B suites (48) untouched and green; the
  pre-existing `tests/security/authorization.test.ts` internal-route
  audit now **covers the new seam and passes** (secret verified before
  body use, fail-closed when unconfigured).

## 13. Remaining Infrastructure Requirements

(No changes since 6B — Phase 6D owns them; nothing in 6C was
infrastructure-dependent.)

1. **LiveKit cluster** (`LIVEKIT_URL`/`LIVEKIT_API_KEY`/
   `LIVEKIT_API_SECRET`) — now **enforced by `check:env` in production
   mode** (C-1) and reported by the `livekit-voice` seam. Until
   provisioned: voice degrades to 503, eviction is a no-op, and the
   sweep only converges DB badge records (harmless, safe, and actually
   useful: it cleans badge state regardless of SFU).
2. **Durable poller** — Phase 6D attaches it to
   `/api/internal/voice-sweep` (default: `staleMinutes: 15`,
   `maxSwept: 25`; every 5–15 minutes is sensible).
3. **D-2 E2E pass** on the provisioned cluster (join → suspend →
   evicted; join-token format verification per the 6B report §14.1).

## 14. Known Limitations

1. **Quiet-but-live rooms can have their badge flipped** by the sweep
   (no join/leave events for > threshold while participants stay
   connected): cosmetic only (the aggregate is cosmetic by design; media
   is unaffected; LiveKit is never touched; the next join self-heals with
   a fresh `active` row). The 15-minute default sits well above the SFU's
   ~15–30 s dead-peer drop window, so *stale* rooms converge quickly
   while *live* rooms almost always have an event within the window.
2. **The sweep is a DB-only convergence** — it is explicitly NOT a
   "room is empty" assertion (response and logs say so); 6D's poller
   should treat `swept` as a housekeeping counter.
3. **Log truncation at 120 chars** may cut long (legitimate) detail
   values — intentional: detail fields carry error messages, never
   payload; the `…(len=N)` marker preserves the original length.
4. **`check:env` dev-mode default**: pure `validateEnv(env)` callers
   (tests, future tooling) run in dev mode by design; only the CLI is
   production-mode. A tool that wants production semantics must pass
   `{ production: true }` explicitly.
5. **No in-repo scheduler** (by requirement): the sweep runs only when
   the 6D poller drives it — until then stale badge rows simply persist
   (same as today).

## 15. Explicitly Deferred Work

- **Phase 6D — NOT implemented:** no infrastructure provisioning, no
  LiveKit cluster, no poller wiring, no E2E (D-1/D-2), no runbook doc.
- **No LiveKit cluster was provisioned; no production LiveKit E2E was
  performed.**
- **Phase 6F — NOT implemented:** no question moderation (F-1…F-3), no
  question status/CHECK changes.
- **Phase 6A remains COMPLETE** (GDPR deletion/export, 100 MB quota,
  janitor — all suites green, files untouched).
- **Phase 6B remains COMPLETE** (v8 room-scoped read policies; suspend →
  eviction seam — all suites green; the 6B log contract in
  `moderation.ts` intentionally preserved).
- **No APM vendor** (decision in §5), no token-system redesign (the 6B
  report §14.1 join-token format note stands for the D-2 verification),
  no B-1 storage policy changes.
- **No Git operations were performed** — no commit, push, reset,
  checkout, stash, clean, or branch change; Phases 6A+6B+6C remain
  uncommitted in the working tree.

---

## Final Declarations

1. **Phase 6C is COMPLETE** — C-1 (check:env LiveKit seam, production
   mode), C-2 (v9 sweep RPC + `/api/internal/voice-sweep` seam), C-3
   (`community.voice.*` structured events on the voice hot paths), C-4
   (APM deferred, documented).
2. **Gates:** `npm test` ✅ **2993/2993** (2960 baseline + 33 new) ·
   typecheck ✅ exit 0 · lint ✅ exit 0 · build ✅ exit 0.
3. **Security audit:** 6/6 PASS (§7) — no new LiveKit admin surface,
   cleanup worker-boundary-only, diagnostics names-only, logging
   leak-proof, 6A/6B guarantees intact.
4. **Phase 6D/6F NOT implemented. NO GIT OPERATIONS PERFORMED.**
