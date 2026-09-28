# Ausbildung Hunter AI

A production SaaS that helps people in Germany find and apply for **Ausbildung** (vocational training) and **Arbeit** (jobs). Users connect their own Gmail/Outlook account, compose and send applications in bulk with a fair daily quota, use an AI assistant for application support, scan their own documents for fit, and search real German vacancies with a deterministic match score.

> **Status:** everything up to and including the Bewerbung Scanner is complete and passing checks. The opportunities system (Step 9) is **complete**: the BA provider, data model, caching, and saved-opportunities are hardened and live-verified against the BA API (Phase 2), the search UX is complete (Phase 3: real pagination, server-side sorting, provider-backed filters, shareable URL state, truncation awareness, richer cards, detail back-navigation), the production matching engine is complete (Phase 7, building on Phase 5: deterministic 12-dimension matching with complete/incomplete/unavailable states, structured per-dimension evidence with candidate/opportunity quotes, weighted transparent scoring, provenance-aware confidence, snapshot provenance + staleness, and "Match unvollständig" handling), application prefill is complete (Phase 6: server-derived opportunity-to-application prefill with a documented draft strategy), and the production dashboard is complete (Phase 8: deterministic next action, profile completeness, server-resolved recommendations, workflow integration) — all covered by unit tests.

## Implemented

| Area                         | What works                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Auth foundation**          | Supabase email + custom verification codes, invitation-code registration, login, email verification, onboarding goal, row-level security throughout                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Invitation model**         | `DRIF928` — free registration, 0 email quota (AI-assisted setup only). `DRIF089` — 100 email applications per day (records a `user_quota_upgrades` row on activation)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Dashboard**                | **Command center (Phase 8)**: deterministic next-action recommendation, 12-section profile completeness, server-resolved recommendations (existing search + matcher v2), recent applications with persisted campaign state, saved preview with staleness indicators, matching summary, usage/AI status (server-side quota), activity log, full workflow navigation — every section has an explicit empty state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Email account connection** | OAuth 2.0 for Gmail (`gmail.send`) and Outlook (Microsoft Graph `Mail.Send`), signed state, **AES-256-GCM encrypted token storage**, connection management UI at `/settings/email`, full token-leakage audit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Application composer**     | `/applications/new` — rich-text email editor, recipients with CSV/TXT import, private attachments (Supabase Storage, `user_id`-scoped), per-recipient draft autosave, reusable templates                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Email sending engine**     | Campaigns + individual messages, **atomic quota reservation** (`FOR UPDATE` on `daily_usage`), idempotent message claims (`FOR UPDATE SKIP LOCKED`), external worker endpoint secured by `EMAIL_WORKER_SECRET`, campaign monitor UI at `/applications/campaign/[id]`, usage page at `/settings/usage`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **AI assistant**             | `/ai` — conversation history, streaming responses, private file uploads (`ai-files` bucket), generated file downloads, **atomic AI usage limit of 100 requests/day**, server-only prompt hardening, strict Zod validation of all AI output                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Bewerbung Scanner**        | `/bewerbung-scanner` — CV/document upload (PDF/DOCX), strict Zod candidate profile, AI-generated scan results, editable result page, rescan + history, counts against the AI limit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Opportunities**            | `/opportunities` — BA Jobsuche provider hardened (live-verified v6 search + v4 details, authoritative Ausbildung/Arbeit classification, salary/education/contact/section extraction, explicit freshness handling, bounded server-side filters), user-independent versioned cache, server-derived saved opportunities, detail + saved pages. **Search UX (Phase 3)**: real pagination respecting the BA 10k bound, server-side sorting, provider-backed filters, shareable/validated URL state, truncation awareness, richer null-safe cards, detail back-navigation. **Matching engine (Phase 7, production — matcher v2)**: deterministic, explainable 12-dimension matcher (goal/eligibility, role, education, skills, experience, languages, location, relocation, remote, employment, training type, preferences) with `complete`/`incomplete`/`unavailable` states, structured per-dimension evidence incl. candidate/opportunity quotes, weighted transparent scoring (renormalized over evaluated dimensions only), provenance-aware confidence (inferred data never scores as a full match), a hard cap on explicitly incompatible education, saved-snapshot provenance with staleness detection, search/detail/dashboard integration, and "Match unvollständig" UX. **Application prefill (Phase 6)**: "Prepare application" from the detail page or saved cards → server re-resolves the opportunity from the source, prefills the composer from documented fields only (subject, body, validated contact email as recipient), and persists the opportunity context on the draft (blank draft updated in place; non-blank draft kept untouched with a new pre-filled draft created). |

## Not implemented (Roadmap)

- Automatic applications from saved opportunities (explicitly out of scope so far — every email is composed and sent by the user).
- Additional vacancy providers (only the Bundesagentur für Arbeit is wired up).
- Payments, billing, and multi-tenant admin.
- CI and deployment pipelines (unit test suite exists: `npm test`).

## Tech stack

- **Framework:** Next.js 16 (App Router) + TypeScript (strict)
- **Styling:** Tailwind CSS v4
- **Backend/database:** Supabase (Postgres, Auth, Storage, RLS)
- **Email:** Google OAuth (Gmail API) and Microsoft OAuth (Graph API)
- **AI:** any OpenAI-compatible provider (configurable base URL/model), provider abstraction in `src/lib/ai-provider.ts`
- **External data:** Bundesagentur für Arbeit Jobsuche API (public client ID `jobboerse-jobsuche`)
- **Validation:** Zod (all AI output and all search parameters are strictly validated server-side)

## Project structure

```
src/
  app/
    ai/                    # AI assistant (page, actions, chat component)
    applications/
      new/                 # composer (rich text, recipients, attachments, autosave)
      campaign/[id]/       # campaign monitor
    bewerbung-scanner/     # scanner upload + results
    dashboard/
    login/  register/  verify/  onboarding/
     opportunities/         # search, detail, saved
    settings/
      email/               # OAuth account connection management
      usage/               # quota + AI usage overview
    api/
      ai/                  # chat (streaming), conversations, files, generated files
      bewerbung-scanner/   # files, scan, results
      email/               # OAuth connect + callback
      internal/email-worker/ # worker endpoint (EMAIL_WORKER_SECRET)
       opportunities/       # search + save (server-derived saves)
  components/              # UI components (server + client)
  lib/
    ai-provider.ts         # OpenAI-compatible client (server-only key)
    ai-service.ts          # prompt + output validation
    ai-file-context.ts     # untrusted document input handling
    auth.ts                # session helpers
    bewerbung-scanner.ts   # scan pipeline
    bewerbung-schema.ts    # strict candidate profile schema
    dashboard.ts           # dashboard queries
    email-campaigns.ts     # quota reservation, claims, retries
    email-crypto.ts        # AES-256-GCM token encryption
    email-oauth.ts         # Google + Microsoft OAuth flows
    email-providers.ts     # provider adapters
    oauth-state.ts         # signed OAuth state
      opportunities/         # types, search, BA provider, saved
        matching/            # matching engine v2 (types, normalizer, dimensions, scorer, explanations)
    supabase/              # server/client/service-role clients
  proxy.ts                 # session refresh middleware
tests/
  opportunities/           # provider, cache, saved-opportunities, search-UX, and matching unit tests
supabase/
  config.toml
  migrations/              # 10 SQL migrations (see below)
```

## Getting started

### 1. Prerequisites

- Node.js 20+
- A Supabase project (Postgres + Auth + Storage)
- A Google Cloud OAuth client (for Gmail)
- A Microsoft Entra ID app registration (for Outlook)
- An OpenAI-compatible AI API key

### 2. Install

```bash
npm install
cp .env.example .env.local   # then fill in every value
```

### 3. Supabase setup

Run the migrations in order (they are self-contained):

```
20250512000000_auth_foundation.sql
20260927000000_dashboard_foundation.sql
20260927010000_email_accounts.sql
20260927020000_application_composer.sql
20260927030000_email_sending_engine.sql
20260927040000_ai_assistant.sql
20260927050000_bewerbung_scanner.sql
 20260927060000_opportunities.sql
 20260928000000_opportunities_phase2.sql   # cache schema versioning + saved snapshot fields
  20260929000000_opportunities_matching_v2.sql  # saved_at match snapshot status (complete/incomplete)
  20260930000000_application_prefill.sql        # draft opportunity-context columns (Phase 6)
  20260931000000_match_snapshot_metadata.sql    # snapshot provenance: matcher_version + profile revision (Phase 7)
```

Via the CLI: `npx supabase db push` (or paste into the SQL editor). The migrations create all tables, RLS policies, storage buckets, triggers, and the invitation seeds.

Create the two private storage buckets if not created by a migration: `application-attachments` and `ai-files` (both **private**, `user_id`-scoped policies).

### 4. Environment variables

| Variable                                          | Where used       | Notes                                                                 |
| ------------------------------------------------- | ---------------- | --------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`                        | browser + server | project URL                                                           |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`                   | browser          | publishable key; RLS is the security boundary                         |
| `SUPABASE_SERVICE_ROLE_KEY`                       | server only      | bypasses RLS — never send to browser                                  |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`       | server           | OAuth client with `gmail.send` scope                                  |
| `GOOGLE_REDIRECT_URI`                             | server           | e.g. `http://localhost:3000/api/email/callback/gmail`                 |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` | server           | Graph app with `Mail.Send`                                            |
| `MICROSOFT_REDIRECT_URI`                          | server           | e.g. `http://localhost:3000/api/email/callback/outlook`               |
| `EMAIL_TOKEN_ENCRYPTION_KEY`                      | server           | long random secret (AES-256-GCM key) for OAuth token encryption       |
| `EMAIL_WORKER_SECRET`                             | server           | shared secret for the external email worker endpoint                  |
| `AI_API_KEY`                                      | server           | OpenAI-compatible key                                                 |
| `AI_API_URL`                                      | server           | e.g. `https://api.openai.com/v1`                                      |
| `AI_MODEL` / `AI_VISION_MODEL`                    | server           | text + vision model names                                             |
| `AI_PROVIDER`                                     | server           | provider label (default `custom`)                                     |
| `ARBEITSAGENTUR_API_KEY`                          | server           | BA Jobsuche client ID; documented public default `jobboerse-jobsuche` |

### 5. Run

```bash
npm run dev        # development server
npm run build      # production build
npm run start      # serve the production build
npm test           # vitest unit tests (provider, cache, saved, search UX, matching, prefill)
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
npm run format     # prettier --write .
```

## How the key systems work

### Quota model (atomic, no race conditions)

- Registration with `DRIF928` creates a profile with 0 daily emails; `DRIF089` creates one with 100/day and records a `user_quota_upgrades` row.
- Each send campaign **reserves** quota with `FOR UPDATE` on the user's `daily_usage` row; the reservation is released if the campaign fails to be created. There is no read-then-write race.
- The worker endpoint (`/api/internal/email-worker`) claims messages with `FOR UPDATE SKIP LOCKED`, so multiple workers never double-send. Retries are bounded; Microsoft calls use `Idempotency-Key` to stay safe on retry.
- **Requirement:** the worker endpoint is passive — it processes messages when called. For production you need a durable trigger (cron, queue, or always-on service) that calls it periodically. This is the main known gap for unattended sending.

### AI usage

- One shared `daily_usage.ai_requests` counter, capped at 100/day, reserved atomically before any AI call (assistant, scanner). AI failures do not permanently burn quota; the reservation is released on error.

### Opportunities search (Phase 3)

The search is built around what the BA REST API actually supports, and never pretends otherwise. Two retrieval modes:

- **`upstream`** — true provider pagination. Used for the plain case (goal, keyword, location/radius, `today` freshness, relevance order). The API is asked for exactly one page per request and `total` is the source's own `maxErgebnisse`.
- **`scan`** — a bounded server-side window (≤ 10 pages × 50 items = 500 listings). Used whenever the request needs a capability the API cannot express: role/company post-filters, `14d`/`30d` freshness, non-relevance sorting, or employment/training-type/home-office/salary/distance filters. The full window is collected **before** filtering/sorting (so the order isn't biased by where a page happens to fall), deduped by stable id, and cached page-independently — turning pages never re-hits the provider. If the 500-item budget ends before the source does, the response is marked `scan_truncated` and the UI says so instead of hiding it.

**Filters** are only offered when backed by real provider data. The BA parameters that were verified non-functional (`arbeitszeit` remote, `beruf` role, `arbeitgeber` company) are **never sent** to the API; role/company are applied server-side on the source's occupation fields, and home-office/employment on the source's flags. Home-office and training-type filters are Ausbildung-only (the source does not document them on job postings); requesting them for Arbeit returns a clear 400. Distance sort / max-distance require a location (400 otherwise).

**Sorting** is deterministic and null-safe: `relevance` = source order; `newest`/`oldest` by source `posted_at`; `salary` by the source's numeric amount; `distance` by the source's km; `match` by the user's per-user match (see below: complete matches by score descending, incomplete matches after all complete ones — unknown data is never ranked as a perfect match; falls back to relevance when no match is requested or no profile exists). Items missing the sort field sort **last** (never a guessed value), ties broken by stable id.

**Pagination** respects the source's ~10,000-item bound: `page` ≤ 200 and `pageSize` ≤ 50 (200 × 50 = 10,000). Beyond that the API returns empty pages, so the UI shows a "source bound reached" message rather than faking deeper results.

**Freshness** is explicit: `today` is applied by the API itself (`veroeffentlichtseit=1`); `14d`/`30d` are applied server-side on the source's publication date within the scan window; everything else is `any`. Undated listings are excluded from date filters (never guessed).

**Shareable URL state** is a strict whitelist (`goal`, `q`, `role`, `company`, `location`, `radius`, `freshness`, `sort`, `employment`, `training_type`, `home_office`, `salary`, `distance_max`, `page`, `match`). Anything else — including anything resembling an id or token — is dropped; `q` maps to keyword; invalid values normalize to defaults; a missing/invalid `goal` drops the whole state. URL state is only ever used for **filtering**, never for authorization. Detail pages carry a `from` param so "back" returns to the exact search (same filters + page).

**Cache + matching independence** (enforced, tested): the `opportunity_cache` key is fully user-independent (schema version + mode + hash of the provider query; `match` excluded) and stores only normalized source data (a `window` with `match: null`, `total`, `scan_truncated`, `exhausted`). The per-user match is computed **after** the cache read, attached in-memory only, and never written back — two users searching the same query share one source row and no user data can leak between them.

### Matching Engine (production, Phase 7 — matcher v2)

`src/lib/opportunities/matching/` — a deterministic, explainable, **server-side** matcher that compares the authenticated user's **validated** candidate profile (from the Bewerbung Scanner) against the authoritative, server-re-resolved opportunity. Pure function: same profile + same opportunity = same result; no AI, no LLM-generated reasons, no network, no randomness, no wall clock (experience year math references the opportunity's fixed `retrieved_at`). The engine never invents candidate facts, opportunity facts, requirements, or reasons.

**Architecture:** `candidate profile → normalize → evaluate dimensions → calculate evidence → calculate score → classify match → return explanation`. Modules: `types.ts` (result shape + documented weights), `text.ts` (umlaut-folding normalization, CEFR, language synonyms, dates, "N Jahre" extraction), `profile-normalizer.ts` (validated profile → normalized candidate with per-field provenance), `dimensions.ts` (twelve independent evaluators), `scorer.ts` (inferred cap, completeness, weighted score, hard cap), `explanations.ts` (German UI labels), `index.ts` (`computeMatch` / `matchOpportunity` / `applyMatch`).

**Dimensions** (each yields `match` / `partial` / `mismatch` / `unknown` / `not_applicable`, plus factual German evidence, a missing-information list, and short raw quotes of the documented **candidate-side** and **opportunity-side** values — `null` when a side documents nothing, never invented):

| Dimension             | Weight | Semantics (documented in code)                                                                                                                                                                                                                                                                                 |
| --------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Goal / eligibility    | 18%    | **Essential.** Candidate goal vs opportunity type (Ausbildung eligibility). Conflicts are a real `mismatch` — never silently converted.                                                                                                                                                                        |
| Role                  | 20%    | **Essential.** Target roles / preferred titles vs title, `hauptberuf`, alternative professions. Deterministic token matching (full-phrase, containment, ≥50% shared content tokens). No semantic similarity is claimed.                                                                                        |
| Education requirement | 20%    | **Essential for Ausbildung.** German school hierarchy (`basic < intermediate < advanced < university`); a documented higher qualification satisfies a lower documented requirement. Unclassifiable source requirement → `unknown` (fail-safe). Explicitly contradictory requirement hard-caps the score at 30. |
| Skills                | 14%    | Required vs preferred, separated. Missing candidate info is never a negative; no documented requirement → `not_applicable`.                                                                                                                                                                                    |
| Experience            | 9%     | Only explicitly documented "N Jahre Erfahrung" statements; documented years computed from dates vs the record's `retrieved_at` (deterministic). No years are ever inferred.                                                                                                                                    |
| Languages             | 9%     | CEFR A1–C2 comparison (higher satisfies lower; native ≈ C2). Inferred levels stay inferred. A **required** language (e.g. German) missing from the profile → `unknown` → incomplete (not a negative).                                                                                                          |
| Location              | 4%     | Documented location identity only: same documented location → `match`; no candidate location → `unknown`. A documented **difference** is deliberately delegated to the relocation dimension (not penalized here).                                                                                              |
| Relocation preference | 2%     | Only when a move is required (documented different locations): willing → `partial` (generic willingness, not city-specific), unwilling → `mismatch`, **unknown → `unknown`, never incompatible**. No move required → `not_applicable`.                                                                         |
| Remote / home office  | 1%     | Only when the source documents home office; missing → `not_applicable`/`unknown`, never incompatible.                                                                                                                                                                                                          |
| Employment type       | 1%     | The profile schema documents no working-time preference → always `unknown` when the source documents a type (honest, not guessed).                                                                                                                                                                             |
| Training type         | 1%     | The source documents the Ausbildungsform (e.g. `AUSBILDUNG`, `DUALES_STUDIUM`); the profile schema has no training-type preference field → `unknown` (non-essential, never blocking) when documented, `not_applicable` otherwise.                                                                              |
| User preferences      | 1%     | Candidate industry preferences vs the opportunity's industry. The BA source documents **no industry field** → `unknown` (non-essential) when the candidate documents preferences, `not_applicable` otherwise.                                                                                                  |

**Result states** (`MatchResult`): `complete` (every essential dimension evaluated → integer score 0–100), `incomplete` (a profile exists but an essential dimension is `unknown` → **no score is produced**; UI shows "Match unvollständig" and lists exactly what is missing — e.g. education, German language level, location preference), `unavailable` (no candidate profile → no score, no dimensions). Essentiality is per (profile, opportunity): goal + role always; education for Ausbildung; languages when the source documents a requirement. Missing information is **never** converted into a fake positive or negative — `unknown` contributes 0 to nothing and is surfaced in `missing_information`.

**Scoring:** weighted contributions (`match` = 1, `partial` = 0.5, `mismatch` = 0), **renormalized over the evaluated dimensions only** — missing dimensions neither inflate nor destroy the score. **Inferred-data cap:** any dimension whose candidate-side evidence is AI-extracted (not user-confirmed) is capped at `partial`, with a provenance note — inferred information is never scored as confidently as explicit information. **Hard cap:** an explicitly documented, explicitly contradictory education requirement caps the score at 30. Every `reasons` line is a factual evidence sentence from the data — no generated marketing copy.

**Saved match snapshots + staleness (migration 12):** saving an opportunity stores a **server-computed** saved-at snapshot: `match_score` + `match_status` (migration 9/10) **plus** `matcher_version` (engine version) and `match_profile_updated_at` (profile revision at snapshot time). This lets the UI distinguish three states that are never conflated: **current match** (always recomputed live, server-side, on the detail page), **historical snapshot** (the stored values, labeled with their "Stand" date and matcher version), and **incomplete snapshot** (no score — never a guess). If the profile's current revision is newer than `match_profile_updated_at`, or the engine version advanced, the saved page and detail page explicitly state the snapshot may be stale — a profile change never masquerades silently as current data.

**Integration:**

- **Search** (`/opportunities` with matching enabled): the per-user match is computed **after** the shared-cache read and attached in-memory only — cards show score + short reason when complete, or the incomplete state with the top missing facts when data is insufficient. `sort=match` ranks complete matches by score (incomplete ones never ranked as matches). The cache key and cache content remain **user-independent** (tested).
- **Detail page** (`/opportunities/[id]`): overall match state, score only when valid, dimension-by-dimension explanation with status icons, evidence sentences, candidate/opportunity quotes, consolidated missing information, and — when the opportunity is saved — the labeled historical snapshot with staleness reasons.
- **Saved page** (`/opportunities/saved`): per-card snapshot with "Stand" date, matcher version, and an explicit "Snapshot veraltet" badge + factual reasons when the profile or engine changed since.
- **Dashboard**: a safe matching summary — saved/complete/incomplete counts and the top 3 **complete** snapshots (historical, labeled as such). Without a candidate profile it shows a warning instead of a fake ranking.

### Application prefill (Phase 6)

`src/lib/opportunity-prefill.ts` — server-side prefill that carries an opportunity into the application composer. "Prepare application" is linked from the opportunity detail page and from every saved-opportunity card; both point to `/applications/new?opp=<key>` where the key is the URL-encoded opportunity id (`<provider>:<reference>`).

**Flow** (entirely server-side; the browser only ever submits the key): authenticated user required → the key is validated against the provider schema **before any network call** → the opportunity is **re-resolved from the authoritative BA source** (never from URL/browser data, never from the cache) → `buildOpportunityPrefill` derives subject and body from **documented fields only** (profession, company, location, reference — missing fields drop out, nothing is invented) → applied to the user's draft per the strategy below.

**Prefill content:** subject is `Bewerbung um einen Ausbildungsplatz als <Beruf> (Referenz <nr>)` (Ausbildung) or `Bewerbung als <Beruf> (Referenz <nr>)` (Arbeit), with factual generic fallbacks when profession or reference is undocumented; the body is a short, neutral German cover-letter skeleton in which every interpolated source string is HTML-escaped. **Recipient derivation:** the opportunity's contact email is pre-filled **only when documented by the source and it passes the same validation as manually added recipients**; otherwise the draft opens without a recipient and the user adds one.

**Draft selection strategy** (never destroys work):

- active draft is **blank** (no subject/body, no recipients, no attachments) → the prefill is written into it **in place**;
- active draft has **content** → a **new pre-filled draft** is created and becomes the active one; the previous draft is kept untouched, and a notice explains this to the user.

**Persistence (migration 11):** four nullable context columns on `application_drafts` (`opportunity_key`, `opportunity_title`, `opportunity_company`, `opportunity_source_url`) record which opportunity a draft was pre-filled from. They are display/context only — subject, body and recipients remain fully user-editable — and the composer shows a "prepared from" card with a link back to the opportunity detail. RLS is unchanged: the existing user-scoped draft policy already covers the new columns.

**Failure modes:** malformed or foreign key → `invalid_key` (no network call, no database write); the source no longer lists the vacancy (e.g. `STELLENANGEBOT_NICHT_GEFUNDEN`) → `unavailable` with a clear German error, no draft write.

### Dashboard Intelligence & Workflow (Phase 8)

`/dashboard` is the application command center: every section is server-derived, every empty case shows an explicit empty state instead of a misleading zero, and one **recommended next action** tells the user what to do immediately.

**Profile completeness** (`src/lib/dashboard-intelligence.ts`, pure & deterministic — no AI): the latest **validated** candidate profile is scored over 12 documented sections: Name, Location, Education, German language level (a German entry _with_ a documented level), Other languages, Skills, Experience, Certifications, Target roles, Goal, Location preferences, Relocation preference. Null/empty values never count as completed; the result is `{percentage, completed[], missing[]}`. The UI shows the percentage, missing chips, and documented chips.

**Next action** (deterministic priority chain — first matching rule wins, no LLM):

1. no profile → **Scan your Bewerbung** (`/bewerbung-scanner`)
2. important sections missing (Name, Education, German level, Target roles) → **Complete your profile**
3. nothing saved → **Find suitable opportunities** (`/opportunities`)
4. saved, no application draft → **Prepare your application** (`/applications/new`) when a complete match exists, otherwise **Review your matches**
5. draft, no connected email → **Connect your email** (`/settings/email`)
6. campaign `draft` → **Review and send** (campaign page); `queued`/`sending` → **Track sending**; `completed`/`partially_failed` → **Track sent**; `failed`/`cancelled` → continue exploring

**Recommended opportunities** (server-side layer, no new scoring): the existing search (`goal`, keyword from the profile's first documented preferred title/target role, location from the first documented preference) + existing matcher v2 ranking (`sort=match`). Items carry title, company, location, Ausbildung/Arbeit, match status/score, one evidence-based reason (or "Match incomplete" with the top missing fact), posted date, and salary **only when documented**. View / Save / Prepare-application actions reuse the existing flows. If no keyword is documented or the source is unavailable, the section shows a factual empty state — **nothing is ever invented**. User-specific matching stays outside the shared cache (unchanged, tested).

**Recent applications**: the user's last 5 composer drafts joined with persisted `email_campaigns` / `email_messages` rows — company (opportunity context or validated recipient), draft/campaign status, created + sent dates. Links open the draft (`/applications/new`), the campaign (`/applications/campaign/[id]`), and the linked opportunity when a context exists. No synthetic records.

**Saved preview**: last 5 saved opportunities with snapshot score, "Stand" date, and the Phase 7 **stale indicator** (profile revision or matcher version newer than the snapshot → flagged, never silently current).

**Usage & AI status**: email usage comes from the server-side quota RPC (`getUsageSnapshot` — reserved + sent, quota upgrades included); AI usage uses the shared `AI_DAILY_REQUEST_LIMIT` constant (single source of truth with the quota RPCs). No quota logic is duplicated, no browser-provided values are trusted.

**Activity**: existing `activity_logs` system, now also logging `opportunity_saved` / `opportunity_removed` (best-effort — a failed audit insert never fails the user action). No sensitive content is logged.

**Performance**: all dashboard reads run in parallel batches; the recommendation search is one bounded window (6 items) reusing the shared user-independent cache; no per-opportunity provider calls.

**Navigation** (all authenticated, all real routes): Scan `/bewerbung-scanner` · Find `/opportunities` · AI `/ai` · Saved `/opportunities/saved` · Email `/settings/email` · Usage `/settings/usage` · New application `/applications/new` · Campaign `/applications/campaign/[id]` · Opportunity `/opportunities/[id]`.

### Security model

- **RLS** on every user table; the app only ever uses the service role for server-side writes that RLS would block (quota counters, encrypted tokens).
- **OAuth tokens** are stored AES-256-GCM encrypted; the encryption key lives in `process.env` only.
- **Server-only imports** (`server-only`) guard every file that touches the service role, AI keys, or OAuth secrets.
- **AI output** is treated as untrusted: every response is parsed against strict Zod schemas before it is stored or rendered; user documents are injected as untrusted data in the prompt.
- **Attachments** go to private storage buckets scoped by `user_id`; the browser only ever sees opaque upload IDs.
- **Application prefill** is derived exclusively from the server-side validated source: the browser never supplies recipient, company, title, salary, or `user_id`; the opportunity key is validated before any provider request and the opportunity is re-resolved server-side on every prefill.
- **Matching engine** is fully server-derived: the browser never supplies `user_id`, the candidate profile, an opportunity snapshot, a score, or reasons. The user id comes from the authenticated session, the profile from the user's own `candidate_profiles` row (RLS + `user_id`-scoped reads), and the opportunity from the authoritative provider (re-resolved, never from URL data). Match results are never written to the shared opportunity cache (user-independent key + `match: null` window — tested), and per-user snapshots live only in the user-scoped `saved_opportunities` rows. The save API accepts only `opportunityKey` + `notes` (strict schema; injected scores/titles are rejected — tested).

## Known limitations

1. **Email sending needs a durable worker** (see above) — in development, call the worker endpoint manually or via a local cron.
2. **Opportunities search UX (Phase 3), the production matching engine (Phase 7, building on Phase 5), application prefill (Phase 6), and the Phase 8 dashboard intelligence are complete** — Step 9 of the roadmap is done and the end-to-end workflow (profile → search → matching → saved → prefill → composer → campaign → email) is connected through the dashboard. The BA API surface that works was live-verified: `v6/jobs` search, `v4/jobdetails`, `wo`/`umkreis`/`was`/`angebotsart`, and `veroeffentlichtseit=1` (today). The REST API does **not** support remote (`arbeitszeit`), free-text role (`beruf`), or company (`arbeitgeber`) filters — those are applied server-side on the normalized source data via a bounded scan (surfaced as `scan_truncated`). The source also only exposes its first ~10,000 listings per query (deeper `page*size` return empty pages), so pagination is capped at 200 pages × 50 items and the bound is surfaced instead of faked.
3. **Source data limits what the matcher can verify (never faked).** The BA source does not today provide structured skills or language requirements, so those dimensions are usually `not_applicable` and drop out of the score (renormalized). The candidate profile schema has no working-time preference field, so the employment dimension is always `unknown`. The BA source documents **no industry field**, so the user-preferences dimension is `unknown` (non-essential) when the candidate documents industry preferences and `not_applicable` otherwise. The profile schema has **no training-type preference** field, so the training-type dimension is `unknown` (non-essential) for offers where the source documents an Ausbildungsform. Experience is only compared when the source explicitly states "N Jahre Erfahrung". Relocation willingness is documented generically (not per city), so a willing profile yields `partial` — never a full match. The remote preference is free text and parsed with a documented heuristic. All of this is surfaced in the result's missing-information list instead of guessed.
4. BA job references expire — saved opportunities keep a server-derived snapshot so they remain useful; the detail page shows a clear "no longer available" state for stale refs.
5. No CI or deployment configuration yet (unit test suite exists: `npm test`).
6. Only one vacancy provider (Bundesagentur für Arbeit).
7. Quota upgrades are invitation-code based only; no self-serve billing.
