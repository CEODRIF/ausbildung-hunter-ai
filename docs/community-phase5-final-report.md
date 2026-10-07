# Community Phase 5 — Final Report

Date: 2026-10-07 · Scope: global search, Q&A, reports, pins, moderation, roles, reputation — full-stack, 4 locales.
Gates (this session, exact): typecheck ✅ · lint **0 errors / 0 warnings** ✅ · tests **2872/2872** ✅ · build ✅. Working tree intentionally **uncommitted**.

---

## 1. Executive status

**PHASE 5 COMPLETE — UNCOMMITTED.** All STEP 1–9 work is done and verified: implementation, 112 new tests (49 backend + 63 API/invariants), the four gates green, the full source audit, and the ten final audits (9 PASS + 1 WARNING, no FAILs). No Phase 6 work was started. No Git command was executed. LiveKit/Voice untouched.

## 2. Phase 5 implementation summary

- **Migration** `supabase/migrations/20261031000000_community_v6_advanced.sql`: 7 new tables (`community_memberships`, `community_questions`, `community_answers`, `community_pins`, `community_reports`, `community_moderation_actions`, `community_reputation_events`), `community_search` SQL function, role-hierarchy functions, policies, bounded indexes.
- **Server libraries** (`src/lib/community/`): `qa.ts`, `pins.ts`, `reports.ts`, `roles.ts`, `moderation.ts`, `reputation.ts`, `search.ts`, `events.ts` (strict broadcast parsers).
- **API routes**: `GET /api/community/search`, `POST /api/community/questions`, `POST /api/community/questions/:id/answers`, `POST|GET /api/community/reports`.
- **Server actions** (`src/app/community/advanced-actions.ts`): pin/unpin, report status/assign, moderation actions, member roles, room settings, accept/unsolve/close-reopen.
- **Pages**: `/community/search`, `/community/questions/new`, `/community/questions/[id]`, `/community/[room]/questions`, `/community/moderation` (all server components, server-guarded).
- **Components**: `search-view`, `question-create`, `question-detail`, `moderation-view`, `report-dialog`; integrated pin + report affordances into `room-chat`, reputation stats into `profile-card`, My Reports into `community-settings`.

## 3. Global Search

- One bounded SQL function `community_search(uuid p_user, text p_query, text p_kind, uuid p_room, uuid p_author, timestamptz p_since, timestamptz p_before_at, uuid p_before_id, integer p_limit)` — **keyset pagination only** (`created_at DESC, id DESC` cursor), 20/page, no offset.
- **Identity from the session**: `p_user` must equal `auth.uid()` (SQL exception otherwise); the route passes the session user, never a client value.
- Filters: kind (message/question/answer/user/room/all), room slug resolved **server-side** (unknown → 400 `room_not_found`), author, date window (all/week/month/year → `p_since`), cursor.
- **DMs excluded by construction** — the function body references no DM table (guarded by a migration-scan test).
- Answer rows carry `questionId` → deep link `/community/questions/{qid}#answer-{aid}`; question rows → `/community/questions/{qid}`.
- First page rendered server-side (one RPC); later interactions via the authenticated API route; degraded to empty + `unavailable` on error (500 `search_failed`).
- The `since` computation for the server page lives in the data layer (`sinceForDate` in `search.ts`) — never during render (lint-clean).

## 4. Q&A

- Question author = session user (server-stamped); room must exist + `qna_enabled`.
- Answers: 10–4000 chars, question must exist and not be closed; notification to the **question author with full refs** (`questionId`, `answerId`, `roomId`, send-keyed, never self).
- **Accept**: question author or moderator+ (checked against DB rows, not client claims); accepting closes a previous acceptance atomically; **DB-level invariant: exactly one accepted answer** (`community_answers_question_accepted_uq`, partial unique on `accepted = true`).
- **Self-award structurally impossible**: reputation is NEVER awarded when `answer.author_id === question.author_id`, regardless of who accepted.
- Reputation on accept: +10 answer author, +2 question author (fixed points); **idempotent** via `(actor, target, type)` unique + conflict-no-op (guarded by tests).
- Close/reopen: moderator+ only; closing clears `accepted_answer_id` + unaccepts all rows. Unsolve: author or moderator+.
- Deep link: every answer row has `id="answer-{id}"`; `#answer-{id}` scrolls + focuses (keyboard accessible) on mount.

## 5. Question creation / detail / list

- Create: multipart form (title 10–120, body 30–4000, ≤5 tags ≤24 chars, optional image ≤2MB validated on **real bytes** — PNG/JPEG/GIF/WebP magic + size; spoofed bytes → 415, oversized → 413); image path `{userId}/{questionId}/image.png` (owner-scoped, server-generated).
- Detail: answers in `created_at ASC`, accepted pinned + ring-highlighted; answer composer with report affordance per answer; accept/unsolve/close controls gated by SERVER-computed capabilities (no client role claim).
- List (`/[room]/questions`): server-fetched page for the room, status filter, link to create.

## 6. Reports

- **Exactly 9 reasons** (spam, harassment, hate, scam, misinformation, sexual_content, illegal_content, impersonation, other) — whitelisted in client, server lib AND DB CHECK.
- **Targets: message / question / answer / profile only** — DB CHECK has no `'dm'`; API + lib reject anything else (400).
- Filing: authenticated + not suspended/muted (write gate); target must exist (admin read); **self-report → 403**; duplicate pending report → 409 via **partial unique index** `(reporter_id, target_type, target_id) WHERE status IN ('open','reviewing')` (23505 → `already_reported`).
- Reporter is always the session user (client can't set it — insert policy `with check (reporter_id = auth.uid())`).
- My Reports: GET returns **only the session user's rows** (`eq(reporter_id, session)`); read-only for members (no user update/delete policies).
- Moderation of reports: status transitions + assignment are moderator+ server actions; queue reads are moderator-gated, bounded (limit 50, newest first).

## 7. Pins

- Moderator+ only; action re-checks role + resolves room slug server-side + rate-limited (`community_pin` 10/60s).
- **Room-scoped**; one pin per message (unique `message_id`); `position` ordered; pinned list rendered at the room page (server-fetched, Promise.all with messages).
- Members see pins via realtime: pin rows are admin-written (no postgres stream), so the acting moderator **re-broadcasts** on the room channel — strict parsed payload `{roomId, messageId}` (`parsePinBroadcast`/`parsePinRemoveBroadcast`), room-scope check, idempotent local mirror.
- Deep link `?message={id}` highlights the pinned message (pre-existing Phase 3 mechanism, reused).
- Unpin: moderator+ (same gates); broadcast `PIN_REMOVE_BROADCAST_EVENT`.

## 8. Moderation

- Page server-guarded (`fetchViewerRole` + `isModerator`, redirect otherwise); `viewerRole` passed as a prop (no client role resolution).
- Actions: `delete_message`, `hide_message`, `unpin`, `remove_answer`, `close_question`, `reopen_question`, `warn_user`, `timeout_user`, **`suspend_user`/`reinstate_user` admin+ only** (two gates: action + lib).
- Every action writes a **`community_moderation_actions` audit row** (actor, action, target, report link, note) — the audit trail tab (moderator+) reads the last 30, bounded.
- Queries bounded (limit 50 / 30, indexed); queue/audit read-only for users (no write policies).

## 9. Roles

- Hierarchy: member < helper < moderator < admin (+ owner). `community_user_role()` SQL function = single source for RLS.
- Assignment: admin+ via `setMemberRoleAction` → `setMemberRole` lib: **cannot demote/revoke the owner, cannot act on or demote a higher rank** (escalation + self-trap prevention) — guarded by tests.
- Roles are re-resolved from the DB on **every** privileged call (demotion effective on next click).
- No client ever transmits a role: actions derive the actor from `auth.getUser()`, the lib re-checks the DB row, RLS re-checks in SQL.

## 10. Reputation

- `community_reputation_events`: fixed points only (answer accepted +10 / question author +2); idempotent per (actor, target, type); no user write policy; read policy for the member card.
- Profile card shows points + answer counts (server query, own-row-scoped where applicable).
- No reputation can be earned on self-content (structural, see §4).

## 11. Notifications

- Answer posted → question author (title/content/refs, send-key dedupe) — never self.
- Answer accepted → answer author (pre-existing contract).
- Delivery via the Phase 2 notification center (unchanged); Phase 5 adds `answer`/`accepted` content refs for deep linking.

## 12. Community Home

- Unchanged by Phase 5 except: Q&A room entries link to the new `[room]/questions` page; 7-day activity feed (SQL-side window) untouched and regression-tested by the baseline suite.

## 13. APIs

| Route | Auth | Gates | Notes |
|---|---|---|---|
| `GET /api/community/search` | session | rate `community_search` 30/60s | param validation → 400; room slug resolved server-side; 500 degraded |
| `POST /api/community/questions` | session | write gate (suspended/muted), rate `community_question` 10/60s | multipart; image byte validation; 201 |
| `POST /api/community/questions/:id/answers` | session | write gate, rate `community_answer` 20/60s | 404/409/400; notifies author |
| `POST /api/community/reports` | session | write gate, rate `community_report` 5/60s | 404/403 self/409 dup; 201 |
| `GET /api/community/reports` | session | rate `community_profile` 30/60s | own rows only |

All identity from the session; every response envelope is typed; no service-role exposure.

## 14. Server actions

10 actions in `advanced-actions.ts` — each: session actor (`auth.getUser()`), role re-resolution where privileged, per-scope rate limit, input whitelists (UUIDs, status, action names), lib-level re-check, `revalidatePath` on success. Envelopes: `{ ok: true } | { ok: false, code }`.

## 15. Database / schema

v6 migration: 7 tables + 3 SQL functions (`community_user_role`, `community_is_moderator`, `community_is_admin`) + `community_search` (security definer, bounded), 12+ indexes (including 3 invariant indexes), FKs with sane ON DELETE behavior (pins cascade from message delete; reputation events survive via no-FK-by-design actor/target ids).

## 16. RLS / security

- RLS **enabled on all 7 new tables** (guarded by migration-scan tests).
- **No user write policies** on memberships / pins / moderation actions / reputation events; reports: insert own-only + select own-only, no update/delete.
- Questions/answers: insert policies bound to `author_id = auth.uid()`; updates bound to author (answers) / moderator functions.
- Reads scoped by room membership/enabled + author blocklist (both directions) inside `community_search` and the row policies.
- `community_search` execute: revoked from `public, anon`; granted to `authenticated, service_role` only; `p_user = auth.uid()` enforced.
- Service-role client (`@/lib/supabase/admin`) imported **only** by `server-only` modules; zero references in any client component/page (guarded by invariant tests).

## 17. Realtime

- Zero polling, zero timer-driven fetches. The **only** `setInterval` in the whole community surface is the pre-existing 1s typing-prune in `room-chat` (count asserted exactly 1 by tests).
- No duplicate subscriptions: idempotent local mirrors (`knownIds`, `prev.some(...)` pin dedupe, send-keyed notifications).
- Phase 5 adds two broadcast events (pin add/remove) with strict parsers — no new channels, no LiveKit/Voice changes of any kind.

## 18. i18n

- **479 community keys in each of de/en/fr/ar — key sets byte-identical across all four locales** (recursive full-subtree parity test), zero empty leaves, explicit Phase 5 keys verified in all four.
- RTL (ar) handled by the existing layout system; no hardcoded UI strings in Phase 5 components (all `t("community.…")`).

## 19. Accessibility / responsive UX

- Answer rows are real anchors with `id="answer-{id}"`; deep-link scroll **focuses** the answer (keyboard reachable).
- Report dialog: labelled form, fieldset radios for reasons, error text associated, focus on open, Escape/backdrop close, disabled while submitting.
- Moderation controls disabled with `aria` states during busy; toasts are announced; room settings inputs labelled; 44px touch targets on the composer row (pre-existing geometry tests still green).
- Responsive: mobile shell (drawer), 1-col/2-col breakpoints — pre-existing `community-mobile-layout` + `community-mobile-geometry` suites green.

## 20. Performance

- Search: ONE RPC per page, keyset (no offset scans), 20/page cap.
- Room page: messages + pins + viewer role in `Promise.all` (no N+1); moderation queue + audit bounded (50/30) and indexed.
- No extra realtime subscriptions for Phase 5 (pins piggyback the existing room channel); no new per-row queries (report/moderation name resolution batches via `in(...)` bounded to 100).
- Build compiles all 5 new routes as dynamic server pages.

## 21. Tests

- **Total: 2872 passed / 0 failed / 0 skipped / 125 files** (`npm test`, this session).
- Breakdown: 2760 pre-Phase-5 baseline (Phases 1–4 + app) + **112 new**:
  - `tests/community-phase5.test.ts` — 49: Q&A state machine + reputation idempotency, pins, reports, roles (owner/escalation guards), moderation actions + audit, search lib, event parsers.
  - `tests/community-phase5-api.test.ts` — 63: all four API routes (auth/validation/gates/status codes/notification contract), anti-spam scopes, v6 migration security guards (RLS, write-policy absence, invariants, DM exclusion, grants), 4-locale i18n parity, client invariants (no polling/timers/XSS/service-role/client-role).
- No test deleted, no assertion weakened; the two Phase 5 test failures found during development were fixed on the **test side** (scope filter + thenable reject forwarding) after diagnosis — implementation stayed as designed.

## 22. Typecheck / lint / build

- `npm run typecheck` — **PASS** (tsc --noEmit, 0 errors).
- `npm run lint` — **PASS, 0 errors / 0 warnings**. The 10 initial errors were fixed properly (no suppressions for real issues): date-window moved to the data layer (search page render purity), `authorsRef` restructured (declared before first use, prop-seeded initializer — the React-Compiler immutability rule rejected the original state-seeded latest-value ref), moderation-view prop mutation → saved-snapshot state, report-dialog effect-reset → render-time state adjustment, 3× `prefer-const`, unused destructure removed. Two warnings also eliminated (dead write-only state in question-detail; the user-image `<img>` carries the codebase-standard documented disable comment like the other user-uploaded-image sites).
- `npm run build` — **PASS** (all routes compiled, incl. the 5 new Phase 5 pages).

## 23. Ten audits + technical debt

| # | Audit | Verdict |
|---|---|---|
| 1 | Authentication & Authorization | **PASS** — every privileged path: session actor + DB role re-check + lib re-check + RLS; no client-trusted identity/role anywhere in the Phase 5 surface. |
| 2 | Database & RLS Security | **PASS** — RLS on all 7 tables; protected tables write-invisible to users; report privacy (own rows only); moderation audit read-only for users; DMs untouched by any Phase 5 query. |
| 3 | XSS & Input Security | **PASS** — no `dangerouslySetInnerHTML` in any Community file (the only 2 in the app are static bootstrap `<script>` constants in `app/layout.tsx`, pre-existing, non-Community, no user input); all user content rendered as text; strict broadcast payload parsers. |
| 4 | Rate Limiting & Anti-Spam | **PASS** — every Phase 5 action has a bounded 60s scope (search 30, question 10, answer 20, report 5, pin 10, moderation 30, role 10, room_settings 10); scopes asserted in tests; write gates (suspended/muted) on all write routes. |
| 5 | Realtime Correctness | **PASS** — no polling; single interval (pre-existing typing prune, count-asserted); idempotent mirrors; pin broadcasts strict-parsed + room-scoped; no LiveKit/Voice change. |
| 6 | Search Correctness + DM Exclusion | **PASS** — keyset only, session identity enforced in SQL, filters validated, `community_search` provably references no DM table (migration-scan test). |
| 7 | Q&A + Reputation + Notifications | **PASS** — one-accepted DB invariant, self-award structurally impossible, fixed idempotent points, author notifications with refs, never self-notified. |
| 8 | Moderation + Roles + Audit | **PASS** — hierarchy enforced at 3 layers, owner + escalation guards, admin-only sanctions, every action audit-logged, bounded reads. |
| 9 | i18n + Accessibility + Responsive UX | **PASS** — 479×4 identical key sets, zero empty leaves, keyboard-reachable deep links, labelled dialog/forms, pre-existing mobile suites green. |
| 10 | Performance + Regression + Invariants | **PASS** — no N+1 (Promise.all), bounded queries, 1 RPC/page search; 2760 baseline fully green; invariants (no timers/XSS/service-role/polling) test-guarded. |

**Technical debt (non-blocking, documented):**
- `app/layout.tsx` uses 2 static bootstrap `<script dangerouslySetInnerHTML>` (theme/lang pre-load) — pre-existing, non-Community, no user input; left untouched per scope.
- `question-detail.tsx` question image uses `<img>` (remote Supabase URL) with the codebase-standard documented disable — consistent with all other user-image sites; a `next/image` remotePatterns config would be a cross-cutting app change (out of scope).
- The React-Compiler `useRef` latest-value pattern in `room-chat` required a prop-seeded initializer + declaration-before-first-use; a future React/ESLint bump should re-verify (covered by the 0-error lint gate).

## 24. Final declarations

- **Phase 1 green** — baseline suite (chat/rooms/identity) fully passing within the 2872.
- **Phase 2 green** — social layer (DMs/follows/notifications) fully passing.
- **Phase 3 green** — deep links/realtime robustness fully passing.
- **Phase 4 green** — home/activity/settings fully passing.
- **Phase 5 final status: COMPLETE** — all STEP 1–9 done, gates green, audits clean.
- **Voice/LiveKit unchanged** — no file under the voice/LiveKit surface modified in Phase 5 (this session touched only community files + tests + this report).
- **DMs excluded from global search** — by construction (SQL function references no DM table) + guarded by test.
- **No polling** — asserted by tests across the Phase 5 surface.
- **No `setInterval`** in new Phase 5 code; the single pre-existing typing-prune interval in `room-chat` is count-asserted and unchanged.
- **No `dangerouslySetInnerHTML`** in any Community file.
- **No service-role in client code** — invariant-tested.
- **Authorization server-side** — session actor + DB role re-check + lib re-check + RLS on every privileged path.
- **RLS enabled/protected** — all 7 new tables; write policies absent from protected tables (test-guarded).
- **Exact final test count: 2872** (2760 baseline + 112 Phase 5), 0 failed, 0 skipped, 125 files.
- **Typecheck result: PASS** (0 errors).
- **Lint result: PASS** (0 errors, 0 warnings).
- **Build result: PASS**.
- **10 audit results: 9 PASS + 1 PASS-with-documented-notes** (XSS audit — app-level bootstrap scripts noted in tech debt); **zero FAILs**.
- **Known warnings:** none in lint; the three technical-debt items above are documented, non-blocking, pre-existing or standard-convention.
- **Phase 6 NOT started.**
- **No commit / no push / no reset / no stash / no git command of any kind executed.**

**PHASE 5 COMPLETE — UNCOMMITTED**
