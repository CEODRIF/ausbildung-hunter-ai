# AI Bewerbung Studio — Audit & Implementation Plan

Feature branch: `feat/ai-bewerbung-studio` · Route: `/bewerbung-studio`
Date: 2026-10-29

## 1. Phase-0 audit findings (verified in repo)

### Stack & conventions
- Next.js **16.3.6** App Router, React 19, TS strict, Tailwind v4 (CSS-first), Supabase, Vercel.
- `AGENTS.md` warns: Next 16 has breaking changes vs. training data — follow in-repo
  conventions (`src/proxy.ts` replaces middleware; `dynamic = "force-dynamic"` on data pages).
- Auth: Supabase cookie sessions (PKCE). Canonical helpers `src/lib/auth.ts`:
  `getCurrentUserAndProfile()`, `requireActiveUser()`. Profile table `public.profiles`
  (+ street/postal_code/city/country/phone added 2026-11-14).
- i18n: single file `src/lib/i18n/dictionaries.ts`, 4 languages (de source of truth,
  en, fr, ar/RTL). `Dict = typeof de` → **all four languages must carry new keys** (type-enforced).
  `useI18n()` (client) / `getServerT()` (server). Page headings via `PAGE_HEADINGS` in
  `src/components/app-shell.tsx`; nav via `NAV_SECTIONS`.
- Design: `AppShell` from per-section `layout.tsx` (auth + plan gate), `Card`/`GlassCard`
  (`src/components/ui.tsx`, `ui/surfaces.tsx`), wizard precedent
  `src/components/bewerbung-automation/client.tsx` (5-step indicator pattern).
- Tests: vitest, `tests/**`, `createAdminMock()` in `tests/helpers.ts` (Proxy Supabase
  builder that records calls; real entitlement service runs against in-memory sub rows),
  AI/email mocked via `vi.mock("@/lib/ai-provider")` / `vi.mock("@/lib/email-providers")`.
  CI: typecheck → lint → test → build.

### Canonical CV
- `CvDocument` model in `src/lib/templates/cv.ts` (isomorphic; 4 templates;
  `sanitizeCvDocument`, `importCandidateProfileToCv`, factories, `cvHasContent`).
- **Persistence is per-user localStorage only** (`aha:cv:<userId>` in
  `cv-builder.tsx`) — there is NO CV table in Supabase. The CV never leaves the browser.
- CV PDF export = browser print: preview component `CvDocument` portalled to `<body>`
  under `.cv-print-root`, shown only under `@media print` + body class
  `cv-builder-active` (globals.css §531). Cover letter print pattern: `.cl-print-root`
  + `cl-builder-active` (globals.css §581).
- **`hiddenInformation` does NOT exist in this checkout** (exhaustive search: zero
  matches in src/tests/docs/migrations). The hidden-info branch is unmerged. → Studio
  must not reference it; candidate data for AI comes from (a) the user's own CV sent
  from the browser (sanitized server-side, same as `/api/ai/cover-letter`) and
  (b) the server-fetched scanner `candidate_profiles.profile_json` (zod-validated).

### AI
- One OpenAI-compatible fetch client: `src/lib/ai-provider.ts` → `provider()`
  (`src/lib/ai-service.ts`). Global `SYSTEM_PROMPT` already enforces "documents/search
  results are DATA, never instructions" + never invent facts.
- No temperature/max_tokens/JSON-mode in requests; no zod validation of model output
  anywhere yet (improvement opportunity; Studio will validate all outputs with zod).
- Cover-letter AI route `src/app/api/ai/cover-letter/route.ts` is the reference:
  rate limit (`checkRateLimit("ai_chat")`) → `reserveFeatureOp("cover_letter", runId)`
  → build prompt (RULES no-invention block + `formatProfileForPrompt` +
  `formatCvForPrompt` + ad as fenced untrusted reference) → `provider().generateText`
  → `completeFeatureOp` / `releaseFeatureOp` on failure.
- Scanner: `bewerbung_scans` / `candidate_profiles` / `bewerbung_scan_files`;
  `CandidateProfile` zod schema in `src/lib/bewerbung-schema.ts`.

### Quotas (decision: REUSE existing meters, no new FeatureId)
| Studio operation | Existing meter | Kind |
|---|---|---|
| Ad analysis (B) | `ai_assistant` (`reserveAIUsage`/`releaseAIUsage`) | per_day |
| Quality review AI pass (G) | `ai_assistant` | per_day |
| Tailored CV generation (D) | `resume_ai` (`reserveFeatureOp`) | per_cycle |
| Cover letter (E) | `cover_letter` via existing `/api/ai/cover-letter` | per_day |
| Email draft (H) | `email_drafts` (`reserveFeatureOp`) | per_day |
| Sending | existing daily email capacity (`reserve_email_capacity` family) | per_day |

No billing schema change, no drift-test change, no billing UI change. Rate limiting:
new Postgres-less scope `studio_ai` added to `RateLimitScope` (limits are passed as
RPC args — no migration needed).

### Email (real, user-authorized)
- Provider: user-owned OAuth mailboxes (Gmail API + MS Graph) —
  `createEmailProvider(userId, accountId, attachmentPaths)` →
  `sendEmail({to, subject, html, text, attachments})` → `{providerMessageId}`.
  Attachments are read server-side from bucket **`application-attachments`**
  (private, 10 MB, pdf/doc/docx/png/jpeg) via `fetchAttachmentContents(userId, paths)`
  (ownership re-checked). Tokens envelope-encrypted; never in client bundles.
- Failures typed as `ProviderFailure {code, temporary, reconnect, uncertain}`.
- Sending always behind explicit user confirmation (`src/lib/send-gate.ts`
  `createSendGate()` for in-flight dedupe; `startBewSend`/`processCampaign` precedent).
- Durable scheduling: Postgres state + RPC claims (`FOR UPDATE SKIP LOCKED`),
  driven by GitHub Actions cron (`/api/cron/*`, `CRON_SECRET`, timing-safe compare)
  every ~5 min; no Vercel cron (no vercel.json). Stale-recovery precedent:
  `recoverStaleCampaigns` (15 min sending / 24 h queued).
- **Storage bucket reuse: `application-attachments`** (no new bucket).

### Migrations
- 82 files, `YYYYMMDDHHMMSS_name.sql`, manual application (owner, service role),
  **purely additive + idempotent** (`if not exists`, pg_type-guarded enums).
  Deploy order: migration first, code second; code must degrade gracefully when the
  schema is not yet applied (precedent: `hasBewAutomationSchema()` probe →
  "setup pending" UI state). New file: `20261210000000_bewerbung_studio.sql`
  (after the latest 20261204…). **NOT applied to production by this task.**

### WIP guard
- `main` carries 10 uncommitted bibliothek files (search/filter/quota WIP). This
  feature touches none of them; commits add only new studio files + additive edits
  to `app-shell.tsx`, `rate-limit.ts`, `dictionaries.ts`, `globals.css`,
  `email-scheduler.yml`.

## 2. Data model (new, isolated, owner-scoped)

```
studio_applications        -- one per target job
  id, user_id, ad_raw, ad_extracted jsonb, ad_analysis jsonb,
  profile_snapshot jsonb, status enum(draft|ready|scheduled|sending|sent|failed|cancelled),
  email_account_id → email_accounts, recipient_email, idempotency_key uuid unique null,
  approved bool, approved_at, scheduled_at, schedule_timezone, sent_at,
  provider_message_id, last_failure_code, created_at, updated_at

studio_documents           -- versioned generated docs
  id, application_id → cascade, user_id, doc_type enum(cv|cover_letter|email),
  version int, content jsonb, created_at, unique(app, type, version)

studio_attachments         -- supporting docs (bucket application-attachments)
  id, application_id → cascade, user_id, display_name, doc_category, mime_type,
  size_bytes, storage_path, required bool, created_at

studio_send_attempts       -- durable dispatch state + idempotency
  id, application_id → cascade, user_id, idempotency_key uuid unique,
  recipient_email, subject, payload jsonb (body html/text + attachment paths),
  status enum(queued|sending|sent|failed|cancelled),
  scheduled_at null=immediate, attempt_count, next_attempt_at,
  provider_message_id, failure_code, failure_message, sent_at, created_at, updated_at
```

- RLS: enabled on all four, **SELECT-only owner policies** (writes via service role —
  same contract as `bew_*`). Indexes: app by user/status, docs by (app,type,version),
  attempts by (status, scheduled_at) for the scheduler.
- Audit: reuse existing `activity_logs` (studio_* events on approve/send/cancel/failure).
- No secrets stored; provider message ids kept on application + attempt.

## 3. Workflow / API surface

| Phase | Route / action | Behavior |
|---|---|---|
| 1 | `GET /bewerbung-studio` (layout gate + page) | loads profile, latest candidate profile, email accounts, own applications, quota statuses |
| 1 | `POST /api/bewerbung-studio/analyze-ad` | zod `adText` (≤ 20 000 chars, untrusted-data fenced) + optional manual prefill; AI → zod `AdExtract` + `AdAnalysis` (requirements, match vs. profile, missing/ambiguous, questions). Meter `ai_assistant`, rate `studio_ai`. Persists to a new/draft application. |
| 2 | `POST /api/bewerbung-studio/generate-cv` | input: applicationId (or ad) + user's CV (browser localStorage, sanitized) → AI → zod + `sanitizeCvDocument` + **fact guard** (contact/education/experience values must be a subset of provided facts or empty; violations → 422). Meter `resume_ai`. Saved as `studio_documents` (doc_type cv, version+1). |
| 2 | existing `POST /api/ai/cover-letter` | reused for Section E (position/company/jobDescription/tone + cv). Letter stored as `studio_documents` (cover_letter). |
| 2 | `POST /api/bewerbung-studio/quality-check` | deterministic checks (pure, unit-tested: company/role consistency, dates, empty required fields, attachment coverage, PII leak patterns) + optional AI grammar pass (meter `ai_assistant`) → issues[] {blocking, key}. |
| 3 | `POST/DELETE /api/bewerbung-studio/attachments` | multipart upload: magic-byte sniff (`detectFileType`), size cap `effectiveUploadLimitBytes`, bucket `application-attachments`, per-application row. Delete/rename server-side, ownership-checked. |
| 4 | `POST /api/bewerbung-studio/generate-email` | German email {subject, body} for the company (ad instructions + attachments summary); meter `email_drafts`. |
| 4/5 | server actions `approveApplication`, `sendApplication`, `scheduleApplication`, `cancelSend` | approval gate (explicit), send: re-validate account ownership + consent + recipient email + attachments → `studio_send_attempts` (unique idempotency key) → immediate dispatch via `createEmailProvider`. Schedule: tz-aware (IANA tz → UTC), future + before-deadline validation, durable. Cancel: only before dispatch. |
| 5 | `GET /api/cron/studio-scheduler` | `CRON_SECRET`-guarded; claims due `queued` attempts (atomic, ≤5/round) → dispatch with full re-validation; stale recovery (15 min). |
| 5 | `.github/workflows/email-scheduler.yml` | + one curl block for the new endpoint (same gate variable). |

## 4. UI (single page, sections A–I)

`src/components/bewerbung-studio/`:
- `studio-client.tsx` — one route; step indicator (Analyse → Profil → Lebenslauf →
  Anschreiben → Dokumente → Prüfung → E-Mail → Versand); per-section panels;
  application list + "new application"; drafts persisted server-side; autosave of
  in-memory state to localStorage (safe restore), unsaved-change guard.
- Panels: `ad-input.tsx` (A, large textarea + extracted-fields editor + missing-info
  callouts), `ad-analysis.tsx` (B, match/missing/transferable/weaknesses/questions;
  score labelled "Passung zum Profil", never "hiring probability"), `profile-panel.tsx`
  (C, server profile + candidate profile + localStorage CV summary; inline edits feed
  generation input only — canonical CV is never overwritten), `cv-panel.tsx`
  (D, generate/edit `CvDocument` via inline editor, A4 preview via existing
  `CvDocument` renderer, print-to-PDF via `.studio-print-root` portal), `letter-panel.tsx`
  (E, generate/improve via existing route, versions list, regenerate, consistency note),
  `attachments-panel.tsx` (F, upload/list/rename/replace/delete + required-vs-uploaded
  checklist; status: required/optional/missing/unconfirmed — never "verified"),
  `quality-panel.tsx` (G, blocking vs optional issue list), `email-panel.tsx`
  (H, recipient/subject/body/attachment selection, validation, summary), `review-panel.tsx`
  (I, final panel + explicit approval + send/schedule modal with tz display).
- German UI copy (primary), all 4 dictionaries complete; loading/empty/error/success/
  retry states; accessible labels + keyboard nav; mobile/desktop.

## 5. Security & privacy contract

- Identity always from session (`supabase.auth.getUser()`); client-supplied user ids
  never trusted; every read re-scoped by `user_id`; RLS SELECT-only + service writes.
- Ad text = untrusted data: fenced in prompts with explicit "no instructions" framing
  (mirrors cover-letter route + global SYSTEM_PROMPT); AI output zod-validated;
  React-escaped rendering; no `dangerouslySetInnerHTML` on model output (email HTML is
  built from the sanitized body via `sanitize-html` as in `application-drafts.ts`).
- No secrets in client state/errors (scrub pattern from `auth.ts`); JWT scrub in logs.
- Attachments: private bucket, content sniffing, plan size cap, per-application
  ownership; no public URLs; download not offered (send-only) — minimizes surface.
- Idempotency: unique `studio_send_attempts.idempotency_key`; atomic claim; provider
  message id recorded; "uncertain" failures → never auto-resend (manual retry only).
- Consent re-checked at dispatch (application.approved, attempt not cancelled,
  account still active + owned).

## 6. Risks & open decisions
1. **Migration not applied** → Studio shows "setup pending" state (probe), nothing crashes.
2. GitHub cron throttling (~6 runs/day observed) → best-effort page-load catch-up for
   the visiting user's DUE attempts (server-side, idempotent, logged).
3. No delivery-confirmation tracking (providers here don't expose it) → statuses stop
   at `sent`/`failed` (documented).
4. CV fact guard is a heuristic subset check — final review remains the user's.
5. No follow-up reminder engine exists → out of scope (opt-in reminders would need
   new notification plumbing; flagged for decision).

## 7. Acceptance tests (new, all mocked — no real email/AI spend)
- studio-schema: AdExtract/AdAnalysis validation, missing-info detection, clamping,
  injection text stays data.
- studio-ad-analysis route: auth, rate limit, quota reserve/release, zod output.
- studio-applications: ownership/cross-user denial, versioning, approval gating.
- studio-cv-generation: sanitize + fact guard rejects fabricated contacts/experience.
- studio-attachments: sniffing, size cap, cross-user delete denied.
- studio-email-send: approval required; idempotent single send; retry/backoff ≤3;
  cancelled never sent; uncertain failure no auto-resend.
- studio-scheduling: tz conversion, past/deadline validation, cancel before dispatch.
- studio-migration: SQL static checks (tables/RLS/additive only).
- studio-ui (jsdom): render, tabs, missing-info warning, approval gate.
