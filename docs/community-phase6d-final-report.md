# Community Phase 6D — LiveKit Production Readiness: Final Report

**Project:** AusbildungsWeg (`ausbildung-hunter-ai`)
**Phase:** Community 6D (per `docs/community-phase6-discovery-report.md`)
**Date:** 2026-10-07
**Status:** **PHASE 6D COMPLETE — UNCOMMITTED**
**Verdict: PRODUCTION READY — INFRASTRUCTURE VERIFICATION PENDING** (§17)

---

## 1. Scope

Phase 6D completed the LiveKit production-readiness work: D-1
(configuration verification), D-2/D-3 (real-cluster E2E + TURN —
**BLOCKED, no cluster exists in this environment** — procedures and
record-keeping delivered instead), D-4 (voice limits/lifecycle review),
D-5 (join-token contract validation → **one real incompatibility found
and fixed**), monitoring via the Phase 6C structured logger, the
production runbook, and the final security audit.

No Phase 6F, no new features, no architecture redesign, no APM vendor.

**Files changed:**

- MOD `src/lib/voice/livekit-token.ts` — D-5 claim-layout fix (the ONLY
  functional code change; ~15 lines + doc header)
- MOD `src/lib/community/moderation.ts` — eviction outcomes now flow
  through the Phase 6C structured events (monitoring requirement; the
  6B security behavior is unchanged)
- MOD `tests/community-voice.test.ts` — 2 token blocks re-expressed to
  the verified current contract + **2 new D-5 regression tests**
- MOD `tests/community-phase6b.test.ts` — 3 eviction-log assertions
  re-expressed to the structured events (same security intent: explicit
  state, detail, no fake success)
- MOD `tests/community-phase6c.test.ts` — 1 assertion (eviction-preservation
  contract) updated to the structured events
- NEW `docs/community-phase6d-production-runbook.md`
- NEW `docs/community-phase6d-final-report.md` (this file)

**No migrations** (D-5 needs none; D-1…D-4 found no schema gaps).

## 2. D-1 — Production Configuration (verified in-repo)

| Check | Result |
|---|---|
| `check:env` (production mode) requires all three `LIVEKIT_*` vars | PASS — 6C: missing var → deploy-gating fail "missing (required in production)"; tests 1–4 green |
| Secrets never appear in diagnostics | PASS — 6C tests assert none of the three values appears in the API result or CLI stdout |
| `LIVEKIT_URL` production shape validated | PASS — `wsUrl` kind: valid URL required; `wss://`/`https://` expected; non-TLS warns "dev only" |
| API key/secret server-only | PASS — exactly two modules read the vars, both `import "server-only"` (`livekit-token.ts`, `livekit-api.ts`); full-source grep |
| No `NEXT_PUBLIC_*` LiveKit variable exists | PASS — grep clean (browser receives only the join token) |
| Vercel/server runtime receives the vars | PASS (by convention) — env vars in the Vercel dashboard; serverless Node runtime; `node:crypto` only (no new packages); documented in runbook §1/§4 |
| Real credentials | **BLOCKED** — no cluster in this environment; no secrets were written to the repo (none exist to write) |

## 3. D-2 — Real LiveKit E2E (TESTS A–F)

**BLOCKED — no LiveKit cluster is provisioned for this project**
(`.env` absent; `LIVEKIT_*` unset; nothing reachable). Per the E2E
testing rule, **no E2E "PASS" is claimed**. Delivered instead:

- The full executable procedure (tests A–F with exact expected
  observations, incl. the critical suspension-during-call test D and the
  unauthorized-eviction test F) is in **runbook §13**.
- Every A–F behavior that is expressible without a cluster is covered by
  automated tests (2995-suite): token issuance + claims (A), room
  derivation (A), join denial states (D/F), suspended → no new token
  (D7), suspension → eviction call sequence with identity = sanctioned
  target + honest result states (D), unsuspended user unaffected (E),
  no client/admin eviction surface (F).
- What remains infra-only: actual WebSocket connect, media flow,
  LiveKit-side removal + token revocation, client disconnect UX.

## 4. D-3 — TURN / Mobile / Network

**BLOCKED — same reason** (no cluster, no second network available in
this environment). Delivered: the verification matrix (desktop/Wi-Fi,
mobile/cellular, two different networks, reconnect-after-blip) is in
**runbook §3 + §13**; the TURN configuration guidance (LiveKit Cloud
managed TURN vs. self-hosted `coturn`) is in runbook §3. Per the spec,
TURN is **not** claimed production-ready on the basis of configuration
variables alone.

## 5. D-4 — Voice Limits & Lifecycle (reviewed; all preserved)

Every value below already exists in the Phase 4/6 architecture — nothing
was invented, nothing changed:

| Parameter | Production default | Source |
|---|---|---|
| Max participants per room | **50** | v5 schema CHECK + join/sync RPC clamps |
| Voice rate limit | **20/min** per user (`community_voice`) | `src/lib/rate-limit.ts` (documented: stops churn + token spam, allows reconnects) |
| Join token TTL | **600 s** | `VOICE_TOKEN_TTL_SECONDS` |
| Stale-badge sweep | **15 min** silence threshold, **25/tick** (cap 100) | v9 RPC + `/api/internal/voice-sweep` (6C) |
| Sweep cadence | **5–15 min** via the external durable poller | runbook §10 (6C: "narrow seam, 6D attaches the poller" — the poller itself is deployment infra, documented, not code) |
| Room lifecycle | one `active`/room (partial unique); `ended` = history; SFU auto-closes empty rooms (cloud default 30 s) | v5 schema |
| Reconnect | client auto-reconnect on the same token until `exp`; new token re-checks the write gate | Phase 4 frozen client |
| Moderation/eviction | suspend → server eviction (best-effort, honest states); reinstate → no eviction | 6B |

## 6. D-5 — Join-Token Validation (mandatory investigation → FIX)

**Verdict: the Phase 4 join token was INCOMPATIBLE with the current
LiveKit server contract.** Evidence (verified against the official
`livekit-server-sdk` source on main + the LiveKit token docs, and
corroborated by the frozen UI itself):

1. Current contract: JWT payload carries grants under the **`video`**
   claim (`{ room, roomJoin, canPublish, canSubscribe, … }`), the
   participant display name as the **top-level `name` claim**, and
   custom data as the **top-level `metadata` STRING** (plus `attributes`
   map). The current verifier also **requires an `exp` claim**.
2. Phase 4 token put grants + `name` + `avatarId` under a `metadata`
   **object**. Consequence: a current LiveKit server would see **no
   `video` grants → no `roomJoin` → the join is rejected** — real voice
   would never have worked. Independently, the frozen UI
   (`use-voice.ts`) reads `Participant.name` and does
   `JSON.parse(participant.metadata).avatarId` — the Phase 4 layout
   breaks the avatar path too. (The 6B admin token already followed the
   current `video` spec — independent corroboration of the direction.)

**Minimal fix (`src/lib/voice/livekit-token.ts`, claims payload only):**

```
video:  { room, roomJoin: true, canPublish: true, canSubscribe: true }  // EXACT set
name:   <display name, ≤100 chars>          (top-level claim)
metadata: JSON.stringify({ avatarId })      (top-level STRING)
```

All other properties preserved: HS256 + `node:crypto`, `iss` = API key,
`sub` = verified `auth.uid()`, random `jti`, 600 s TTL with `exp`
present, server-derived room, no other code touched.

**D-5 checklist results (all automated):** identity = auth.uid ✅ ·
room server-derived ✅ (client-supplied provider names ignored —
existing test green) · `roomJoin` correct ✅ · **no roomAdmin** ✅
(explicit) · **no roomList** ✅ (explicit) · TTL 600 s bounded ✅ ·
metadata format compatible (string, UI round-trip tested, exact claim-key
set asserted) ✅ · no sensitive data in metadata (only display name +
avatar id; secret absence asserted) ✅ · suspended → no token (403,
6B/6C tests) ✅ · no identity selection by client ✅ · no room
selection outside authorized logic ✅.

**Tests:** 2 blocks re-expressed (intent preserved and strengthened:
`toEqual` on the exact `video` grant set; explicit no-roomAdmin/
no-roomList) + 2 new regression tests (avatar round-trip through the
frozen-UI parse contract; exact claim-key set + secret absence).

## 7. Monitoring

All required events are observable through the Phase 6C structured
logger (no APM vendor — C-4 decision stands): token issued
(`token_issued`), join denied (`join_denied` + stable `reason`),
LiveKit unavailable (`unavailable`), eviction attempt/result
(`eviction` with `status=evicted|not_in_any_room|not_configured`),
eviction failure (`unavailable context=eviction` at ERROR with detail),
stale sweep (`cleanup`), join/leave sync (`join`/`leave_sync`).
**Change made:** the three ad-hoc 6B eviction console lines in
`moderation.ts` now emit the structured `community.voice.eviction` /
`community.voice.unavailable` events (the 6B security semantics —
explicit state, detail, never a fake success — are preserved and their
3 test assertions re-expressed accordingly). LiveKit infrastructure
metrics belong in the LiveKit dashboard (runbook §7).

## 8. Security Audit (14 items — ZERO unresolved FAIL)

| # | Item | Result |
|---|---|---|
| 1 | Token generation (HS256, server-only, secret never leaves server) | PASS |
| 2 | Token claims (exact minimal `video` set, asserted with `toEqual`) | PASS |
| 3 | Token TTL (600 s; `exp` present — required by current verifier) | PASS |
| 4 | Metadata (string `JSON{avatarId}`; display name + avatar id only; exact claim-key set asserted) | PASS |
| 5 | Room derivation (server-derived `croom-<id>` via RPC; client sends DB room id only; forged provider names ignored — test green) | PASS |
| 6 | Identity derivation (`sub` = verified `auth.uid()`; no impersonation test green) | PASS |
| 7 | Participant eviction (server-only, admin-role-gated, rate-limited, audited; identity = sanctioned target; no endpoint) | PASS (6B tests re-expressed, semantics intact) |
| 8 | Admin credential isolation (two server-only modules; no `NEXT_PUBLIC`; admin JWTs short-lived, per-call grants, no `sub`; secret never in any token/log) | PASS |
| 9 | TURN configuration | **BLOCKED** — no cluster; runbook §3/§13 define the required verification (Cloud managed TURN / self-hosted `coturn` + mobile/cellular + cross-network + reconnect matrix) |
| 10 | Environment validation (production gating, dev optionality, names-only output) | PASS (6C tests) |
| 11 | Structured logging (no secrets/tokens/signed URLs/contents — full-console-capture tests) | PASS |
| 12 | Suspended-user behavior (403 at token route; suspension → eviction; rejoin blocked; reinstate → no eviction) | PASS (6B/6C tests) |
| 13 | Stale voice cleanup (idempotent, bounded, worker-boundary, converge-only, no LiveKit claims) | PASS (6C tests + v9 guards) |
| 14 | Client/server boundaries (no client LiveKit admin ops; internal route 401 without worker secret; `server-only` imports; browser gets only the join token) | PASS |

## 9. Tests

| Suite | Tests | Result |
|---|---|---|
| **Full suite (`npm test`)** | **2995** | **2995/2995 ✅ (128 files, 0 failures)** |

Delta from the 2993 baseline: **+2 new D-5 regression tests**; the
re-expressed assertions (3 in `community-voice.test.ts`, 3 in
`community-phase6b.test.ts`, 1 in `community-phase6c.test.ts`) keep the
same or stronger security intent (exact grant set, explicit no-admin/
no-list, exact claim-key set, structured honest eviction states) — no
assertion was removed or relaxed. All Phase 6A/6B/6C tests remain green.

Spec scenario mapping: 1 room server-derived ✅ (existing test) · 2
identity = auth.uid ✅ (existing) · 3 minimal VideoGrant ✅ (now
`toEqual`) · 4 no roomAdmin ✅ (explicit) · 5 no roomList ✅ (explicit)
· 6 suspended no token ✅ (6B/6C) · 7 TTL bounded ✅ · 8 metadata
compatible ✅ (2 new) · 9 eviction not client-controlled ✅ (6B) · 10
eviction server-only ✅ (6B) · 11 unavailable honest ✅ (6B/6C) · 12 env
validation secure ✅ (6C) · 13 logging no leaks ✅ (6C) · 14 sweep
idempotent ✅ (6C) · 15 6A/6B/6C intact ✅ (full suite).

## 10. Typecheck

`npm run typecheck` — **PASS, exit 0, 0 errors.**

## 11. Lint

`npx eslint .` — **PASS, exit 0, 0 issues.**

## 12. Build

`npm run build` — **PASS, exit 0** ("✓ Compiled successfully").

## 13. Production Runbook

[docs/community-phase6d-production-runbook.md](community-phase6d-production-runbook.md)
— 15 sections: env vars, LiveKit deployment (Cloud vs self-hosted),
TURN, Vercel, token configuration, voice room limits, monitoring events,
logs, suspension/eviction behavior, stale sweep scheduling, failure
modes, recovery procedure, **E2E verification procedure (tests A–F +
TURN/mobile matrix)**, security checklist, rollback considerations.
No real secrets in the document.

## 14. Infrastructure Status

| Item | Status |
|---|---|
| LiveKit cluster (URL/key/secret) | **NOT PROVISIONED** (BLOCKED) |
| `check:env` production gate for the three vars | DONE (6C) — will fail deploys until vars exist |
| `livekit-voice` seam status in `check:env` output | `pending` (reports configured/pending) |
| Stale-sweep poller attachment | **NOT ATTACHED** (external durable poller, runbook §10; endpoint ready) |
| E2E A–F execution | **BLOCKED** (procedure delivered, runbook §13) |
| TURN/mobile verification | **BLOCKED** (matrix delivered, runbook §3/§13) |
| LiveKit dashboard monitoring | owner: infra (runbook §7) |

## 15. Known Limitations

1. **The join-token fix (D-5) has not been exercised against a live
   cluster** — it was validated against the official SDK source + docs
   and unit-tested; final confirmation is the runbook §13 test A on the
   provisioned cluster (expected outcome: join succeeds; if it does not,
   the cluster version is the variable to inspect — the claim layout now
   matches the current contract).
2. **Self-hosted token-cache window:** on self-hosted LiveKit, a
   suspended user's cached unexpired join token (≤ 600 s) could
   reconnect once after eviction (Cloud revokes the token). Bounded;
   new tokens are refused (6B §14.2 — unchanged).
3. **Quiet-but-live badge flip** (6C, unchanged): a live room with no
   join/leave events > 15 min can have its DB badge converge to `ended`;
   cosmetic, self-heals on next join.
4. **Sweep cadence is external:** until 6D's poller attachment happens
   at deploy time, stale badges persist (status quo behavior).
5. **E2E/TURN evidence is absent** — no production-observed voice call
   exists yet; nothing here claims otherwise.

## 16. Remaining Blockers (to flip the verdict to PRODUCTION READY)

1. **Provision a LiveKit cluster** (Cloud recommended) and set
   `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` in Vercel
   (runbook §2/§4) — `check:env` then passes.
2. **Execute runbook §13 tests A–F** on the cluster; record results
   (incl. test D: suspension → `community.voice.eviction
   status=evicted` + A's disconnect + A's rejoin `403 suspended` + B
   unaffected).
3. **Execute the D-3 TURN/mobile matrix** (desktop/Wi-Fi,
   mobile/cellular, cross-network, reconnect); record ICE outcomes.
4. **Attach the durable poller** to `/api/internal/voice-sweep`
   (every 5–15 min, runbook §10).
5. Optional: LiveKit dashboard alerts per runbook §7.

## 17. Final Production-Readiness Verdict

# **PRODUCTION READY — INFRASTRUCTURE VERIFICATION PENDING**

Rationale per the decision rules:

- **Code/config/contract work: complete.** D-1 verified (deploy-gated
  env, server-only credentials, no client exposure); D-4 limits
  documented (all pre-existing, preserved); D-5 token contract **fixed
  and regression-tested** against the verified current spec; monitoring
  fully on the structured logger; security audit: **zero unresolved
  FAIL** (one BLOCKED item — TURN — is infrastructure-dependent, not a
  code defect); all gates green (2995/2995 · typecheck 0 · lint 0 ·
  build 0).
- **Why not "PRODUCTION READY":** real LiveKit infrastructure is not
  available in this environment — no actual join, no multi-user voice,
  no suspension→eviction on a live SFU, no TURN/mobile verification, no
  cluster-side token-contract confirmation. The spec prohibits the
  unqualified verdict without exactly those.
- **Why not "NOT PRODUCTION READY":** no code/config/security blocker
  remains; the (former) token-contract blocker was found and fixed; the
  remaining work is a bounded, documented provisioning + verification
  procedure (§16, runbook §13) — not a design defect.

**Phase 6A remains COMPLETE · Phase 6B remains COMPLETE · Phase 6C
remains COMPLETE · no LiveKit cluster was provisioned · no production
LiveKit E2E was performed · Phase 6F was NOT implemented · NO GIT
OPERATIONS were performed** (Phases 6A–6D remain uncommitted in the
working tree).

**STOP — Phase 6D complete. Phase 6F NOT started.**
