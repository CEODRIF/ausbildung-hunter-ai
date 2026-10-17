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
- Cron tick: ≤3 campaigns × ≤5 messages, 45 s wall budget — backlogs drain
  over multiple ticks; the browser poll is a second, idempotent driver.

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
