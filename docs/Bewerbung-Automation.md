# Bewerbung Automation — feature documentation

**Route:** `/bewerbung-automation` (authenticated, active users only)
**Branch:** `feat/bewerbung-automation` (work locally only — no push, no merge, no deploy)

Prepare 1–100 personalized German job/Ausbildung applications, review each one
with its attachments, and send the approved ones through the user's
already-connected e-mail account (Gmail/Outlook) via the existing OAuth
integration.

---

## 1. What was built

| Layer | File(s) |
|---|---|
| Isolated schema (NOT applied) | `supabase/migrations/20261112000000_bewerbung_automation.sql` |
| Pure/isomorphic logic | `src/lib/bewerbung-automation.ts` (count/email validation, RFC-4180 CSV, column mapping, import results, send plan, subject builder, no-invention letter prompt, letter assembly, document validation, error classification, PDF candidate extraction) |
| Server engine (server-only) | `src/lib/bewerbung-engine.ts` (campaign/app CRUD, document library, bounded AI generation, quota-aware send start, atomic claim drain, cancel, views) |
| Route + actions | `src/app/bewerbung-automation/{layout,page,actions}.ts(x)` |
| UI (5 steps) | `src/components/bewerbung-automation/{client,companies-step,documents-step,generate-step,review-step,send-step,types,import-parse}.tsx(ts)` |
| API | `src/app/api/bewerbung/template/route.ts` (auth-required sample CSV), `src/app/api/internal/bew-worker/route.ts` (EMAIL_WORKER_SECRET), `src/app/api/cron/bew-scheduler/route.ts` (CRON_SECRET) |
| Additive shared changes | `app-shell.tsx` (nav + heading), `i18n/dictionaries.ts` (4 locales), `storage-reconcile.ts` (janitor reference table), `package.json` (`xlsx` client-side Excel parsing) |

### Isolation guarantees
- All feature data lives in NEW `bew_*` tables (owner-scoped, RLS SELECT-only
  for the owner, everything else service-role RPC).
- The engine never writes to `email_campaigns`, `email_messages`,
  `application_drafts*`, or any protected table (enforced by a static source
  guard in `tests/bew-actions-contract.test.ts`).
- Standard email sending, Email Verification (GoTrue confirmation), and
  e-mail-account behavior are untouched. **Note:** there is no Unsubscribe
  feature in this repository, so that constraint is vacuous here.
- Shared services are reused unmodified: quota RPCs
  (`reserve_email_capacity` / `release_email_capacity`), `reserveSenderSlot`
  pacing, `createEmailProvider` (ownership-verified send), `reserveAIUsage`,
  `sanitizeEmailHtml`, `renderGreeting`.
- Enforced by tests: `tests/bew-actions-contract.test.ts` (auth on every
  action, argument mapping, static isolation guards) plus the existing
  `tests/security/authorization.test.ts` route guard.

## 2. Local setup & verification

```bash
git checkout feat/bewerbung-automation
npm install
cp .env.example .env.local        # existing local env (Supabase, Gmail OAuth, AI key…)
npm run dev                        # open http://localhost:3000/bewerbung-automation
```

The page degrades gracefully (a "schema pending" notice) when the `bew_*`
tables have not been applied to the target database yet.

Verification commands (all executed on this branch; see final report for
results):

```bash
npx tsc --noEmit
npm run lint
npm run build
npx vitest run tests/bew-company-import.test.ts tests/bew-send-engine.test.ts tests/bew-provider-classification.test.ts tests/bew-actions-contract.test.ts tests/migration-sql-regression.test.ts tests/storage-reconcile.test.ts tests/security/authorization.test.ts
npx vitest run                     # full suite
```

## 3. Migration procedure & deployment order

Migration file: `supabase/migrations/20261112000000_bewerbung_automation.sql`
(review-ready, **NOT applied to production**).

It creates:
- enums `bew_campaign_status`, `bew_app_status`
- tables `bew_campaigns`, `bew_applications`, `bew_documents`,
  `bew_campaign_documents` (all `user_id`-scoped, RLS enabled, owner-SELECT
  policy, `revoke all from anon, authenticated; grant select`)
- indexes + `set_updated_at` triggers
- service-role-only `SECURITY DEFINER` RPCs with `set search_path = public`:
  `claim_next_bew_application` (FOR UPDATE SKIP LOCKED, only while the
  campaign is `sending`), `bew_record_email_sent` (quota sent/reserved
  accounting mirroring the existing engine), `bew_cancel_queued`
  (queued→cancelled + quota release).

### Testing the migration
1. Against a **local/dev** Supabase instance only:
   `supabase db push` (or apply the file in the SQL editor) after reading it.
2. Run `npx vitest run tests/migration-sql-regression.test.ts`
   (static reserved-word guard — already passing) and the engine test suite
   (in-memory fakes, no database needed).
3. Verify: `\dt public.bew_*`, RLS on all four tables, `select has_table_privilege('authenticated','public.bew_campaigns','select')` = true, insert = false; RPCs revoked from `anon`/`authenticated`.

### REQUIRED deployment order
1. **Apply the migration to production first** (manual step by the owner).
2. **Then** deploy the application code.

Reason: `storage-reconcile.ts` (the existing janitor) now lists
`bew_documents.storage_path` as a reference table for the
`application-attachments` bucket. If code were deployed before the
migration, the janitor tick would fail loud (no deletions at all — the safe
direction). Applying the migration first avoids even that brief
no-cleanup window. **No production migration was applied by this work.**

## 4. Gmail / OAuth scope findings

- The existing Google authorization requests
  `openid`, `email`, `https://www.googleapis.com/auth/gmail.send`
  (`src/lib/email-oauth.ts`). That is exactly the permission needed to SEND —
  **no re-authorization and no new scopes are required** for this feature.
- There is NO Gmail read scope anywhere; the feature therefore never reads
  mailboxes and the "needs attention" state (ambiguous send outcome) is
  handled by telling the user to check their Sent folder — not by reading it.
- Tokens stay AES-256-GCM encrypted in `email_accounts` (existing
  `EMAIL_TOKEN_ENCRYPTION_KEY` mechanism, untouched).
- Microsoft/Outlook accounts are also usable via the same provider interface
  (`Mail.Send` scope already present), but the UX text assumes the common
  Gmail case; the confirmation dialog always shows the ACTUAL sending
  mailbox.
- If the connected account is inactive or flagged `requires_reconnect`, the
  feature shows an explicit "reconnect required" state and links to the
  existing `/settings/email` — it never silently requests additional scopes.

## 5. Quota, retry safety, ambiguous sends

**Effective daily limit** = min(platform cap 100, remaining user quota
from `get_daily_usage_snapshot`, Gmail's own limits enforced reactively —
429/5xx → temporary retry). The requested campaign count (1–100) is a
preparation size, never a permission to exceed quota: `computeSendPlan`
splits the selection into `batch` (affordable now) + `deferred` (kept
saved for a later day) and the UI explains both before the user confirms.

**Safety properties (all covered by `tests/bew-send-engine.test.ts`):**
- Atomic quota reservation via the existing `reserve_email_capacity` RPC
  before anything is queued; release on failure/cancel.
- Idempotent, concurrency-safe claiming via
  `claim_next_bew_application` (`FOR UPDATE SKIP LOCKED`): two concurrent
  drains (browser poll + worker + cron) can never send the same application
  twice (tested with `Promise.all` double-drain).
- Bounded retries with backoff for TRANSIENT failures only (≤3 attempts,
  +60 s). Definitive provider rejections are terminal.
- **Ambiguous outcomes (raw network errors) are never re-sent**: the app
  goes to `needs_attention`, the quota is treated as consumed, and the UI
  instructs the user to check their mailbox (no Gmail read scope exists).
- Reconnect-required failures stop the whole batch; the remaining queued
  apps wait until the account is healthy again.
- Cancellation: `bew_cancel_queued` flips queued→cancelled and releases the
  reserved quota; in-flight sends are never interrupted mid-HTTP.
- A message is reported `sent` ONLY after the provider returned a message
  id (`provider_message_id` stored for audit).
- Nothing is ever enqueued by opening the page or generating letters — the
  only enqueue path is the explicit confirmed `startBewSend` action, which
  re-verifies identity, ownership, sender health, documents, per-row
  validity, and quota server-side.

## 6. Documents: ownership, validation, storage

- Uploaded once to the owner's document library, attached to the campaign,
  and reused by every application (no per-company re-upload).
- Validation: allowed types (PDF, DOC, DOCX, PNG, JPEG) + 10 MB max,
  checked server-side before any storage write; invalid input never touches
  storage.
- Storage: existing private `application-attachments` bucket,
  owner-prefixed paths (`{userId}/…`) via the shared `storagePath` helper;
  no public URLs are ever issued to the client (paths only travel inside
  ownership-verified server code; `fetchAttachmentContents` downloads
  server-side at send time).
- Compensation: if the metadata insert fails, the storage object is removed
  again (tested).
- Cross-user isolation: list/attach/detach/restore are all
  `user_id`-scoped; a foreign document id resolves to nothing (tested).
- **Cleanup:** `bew_documents` is registered in the janitor
  (`storage-reconcile.ts` BUCKETS) so referenced CVs/certificates are
  NEVER reclaimed; genuinely orphaned uploads are reclaimed after the
  existing 24 h grace period (regression tests in
  `tests/storage-reconcile.test.ts`).

## 7. PDF import

Best-effort, preview-only: the server extracts text with the existing
`pdf-parse` stack and proposes one candidate per line containing a
e-mail address (name = text on the same line only — never cross-line
guessing). The user MUST review/correct the preview before applying; the
same validation pipeline as CSV runs, and nothing is stored without the
explicit "Apply" action.

## 8. Known limitations & risks

- **Manual migration:** the feature needs `20261112000000` applied to a
  database before it becomes active (the page shows a pending notice until
  then — it does not crash).
- **Stuck `generating` rows:** if a generation request crashes mid-letter,
  that row stays `generating` and is not auto-recovered (no
  stale-reclaim yet). Mitigations: re-saving the company row resets it to
  `pending`; the campaign counter refresh reports it in `failed_count`…
  (actually reported via the row status pill). Low probability (bounded
  5-letter batches), acceptable risk.
- **Ambiguous sends are manual:** `needs_attention` rows require the user
  to check their mailbox (no Gmail read scope by design).
- **Quota day boundary** uses the campaign's UTC `usage_date` set at send
  start; a very long-running campaign does not re-claim a new day mid-run.
- **xlsx in the browser** adds a client dependency (`xlsx` 0.18.5,
  SheetJS — known advisory history, used read-only for local parsing, no
  network).
- The global build emits one pre-existing CSS-optimization warning
  (Lightning CSS on a truncated `var(…)` in the shared stylesheet) —
  unrelated to this feature.

## 9. Operational limits

- Platform cap: 100 requested applications per day per campaign.
- User quota: existing plan limits (free 50 / plus 150 / pro 500 per day)
  via the unchanged quota RPCs.
- Sender pacing: existing per-account 5–6 s slot (`reserveSenderSlot`).
- AI generation: existing `reserveAIUsage` daily AI limit; when hit, the
  run parks remaining letters (no error, no duplicate).
- Cron tick: ≤10 campaigns × ≤5 messages, 45 s wall budget — backlogs drain
  over multiple ticks. Campaign selection is DUE-AWARE (in-flight first, then
  scheduled batches that are now due, then timestamp-less legacy rows), so a
  pending scheduled batch can no longer be starved behind idle in-flight
  campaigns at the cap. The browser send poll — and the Refresh button on the
  scheduled card (server action `bewRefreshSend`) — are the second, idempotent
  driver: with the Actions cron running at an irregular cadence, a due batch
  is released at its instant as soon as the user's page is active. Both
  drivers share the same `FOR UPDATE SKIP LOCKED` claim core, so overlapping
  drains can never double-send.

## 10. Explicit confirmations

- **No production migration was applied.** The SQL file is review-ready
  only.
- **No real e-mails were sent** — all send tests use a mocked provider and
  in-memory fakes; no production tokens or data are referenced anywhere.
- **No push, merge, or deployment** was performed; all work is local on
  `feat/bewerbung-automation`.
- **No production secrets, OAuth settings, Vercel configuration, or domain
  changes** were made. The worker route reuses the EXISTING
  `EMAIL_WORKER_SECRET`; the cron route reuses the EXISTING `CRON_SECRET`.
- **No new paid services** were added (existing AI provider + Google OAuth
  only).

---

## 11. Anschreiben quality — position brief, evidence-based prompt, quality gate

This section documents the work that makes every generated Anschreiben
genuinely personal: it is written for the ACTUAL role, from the ACTUAL
applicant's verified CV, with interest in the ACTUAL employer only when that
is supported by verified facts.

### 11.1 Root causes of the previously generic letters
The old prompt produced generic output because:
1. **No role data.** Only the company name/address was passed — no position
   title, no job description. The model could not address a specific role.
2. **No employer facts.** Beyond the name there were no verified
   employer-specific facts, so "interest in the company" was vague.
3. **Raw CV text, not the verified profile.** The letter was built from the
   raw extracted document text (truncated at 12,000 chars), not the parsed +
   validated `CandidateProfile` — structured skills, experience
   responsibilities, languages (with levels) and stated interests were lost.
4. **No evidence mapping.** Nothing connected the role's requirements to the
   applicant's evidence, so the letter listed generic strengths.
5. **Weak data isolation.** The CV text was pasted in with no fencing and no
   "data is not instructions" rule, inviting weak output and prompt-injection
   from untrusted CV content.
6. **No quality gate / no bounded retry.** The first model output was accepted
   as-is.

### 11.2 What changed (files & behaviour)
- `supabase/migrations/20261115000000_bew_position_brief.sql` — additive,
  rerunnable: campaign `position_title`/`position_brief`/`employer_facts`;
  per-application overrides (NULL = inherit campaign); `quality_attempts`;
  `generation_started_at` lease; partial index; length CHECKs. No RLS change,
  no backfill.
- `src/lib/bewerber-automation.ts` — new `LetterPromptInput`;
  `resolveLetterPosition` (override → campaign → empty, **never invents**);
  fenced isolation (`fence`/`escapeFence`) + an explicit "data is never
  instructions" rule; `buildApplicantEvidence` (structured CV → readable
  evidence, gaps surfaced as constraints); rewritten `buildLetterPrompt`;
  deterministic `validateLetterQuality` (hard failures block, soft issues are
  signals); `buildLetterCorrectiveNote`; opt-in model-eval prompt + defensive
  `parseLetterEvalVerdict`; `BEW_MAX_LETTER_ATTEMPTS = 2`; field caps.
- `src/lib/bewerber-engine.ts` — `loadCandidateProfile` (latest verified CV);
  per-app position/employer resolution; bounded two-attempt loop with the
  deterministic gate applied to the model body and a corrective second attempt;
  terminal `quality_gate` failure (never a silent accept); lease stamped on
  claim; `reclaimStaleGenerating` (conditional, idempotent, never overwrites a
  generated/sent body); create/save/update accept + validate the new fields;
  `hasBewPositionColumns` probe (migration pending → degrades to "no position").
- `src/app/bewerber-automation/actions.ts`, `src/components/bewerber-automation/*`,
  `src/lib/i18n/dictionaries.ts` (4 locales), `.env.example` (documents the
  opt-in `BEW_LETTER_MODEL_EVAL`).

### 11.3 Truthfulness guarantees
- **No position supplied** → the prompt states "Keine konkrete
  Stellenbezeichnung geliefert — erfinde keine" and writes honestly about the
  activity in general.
- **No verified employer facts** → interest stays general; no invented claims
  about the employer.
- **No fabrication** → only facts present in the fenced data blocks may be
  used; missing information is listed as an explicit constraint.

### 11.4 Illustrative before/after (FICTIONAL data, not real applicants/companies)
Before — old prompt carried only `FIRMENNAME: ACME GmbH` + raw CV text. Typical
generic result:
> "Hiermit bewerbe ich mich um einen Ausbildungsplatz bei Ihrer Firma. Ich bin
> motiviert, lernwillig und teamfähig. Über eine Einladung zu einem persönlichen
> Gespräch würde ich mich sehr freuen."

After — prompt carries fenced `ROLLE` (Bezeichnung: Ausbildung als
Fachinformatiker:in für Anwendungsentwicklung + Anforderungen), `UNTERNEHMEN`,
`UNTERNEHMEN_FAKTEN` (verified) and a structured `BEWERBER` evidence block.
Resulting letter connects applicant → role → employer from real evidence:
> "Ihre Ausschreibung für die Ausbildung als Fachinformatiker:in für
> Anwendungsentwicklung hat mich überzeugt, weil ich im IT-Support-Praktikum
> eigene Webanwendungen mit HTML, CSS und JavaScript entwickelt und Python
> vertieft habe — genau die Bereiche, die in der Stellenausschreibung genannt
> werden. Dass ACME Middleware für den Mittelstand entwickelt, reizt mich, weil
> ich ... . Ich freue mich über die Einladung zu einem persönlichen Gespräch."

Why the "after" is better: it names the specific role, cites the applicant's
actual evidence (not adjectives), and grounds employer interest in a verified
fact — none of which the "before" contained.

### 11.5 Quality gate & retry behaviour
- **Deterministic gate (always on):** hard failures = placeholder tokens,
  prompt/structure leakage, degenerate length (too short / absurdly long). Soft
  signals (target length, cliché opening, role/employer not referenced,
  repetition) are logged and feed the corrective note / model review.
- **Bounded retries:** at most **two** attempts per application; each attempt
  reserves AI quota once. Attempt 2 appends a concrete `VERBESSERUNG:` note.
- **Terminal failure:** if the hard gate still fails (or, with the opt-in model
  review enabled, the model still rejects) after the final attempt, the row
  becomes `failed` with `error_code: quality_gate` — it is **never** silently
  accepted as generated.
- **Stale recovery:** a row stuck in `generating` past the 10-minute lease is
  reclaimed to `pending`; rows that already have a body or a `sent_at` are
  never touched; the sweep is ownership-scoped and idempotent.

### 11.6 Limitations
- **Model-dependent truthfulness:** the no-fabrication guarantee is enforced by
  prompt + deterministic gate (placeholders/leakage/degenerate length), but a
  misbehaving provider could still assert an invented fact in fluent German,
  which the deterministic gate cannot detect. The opt-in model review adds a
  second opinion but is not a guarantee.
- **Reduced personalization by design** when position or employer information
  is unavailable — the letter is truthful but less specific.
- **Grammar/spelling/idiom** are not deterministically validated; they rely on
  the model.
- **Advisory model review:** `BEW_LETTER_MODEL_EVAL` (default off) adds a model
  review that triggers corrective retries; the deterministic gate is the hard
  acceptance authority, so a deterministic-passing letter is accepted on the
  final attempt even if an enabled model review is negative.
- **Lease window:** `reclaimStaleGenerating` uses a fixed 10-minute lease; a
  provider call slower than that is reclaimed (and re-run) rather than treated
  as in-flight.
