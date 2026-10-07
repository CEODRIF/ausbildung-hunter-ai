# Community Voice — LiveKit Production Runbook (Phase 6D)

**Project:** AusbildungsWeg · **Scope:** production readiness for the
Community voice feature (LiveKit). **No real secrets are recorded in this
document** — only variable names, formats, and procedures.

> **Status note (2026-10-07):** no LiveKit cluster is provisioned for this
> project yet. Sections 2, 3, 13 describe the provisioning + verification
> work that must be executed (and recorded) before declaring production
> readiness. Everything in this runbook that could be verified in-repo has
> been verified (see the Phase 6D final report); infrastructure-dependent
> steps are marked **BLOCKED** there.

---

## 1. Required environment variables

| Variable | Format | Where used | Required in production |
|---|---|---|---|
| `LIVEKIT_URL` | `wss://…` (prod) / `ws://…` (dev) | token route (client join URL) + `livekit-api.ts` (rewritten `wss→https` for the Server API base) | **yes** (gated by `npm run check:env`, production mode) |
| `LIVEKIT_API_KEY` | LiveKit API key (identifier) | token minting (`iss`) + Server API auth | **yes** |
| `LIVEKIT_API_SECRET` | LiveKit API secret (HS256 key) | token signing + admin token signing | **yes** — **server-only, never to the browser** |
| `EMAIL_WORKER_SECRET` | long random string | `/api/internal/voice-sweep` trust boundary (shared worker secret) | yes (existing worker infra) |

- `npm run check:env` (pre-deploy, production mode) **fails the deploy
  check** if any of the three LiveKit vars is missing/placeholder;
  non-TLS `LIVEKIT_URL` warns ("dev only"); the `livekit-voice` seam
  reports `configured`/`pending`. Diagnostics print **names and statuses
  only** (tested).
- The three vars are read in exactly two modules, both
  `import "server-only"`: `src/lib/voice/livekit-token.ts` and
  `src/lib/voice/livekit-api.ts`. No `NEXT_PUBLIC_*` LiveKit variable
  exists; the browser only ever receives the short-lived join token.
- `.env.example` documents all three (placeholder values).

## 2. LiveKit deployment/configuration

**Option A — LiveKit Cloud (recommended for launch):** provision a cloud
account + project; the project page gives the URL/key/secret directly;
TURN is included; `RemoveParticipant` **revokes the participant's token**
(server-side), so a suspended user cannot reconnect with a cached token.

**Option B — Self-hosted:** deploy the LiveKit server (docker/K8s) with a
TLS-terminating `wss://` URL, create an API key/secret via the server
API/console, and configure TURN **yourself** (see §3). Note:
`RemoveParticipant` does **not** revoke cached tokens on self-hosted — a
suspended user's cached join token (TTL ≤ 600 s) could reconnect once;
new tokens are always refused by the write gate, so the exposure is
bounded by the TTL.

Server-side settings that matter (cloud defaults are fine to start):
- `emptyRoomTimeoutSeconds` — default 30 s is correct: the SFU cleans its
  own rooms; the app's DB badge converges via the §10 sweep.
- Max participants per room — the app enforces 50 (§6); keep the server
  limit ≥ 50.
- No ingress/SIP/recording features are used — leave them off.

## 3. TURN configuration

- **LiveKit Cloud:** managed TURN (turn:livekit.cloud, 3478/udp) is
  included in the cloud deployment — verify in the project settings.
- **Self-hosted:** deploy `coturn` (or equivalent) and add it to the
  LiveKit server config (`turn: { urls, transport, credential }`); use
  long-lived static credentials scoped to TURN; test with a client behind
  a symmetric NAT (mobile cellular is the reference case).
- **Verification (BLOCKED until cluster exists):** the D-3 matrix in the
  final report — desktop/Wi-Fi, mobile/cellular, two different networks,
  reconnect after network blip. Do NOT mark TURN ready because the
  variable exists; record observed ICE results.

## 4. Vercel configuration

- Set `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
  (production + preview as needed) in **Vercel → Project →
  Environment Variables** — never in code, never in `.env` files that
  are committed.
- Serverless functions run on the Node runtime; both voice modules are
  `server-only` and use `node:crypto` (HS256) — no extra packages.
- `npm run check:env` is the deploy gate (run in CI / pre-deploy):
  production mode fails without the three vars.
- Internal endpoints (`/api/internal/voice-sweep`) are reachable over
  plain HTTP on Vercel — they are protected by the
  `x-email-worker-secret` header (worker == service-level trust), the
  same boundary as email-worker/storage-reconcile; treat the worker
  secret as a server credential.

## 5. Token configuration

| Property | Value | Where |
|---|---|---|
| Algorithm | HS256, signed with `LIVEKIT_API_SECRET` | `createLiveKitVoiceToken` |
| `iss` | API key | |
| `sub` (identity) | **verified `auth.uid()`** — server-only; a client can never select another identity | token route |
| `video.room` | **server-derived** provider room name (`croom-<room id>`, from `community_voice_join`) — the client sends only the DB room id | token route |
| `video.roomJoin/canPublish/canSubscribe` | `true` (minimal set; **no roomAdmin, no roomList, no roomCreate/roomRecord**) | |
| `name` | display name (top-level claim → `Participant.name`) | |
| `metadata` | **string** `JSON { avatarId }` (frozen UI parses it) | |
| TTL | **600 s** (`VOICE_TOKEN_TTL_SECONDS`); `exp` present (required by the current LiveKit verifier) | |
| jti | random 128-bit, per token | |

Admin (Server API) tokens for eviction (`livekit-api.ts`) are separate:
no `sub`, per-call minimal grants (`roomList` / `roomAdmin+room`), 600 s
TTL, minted in-request, never stored.

## 6. Voice room limits (production defaults — preserved from Phase 4/6 design)

| Limit | Value | Source | Rationale |
|---|---|---|---|
| Max participants per community voice room | **50** | v5 schema CHECK + join/sync RPC clamps | community-scale voice, SFU-safe |
| Rate limit: voice join tokens + count sync | **20/min per user** (`community_voice`) | `src/lib/rate-limit.ts` | stops join/leave churn + token spam, allows reconnects |
| Join token TTL | **600 s** | `VOICE_TOKEN_TTL_SECONDS` | covers connect + short reconnects; bounded exposure for self-hosted token cache (6B §14.2) |
| Stale-badge sweep threshold | **15 min** silence (`staleMinutes`) | v9 RPC default | well above the SFU's ~15–30 s dead-peer drop window |
| Sweep per-tick budget | **25** records (cap 100) | v9 RPC + internal route clamps | bounded execution |
| Sweep cadence | **5–15 min** (6D poller, external durable scheduler) | §10 | badge convergence is cosmetic; no tightness needed |
| Eviction request timeout | **5 s** per LiveKit API call | `LIVEKIT_API_TIMEOUT_MS` | moderation path never stalls |
| Eviction room scan cap | **50** candidate rooms | `LIVEKIT_MAX_CANDIDATE_ROOMS` | dedicated-cluster concurrency bound |
| Room lifecycle | one `active` conversation per room (partial unique); `ended` = history; SFU room auto-closes when empty (cloud default 30 s) | v5 schema | |
| Reconnect | LiveKit client auto-reconnects on the same token until `exp`; a new token requires passing the write gate again (suspended → 403) | Phase 4 client (frozen) | |
| Moderation/eviction | `suspend_user` → server-authorized eviction (6B); reinstate does NOT evict | 6B | |

No new configuration framework was introduced — these are the existing
intentional values, documented.

## 7. Monitoring (Phase 6C structured events — no APM vendor)

Grep the app logs (or forward stdout to your log shipper) for:

| Event | Meaning | Level |
|---|---|---|
| `community.voice.join` | join attempt (userId, roomId) | info |
| `community.voice.token_issued` | token minted (userId, roomId, room, participantCount, ttlSeconds — **never the token**) | info |
| `community.voice.join_denied` | denied, with stable `reason=` (unauthenticated/invalid_room/rate_limited/suspended/muted/voice_unavailable/room_not_found/join_failed) | warn (error for join_failed) |
| `community.voice.leave_sync` | count sync (userId, roomId, count, result ok/failed) | info / error |
| `community.voice.cleanup` | stale sweep tick (swept, staleMinutes, maxSwept) | info |
| `community.voice.eviction` | eviction outcome (userId, status=evicted/not_configured/not_in_any_room, rooms) | warn (evicted) / info |
| `community.voice.unavailable` | SFU unreachable / RPC failure (context, detail) | error |

Alert-worthy patterns: sustained `join_denied reason=voice_unavailable`
(cluster down), `community.voice.unavailable` (eviction/sweep failures),
repeated `leave_sync result=failed`. LiveKit's **own** infrastructure
metrics (rooms, participants, CPU, ICE failures) come from the LiveKit
Cloud dashboard / self-hosted metrics endpoint — monitor there, not in
the app (C-4 APM decision: deferred).

## 8. Logs

- Single-line, machine-parseable: `[community] <event> key=value …`
  (Phase 6C helper; scalar fields; >120-char values truncated with
  `…(len=N)`; newlines flattened).
- **Never logged:** API secrets, join tokens, signed URLs, message/image
  contents, more personal data than userId/roomId (tested: full-console
  capture asserts).
- Existing non-voice `[community]` lines (Phase 4–6) follow the same
  prefix; only the voice hot paths were upgraded to structured events.

## 9. Suspension/eviction behavior

1. Moderator (admin role) executes `suspend_user` (rate-limited, audited
   in `community_moderation_actions`).
2. The profile update + audit happen first — the sanction is durable.
3. The server then calls `evictLiveKitParticipant(targetId)`:
   `ListRooms → croom-* filter → ListParticipants → RemoveParticipant`
   (authoritative source = the SFU, never the DB count shadow).
4. Outcomes are explicit + logged: `evicted` (rooms listed) /
   `not_in_any_room` / `not_configured` / `unavailable` (detail). An
   unreachable SFU **never blocks or fails the sanction** and **never
   claims success**.
5. The suspended user's client receives a LiveKit disconnect; every new
   join attempt gets `403 suspended` at the token route (write gate).
6. On LiveKit Cloud the removed participant's token is revoked (no
   rejoin with a cached token); on self-hosted the cached token may
   reconnect once until `exp` (≤ 600 s) — see §2.
7. Reinstatement does not evict; the user re-joins via the normal flow.

## 10. Stale sweep scheduling

- Endpoint: `POST /api/internal/voice-sweep` (worker-secret auth; strict
  body `{ staleMinutes?: 1..1440, maxSwept?: 1..100 }`, defaults
  15/25; empty object = defaults).
- Schedule the **external durable poller** (the same one driving
  email-worker + storage-reconcile) to POST `{}` every **5–15 minutes**.
- Response `{ swept, staleMinutes, maxSwept }` = how many DB badge
  records converged — a housekeeping counter, **not** a statement about
  SFU rooms.
- The sweep is idempotent and bounded; safe to run repeatedly or
  temporarily more often (e.g., after a known mass-disconnect incident).

## 11. Failure modes

| Failure | Behavior | Operator action |
|---|---|---|
| LiveKit vars missing at deploy | `check:env` fails the deploy | add the three vars; re-deploy |
| LiveKit vars missing at runtime (misconfig) | voice route `503 voice_unavailable`; eviction `not_configured`; UI shows "voice unavailable" | fix env; no data impact |
| SFU down (503/timeout from the API) | join denied `503`; eviction logged `unavailable` (sanction still succeeds); sweep `500` + `unavailable` | check cluster health dashboard; suspended users' sessions persist until token expiry (≤ 600 s) — re-run suspend after recovery if the user is still suspended |
| SFU reachable but a specific room operation fails | eviction `unavailable` with per-room detail | inspect detail; re-run |
| Stale rows accumulate (poller down) | "Voice conversation · N" badge may linger on empty rooms | restore poller; run one manual sweep (`{}`) to converge immediately |
| Client count sync fails (transient) | badge count may be off (cosmetic, by Phase 4 design) | none — converges on next join/leave |
| Token TTL expiry mid-call | client auto-reconnect uses the same token until `exp`; after that a fresh token is needed (route, gate applies) | none normally; if users report drops, check cluster latency/ICE |

## 12. Recovery procedure

1. **Confirm cluster health** (LiveKit dashboard / `curl` health
   endpoint on self-hosted).
2. **If vars were wrong:** fix in Vercel env → redeploy → `check:env`
   passes → verify one voice join (§13 test A).
3. **If the cluster was down:** after recovery, (a) run one manual
   `voice-sweep` (`POST {}` with the worker secret) to converge badges,
   (b) check recent `community.voice.unavailable` log lines; for each
   suspended user whose eviction was `unavailable`, re-execute the
   suspension action (the sanction is idempotent; eviction retries
   against the live cluster), (c) verify a normal join/leave (§13).
4. **If the worker secret was rotated:** update the poller + Vercel env
   together; the internal endpoints fail closed (401) until both match.
5. Re-run the §13 E2E checklist end-to-end.

## 13. E2E verification procedure (execute on the real cluster; record results)

Two real browser profiles (A, B) + one admin profile; use two different
networks where possible (§3/D-3).

- **A — Basic join:** A opens a community room → joins voice → observe
  200 token response, A's tile appears, DB row `active`
  (`participant_count = 1`), badge shows 1.
- **B — Second participant:** B joins the same room → both tiles visible
  bidirectionally → `participant_count = 2` → audio flows both ways.
- **C — Leave:** B leaves → B's tile disappears for A → count 1 → A
  stays connected → row stays `active` with 1.
- **D — Suspension during active call (CRITICAL):** A+B in a call →
  admin suspends A via the moderation UI → watch app logs:
  `community.voice.eviction … status=evicted rooms=croom-…` (or an
  honest `unavailable` if the cluster misbehaves) → A's client is
  disconnected by LiveKit → A tries to rejoin → `403 suspended` → B is
  unaffected throughout → **no "evicted" log exists unless the
  RemoveParticipant call actually succeeded** (check the log line).
- **E — Unsuspended user:** B keeps talking; B leaves and re-joins
  normally (new token 200).
- **F — Unauthorized eviction:** a normal (non-admin) session has **no
  code path** to trigger eviction — verify by attempting to reach
  `/api/internal/voice-sweep` without the worker secret (401) and
  confirming no client-side eviction API exists (source-audited in the
  6B report).
- **TURN/mobile (D-3):** repeat A–C with (1) desktop/Wi-Fi, (2)
  mobile/cellular, (3) the two clients on different networks; record
  ICE success and any failures; then cut A's network for ~10 s and
  confirm auto-reconnect.

## 14. Security checklist

- [ ] `LIVEKIT_API_SECRET` present only in server env (Vercel dashboard); `grep NEXT_PUBLIC` finds no LiveKit var
- [ ] `npm run check:env` (production) passes; output contains no secret values
- [ ] Token route: `sub` = `auth.uid()`; `video.room` = server-derived `croom-<id>`; grants exactly `{room, roomJoin, canPublish, canSubscribe}`; TTL 600 s
- [ ] Suspended/muted users get `403` at the token route (write gate) — re-test after deploy
- [ ] Eviction only reachable from the server-side `suspend_user` action (admin role, rate-limited, audited); `/api/internal/voice-sweep` 401 without worker secret
- [ ] No LiveKit admin call from any client bundle (source audit: only `src/lib/voice/livekit-api.ts`, `server-only`)
- [ ] Logs contain no tokens/secrets/signed URLs (full-console-capture tests)
- [ ] v8 storage read policies + 6A quota/GDPR unchanged (6D made no storage changes)

## 15. Rollback considerations

- **Token contract change (6D/D-5):** if the live cluster rejects the
  new claim layout for any reason, the one-file rollback is
  `src/lib/voice/livekit-token.ts` (claims payload). The old layout was
  verified incompatible with the current spec, so this rollback is
  expected to be *worse*, not better — treat cluster rejection as a
  cluster/version issue to investigate, not grounds for reverting.
- **Eviction hook (6B):** remove the `evictLiveKitParticipant` call in
  `moderation.ts` if the Server API integration proves harmful —
  suspension itself is unaffected (best-effort by design).
- **Sweep (6C):** stop the poller; the v9 function can be dropped
  (`drop function public.community_voice_sweep_stale(integer, integer)`)
  — no data is ever deleted by the sweep, so dropping it is safe.
- **Environment:** removing the three LIVEKIT vars degrades voice to 503
  + eviction no-op (fail-soft by design) — a safe feature-level
  rollback without touching code.
