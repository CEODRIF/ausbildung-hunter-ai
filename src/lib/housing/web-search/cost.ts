import "server-only";

import { PROVIDER_LIMITS } from "./config";

/**
 * Cost model + per-run tracker (2026-10-10 high-coverage engine task).
 *
 * Costs are MEASURED from provider responses, not guessed:
 *   - Google/Gemini: the BILLABLE unit is each executed search query
 *     (official: 5,000/month free on Gemini 3+, then $14 per 1,000 =
 *     1.4 ¢/query). We count the queries reported in the
 *     `google_search_call` steps of each response.
 *   - Azure: the billable unit is the Bing transaction
 *     (`tool_usage.web_search.num_requests`), billed in Azure AI Foundry
 *     credits (plan-dependent, no fixed public per-query price) → we track
 *     the COUNT and report cost as null with an explicit basis string.
 *
 * The per-run cap (default 50 ¢, env-lowerable via
 * HOUSING_SEARCH_MAX_COST_CENTS_PER_RUN) is enforced on the Google side
 * BEFORE issuing the next paid call — when the estimate hits the cap,
 * remaining Google calls of the round are skipped (Azure continues under
 * its own unchanged Bing budget).
 */

export interface ProviderCost {
  provider: "google" | "azure";
  /** Billable units actually executed (queries / transactions). */
  units: number;
  /** Estimated cost in cents — null when the provider bills in credits
   *  (no fixed public price); never a guess dressed as a fact. */
  estimatedCostCents: number | null;
  /** How the number was produced (diagnostics, no secrets). */
  basis: string;
}

export class CostTracker {
  private googleQueries = 0;
  private bingTransactions = 0;
  private readonly maxCents: number;

  constructor() {
    const env = Number(process.env.HOUSING_SEARCH_MAX_COST_CENTS_PER_RUN ?? NaN);
    const cap =
      Number.isFinite(env) && env > 0 ? Math.min(env, PROVIDER_LIMITS.defaultMaxCostCentsPerRun) : PROVIDER_LIMITS.defaultMaxCostCentsPerRun;
    this.maxCents = cap ?? PROVIDER_LIMITS.defaultMaxCostCentsPerRun;
  }

  /** Record one Gemini response's executed search queries. */
  addGoogleQueries(n: number | null): void {
    if (typeof n === "number" && Number.isFinite(n) && n > 0) this.googleQueries += Math.floor(n);
  }

  /** Record one Azure response's reported Bing transactions. */
  addBingTransactions(n: number | null): void {
    if (typeof n === "number" && Number.isFinite(n) && n > 0) this.bingTransactions += Math.floor(n);
  }

  /** Current Google-side estimate in cents. */
  googleEstimateCents(): number {
    return Math.round(this.googleQueries * PROVIDER_LIMITS.googleCostCentsPerQuery * 100) / 100;
  }

  /** True once the per-run Google cost cap is reached — no further
   *  Google calls may be issued for this run. */
  googleCapReached(): boolean {
    return this.googleEstimateCents() >= this.maxCents;
  }

  maxCentsPerRun(): number {
    return this.maxCents;
  }

  snapshot(): ProviderCost[] {
    return [
      {
        provider: "google",
        units: this.googleQueries,
        estimatedCostCents: this.googleEstimateCents(),
        basis: `${this.googleQueries} executed Google search queries × $14/1,000 list (5,000/month free tier not tracked persistently)`,
      },
      {
        provider: "azure",
        units: this.bingTransactions,
        estimatedCostCents: null,
        basis: `${this.bingTransactions} Bing web-search transactions (Azure AI Foundry credits; plan-dependent)`,
      },
    ];
  }
}

/** Worst-case Google queries one run can execute (3 queries per call). */
export function worstCaseGoogleQueriesPerRun(): number {
  const maxCalls =
    PROVIDER_LIMITS.googleRound1Calls +
    PROVIDER_LIMITS.googleRound2Calls +
    PROVIDER_LIMITS.googleRound3Calls;
  return maxCalls * 3;
}
