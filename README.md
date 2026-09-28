# Ausbildung Hunter AI

A production SaaS that helps people in Germany find and apply for **Ausbildung** (vocational training) and **Arbeit** (jobs). Users connect their own Gmail/Outlook account, compose and send applications in bulk with a fair daily quota, use an AI assistant for application support, scan their own documents for fit, and search real German vacancies with a deterministic match score.

> **Status:** this repository is a checkpoint of the project **before the opportunities search was finished**. Everything up to and including the Bewerbung Scanner is complete and passing checks. The opportunities search code (Step 9) is present in this snapshot but was **interrupted and not yet verified** — treat it as work-in-progress (see "Roadmap").

## Implemented

| Area                           | What works                                                                                                                                                                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Auth foundation**            | Supabase email + custom verification codes, invitation-code registration, login, email verification, onboarding goal, row-level security throughout                                                                                                                                                          |
| **Invitation model**           | `DRIF928` — free registration, 0 email quota (AI-assisted setup only). `DRIF089` — 100 email applications per day (records a `user_quota_upgrades` row on activation)                                                                                                                                        |
| **Dashboard**                  | Real profile data, today's usage bars, application activity, account menu, logout                                                                                                                                                                                                                            |
| **Email account connection**   | OAuth 2.0 for Gmail (`gmail.send`) and Outlook (Microsoft Graph `Mail.Send`), signed state, **AES-256-GCM encrypted token storage**, connection management UI at `/settings/email`, full token-leakage audit                                                                                                 |
| **Application composer**       | `/applications/new` — rich-text email editor, recipients with CSV/TXT import, private attachments (Supabase Storage, `user_id`-scoped), per-recipient draft autosave, reusable templates                                                                                                                     |
| **Email sending engine**       | Campaigns + individual messages, **atomic quota reservation** (`FOR UPDATE` on `daily_usage`), idempotent message claims (`FOR UPDATE SKIP LOCKED`), external worker endpoint secured by `EMAIL_WORKER_SECRET`, campaign monitor UI at `/applications/campaign/[id]`, usage page at `/settings/usage`        |
| **AI assistant**               | `/ai` — conversation history, streaming responses, private file uploads (`ai-files` bucket), generated file downloads, **atomic AI usage limit of 100 requests/day**, server-only prompt hardening, strict Zod validation of all AI output                                                                   |
| **Bewerbung Scanner**          | `/bewerbung-scanner` — CV/document upload (PDF/DOCX), strict Zod candidate profile, AI-generated scan results, editable result page, rescan + history, counts against the AI limit                                                                                                                           |
| **Opportunities search (WIP)** | `/opportunities` — Bundesagentur für Arbeit Jobsuche API provider (Ausbildung + Arbeit), normalized opportunity schema, deterministic match engine (skills 50%, role 25%, location 15%, goal 10%), detail pages, saved opportunities. **Present in this snapshot but not completed/verified — see Roadmap.** |

## Not implemented (Roadmap)

- **Finish + verify the opportunities search** (Step 9): complete the interrupted implementation, add real end-to-end tests, and finalize caching/deduplication behavior.
- Automatic applications from saved opportunities (explicitly out of scope so far — every email is composed and sent by the user).
- Additional vacancy providers (only the Bundesagentur für Arbeit is wired up).
- Payments, billing, and multi-tenant admin.
- Test suites, CI, and deployment pipelines.

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
    opportunities/         # WIP: search, detail, saved
    settings/
      email/               # OAuth account connection management
      usage/               # quota + AI usage overview
    api/
      ai/                  # chat (streaming), conversations, files, generated files
      bewerbung-scanner/   # files, scan, results
      email/               # OAuth connect + callback
      internal/email-worker/ # worker endpoint (EMAIL_WORKER_SECRET)
      opportunities/       # WIP: search + save
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
    opportunities/         # WIP: types, match engine, BA provider
    supabase/              # server/client/service-role clients
  proxy.ts                 # session refresh middleware
supabase/
  config.toml
  migrations/              # 8 SQL migrations (see below)
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
20260927060000_opportunities.sql   # belongs to the WIP step
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

### Security model

- **RLS** on every user table; the app only ever uses the service role for server-side writes that RLS would block (quota counters, encrypted tokens).
- **OAuth tokens** are stored AES-256-GCM encrypted; the encryption key lives in `process.env` only.
- **Server-only imports** (`server-only`) guard every file that touches the service role, AI keys, or OAuth secrets.
- **AI output** is treated as untrusted: every response is parsed against strict Zod schemas before it is stored or rendered; user documents are injected as untrusted data in the prompt.
- **Attachments** go to private storage buckets scoped by `user_id`; the browser only ever sees opaque upload IDs.

## Known limitations

1. **Email sending needs a durable worker** (see above) — in development, call the worker endpoint manually or via a local cron.
2. **Opportunities search is WIP** — present but unverified in this checkpoint.
3. No automated tests, CI, or deployment configuration yet.
4. Only one vacancy provider (Bundesagentur für Arbeit).
5. Quota upgrades are invitation-code based only; no self-serve billing.
