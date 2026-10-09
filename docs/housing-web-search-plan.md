# Housing Web Search — Phase 1 Findings & Implementation Plan (2026-10-09)

Branch: `feat/housing-web-search` (based on `6e56ef7` — tip of the merged PR #4 + #5 stack).

## 1. Existing Azure setup (inspected, no secrets exposed)

| Item | State | Evidence |
|---|---|---|
| AI provider abstraction | `src/lib/ai-provider.ts` — generic **OpenAI-compatible** Chat Completions client: `AI_API_URL` + `AI_API_KEY` + `AI_MODEL` (prod: Azure Foundry, `gpt-5-mini`) | code |
| Web search in app | **Tavily** (`TAVILY_API_KEY`) via `src/lib/web-search/index.ts`: server-only, per-run budget (30, hard cap 60), 10-min memory cache, SSRF-guarded page fetcher. Used by the Germany copilot (`germany-research.ts`) | code |
| Azure web-search code path | **None** — no code ever calls a web-search tool; `ai-provider.ts` sends plain `chat/completions` with no `tools` | code |
| "Toolbox" (Foundry Agent Service `WebSearchToolboxTool`) | A heavier Agent-Service API surface (agent runs). Not required — the direct Responses API path below is the documented, minimal integration | MS docs |
| Azure credentials in this sandbox | **None** (no `.env`, no env vars) → live verification of the tool is only possible where the app runs (prod env) | env inspection |

## 2. Exact supported API (official Microsoft docs, fetched 2026-10-09)

- **Endpoint**: `POST https://{resource}.openai.azure.com/openai/v1/responses` — the **Responses API on the same Foundry resource** that already serves `gpt-5-mini`. *No new Azure resource is required.*
- **Docs**: [Web search with the Responses API](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/web-search) · [Web search in Agent Service](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/web-search) · [Grounding with Bing pricing](https://www.microsoft.com/en-us/bing/apis)
- **Request shape** (API key auth: `api-key` header; same key as chat):
  ```json
  {
    "model": "gpt-5-mini",
    "reasoning": { "effort": "low" },
    "tools": [{
      "type": "web_search",
      "filters": { "allowed_domains": ["…", "…"], "blocked_domains": ["…"] },
      "user_location": { "type": "approximate", "country": "DE", "city": "Köln", "region": "NRW", "timezone": "Europe/Berlin" }
    }],
    "tool_choice": "auto",
    "include": ["web_search_call.action.sources"],
    "input": "…targeted German query…",
    "max_output_tokens": 500
  }
  ```
- **Capability answers** (the three Phase-1 questions):
  1. **General web search with source citations — supported.** Response `output[]` contains `web_search_call` items (action.query, sources when `include` is set) and a `message` item whose `annotations[]` carry `url_citation { url, title }` — original URLs and titles, no fabrication by us.
  2. **Domain restriction — supported natively** via `filters.allowed_domains` (≤100 domains, subdomains included) / `blocked_domains`. Works with the `web_search` tool in the Responses API only (not `web_search_preview`, which we do not use).
  3. **Toolbox — not needed.** The Agent Service toolbox path (WebSearchToolboxTool → MCP endpoint → agent run) is an alternative surface; it needs agent resources/ids we do not have and adds per-run overhead. The direct Responses call uses the existing deployment only.
- **Model support**: "Web search in the Responses API works with GPT-4 models and later" → `gpt-5-mini` qualifies. `open_page`/`find_in_page` actions are reasoning-model only (gpt-5-mini is a GPT-5 reasoning model — page browsing likely available; we do not rely on it).
- **User location**: `city/region/timezone` supported by `web_search` (not preview) → German/city bias built in.
- **Pricing (official)**: **$14 per 1,000 Bing transactions** (Grounding with Bing Search). Billable count = `tool_usage.web_search.num_requests` in the response (NOT the number of `web_search_call` items). Plus normal gpt-5-mini token billing. Typical Responses call with web search executes ~1–4 Bing transactions.
- **Admin gate**: subscription feature flag `OpenAI.BlockedTools.web_search` can block the tool for the whole subscription (`az feature register/unregister`). **Unverifiable from this sandbox — prerequisite for enablement.**

## 3. Can the existing setup serve this without new resources?

**Yes, conditionally** — the Responses API is served by the existing Foundry resource/deployment. Three prerequisites, none creatable from here:
1. `AI_API_URL` must be the Foundry OpenAI-compatible base (e.g. `https://{resource}.openai.azure.com/openai/v1`) — true per project setup; detection is runtime (URL contains `azure.com`).
2. The `web_search` tool must not be blocked at subscription level (admin check, or first-call error tells us: controlled error → honest UI state).
3. The existing key must be a resource key with model access (it already serves chat).

**Cost of enabling**: first real call ≈ 1–4 transactions ≈ **$0.014–0.056** + negligible tokens. Bounded per-user request cost is the design target (see §5).

**Fallback**: the existing **Tavily** client (already a paid, configured feature) is wired behind the same interface as provider `tavily`. Provider resolution `auto` = Azure Foundry when the endpoint is Azure-shaped, else Tavily when its key exists, else an honest "web search not configured" UI state. Nothing in this PR changes chat behavior.

## 4. Compliance (Grounding with Bing **enterprise** TOU, Nov 2025 — applies to Azure Foundry use)

Design consequences (implemented, not aspirational):
- **References must be displayed** in the exact form provided, near the output, with a visible "internet search results" indication → UI shows per-result source name + URL and an attribution line.
- **Internet-search-experience only**: results respond to the user's own search intent (city/filters) and provide navigation links → satisfied by design.
- **No Bing-output database** (§3c): output may be cached only as part of our work product, never as a substitute search index → **in-memory TTL cache only (15 min, per process); nothing persisted to Supabase; saved-listings flow stores link references for web-search results, never snapshots**.
- **robots.txt rule** (display req. 2c): we never fetch (and do not surface fetch-parsed data from) a site that blocks automated access → fetch pipeline is fail-closed on robots; search-only domains are never fetched at all.
- **No training use of output** (2b): output is used on-demand and discarded — no training pipeline touches it.
- Data flows to Bing outside our geo boundary; DPA excluded (TOU §4d) — noted for the privacy policy review (out of scope here, flagged in PR).
- This is a compliance *implementation*, not legal advice; the interpretation of "using discovered URLs for bounded on-demand verification fetches" (allowed for fetch-permitted domains, forbidden for robots-blocked ones) is documented in the PR for legal review.

## 5. Implementation plan (what this branch builds)

**Pipeline** (all server-side, key never leaves the server):

```
user filters ──► query builder (DE primary, EN secondary)
                 │
                 ▼
        discovery client (azure responses web_search | tavily)
        ┌────────────────────────────┴───────────────────────────┐
   mode=web (general)                                  mode=targeted (website)
   no domain filter; German housing-domain           filters.allowed_domains =
   post-filter on known rental domains               selected allowlisted sites
                 └────────────────────────────┬───────────────────┘
                                              ▼
              candidate URLs: dedupe, https-only, allowlist (targeted) or
              known-rental-domain post-filter (general), listing-page heuristics
                                              ▼
              fetch gate (targeted mode only): domain policy = fetchable?
              robots.txt (fail-closed, TTL cache) → URL guard (SSRF: https,
              allowlist host, DNS → private/loopback/link-local/reserved IP
              reject, manual redirects ≤3 each re-validated) → size/timeout caps
                                              ▼
              parse: JSON-LD (schema.org Apartment/Residence/… + offers)
              + conservative explicit-text fields; unknown → null (never invented)
                                              ▼
              normalize to HousingListing (source_type, verification_status,
              last_checked_at, data_status=live, provider="web-search")
              + citations[] (url/title verbatim) + stats + honest warnings
```

**Verification semantics (never overstated):**
- `verified` — field parsed from the fetched page's structured metadata (JSON-LD) or unambiguous explicit text on a fetch-permitted page.
- `partially_verified` — field stated in the search result / grounded answer with a citation, not confirmed by fetch.
- `unverified` — candidate discovered, details unknown. AI extraction alone never yields `verified`.

**Bounded cost & abuse protection:**
- Per user request: ≤2 search-API calls (targeted mode: exactly 1), ≤3 page fetches, each fetch ≤10 s and ≤500 KB, total request timeout 25 s.
- Per-user rate limit: new bucket `housing_web_search` (10/h).
- Per-process daily soft budget (default 2,000 searches, env-tunable) → honest "daily budget exhausted" state.
- Bing estimate per search: ~1–4 transactions ≈ $0.014–0.056 worst-case ~$0.22 with 2 calls at 4 tx each; rate-limited to ≤10/h/user.

**Files** (new unless noted): `src/lib/housing/web-search/{config,queries,url-guard,robots,parse-listing,azure-client,tavily-client,discovery}.ts`, `src/app/api/housing/web-search/route.ts`, `src/app/api/housing/web-search/domains/route.ts`, `src/components/housing/housing-web-search.tsx`; edited: `types.ts` (+`source_type`, +`verification_status`), `rate-limit.ts` (+bucket), `housing-search.tsx` (mode integration), `i18n/dictionaries.ts` (de/en/fr/ar), `.env.example` (+`HOUSING_WEB_SEARCH=auto` documented).

**Supported websites (initial allowlist)** — search-only vs fetchable, with the gate that fetchable = robots.txt + ToS verified at implementation time (see PR for the per-domain evidence):
- Search-only (discovery + link, never fetched): `immobilienscout24.de`, `immowelt.de`, `wg-gesucht.de`, `kleinanzeigen.de`, `immonet.de` (their ToS prohibit automated retrieval — we only use the search engine's index and link out).
- Fetchable candidates (open-data portals, machine-readable APIs designed for automated access — robots verified in implementation): `open.nrw`, `opendata.de`, `data.berlin.de`.

**Tests** (Phase 7 list): response parsing + citations (azure + tavily), domain allowlisting + redirects, URL/SSRF validation, rate limiting + timeouts + daily budget, malformed pages + missing fields, dedupe + stale handling, demo/live separation, route auth/validation/rate-limit, full housing regression, tsc, eslint, full suite, `next build`.

## 6. Stop-conditions honored
- No Azure resources created, no paid features enabled, no subscriptions.
- No production Supabase change, no migrations.
- No scraping of robots-blocked sites; search-only domains are never fetched by us.
- All secrets server-side; nothing printed or committed.
