import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DISCOVERY_ERROR_FALLBACK_KEY,
  DISCOVERY_ERROR_KEYS,
  DISCOVERY_STOP_FAILED_KEY,
  classifyDiscoveryDbError,
  discoveryErrorKey,
  isTerminalRunStatus,
  retryAfterSeconds,
} from "@/lib/company-discovery/errors";
import { SUPPORTED_LANGUAGES } from "@/lib/i18n/dictionaries";
import { translate } from "@/lib/i18n/core";

/**
 * Company Discovery — UX regression tests for the reported bugs:
 *
 *  A. ONE generic error for every failure. The UI now maps a machine code
 *     (or the HTTP status) to a specific, translated, actionable message —
 *     and every message that can appear exists in ALL four languages.
 *  B. No way back. The page carries a Dashboard link in every state.
 *  C. No live state and no Stop Search. The page polls the run for real
 *     counters, can cancel it, and never renders a number the server did not
 *     report (a partial result — 4 of 10 — is an honest state, not an error).
 */

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const read = (relative: string) => readFileSync(resolve(root, relative), "utf8");

const component = read("src/components/company-discovery.tsx");
const startRoute = read("src/app/api/company-discovery/start/route.ts");
const runRoute = read("src/app/api/company-discovery/[runId]/route.ts");

// ---------------------------------------------------------------------------
// A. Error mapping
// ---------------------------------------------------------------------------

describe("discoveryErrorKey — specific messages instead of one generic line", () => {
  it("a known code always wins over the HTTP status", () => {
    expect(discoveryErrorKey(500, "database_not_ready")).toBe(
      DISCOVERY_ERROR_KEYS.database_not_ready,
    );
    expect(discoveryErrorKey(500, "rate_limited")).toBe(
      DISCOVERY_ERROR_KEYS.rate_limited,
    );
  });

  it("maps every documented failure to its own message", () => {
    expect(discoveryErrorKey(401)).toBe(DISCOVERY_ERROR_KEYS.unauthorized);
    expect(discoveryErrorKey(403)).toBe(DISCOVERY_ERROR_KEYS.unauthorized);
    expect(discoveryErrorKey(400)).toBe(DISCOVERY_ERROR_KEYS.invalid_params);
    expect(discoveryErrorKey(404)).toBe(DISCOVERY_ERROR_KEYS.not_found);
    expect(discoveryErrorKey(429)).toBe(DISCOVERY_ERROR_KEYS.rate_limited);
    expect(discoveryErrorKey(500)).toBe(DISCOVERY_ERROR_KEYS.search_failed);
    expect(discoveryErrorKey(503)).toBe(DISCOVERY_ERROR_KEYS.search_failed);
  });

  it("an unknown code falls back to the status, then to the generic key", () => {
    expect(discoveryErrorKey(401, "something_new")).toBe(
      DISCOVERY_ERROR_KEYS.unauthorized,
    );
    expect(discoveryErrorKey(418, "teapot")).toBe(DISCOVERY_ERROR_FALLBACK_KEY);
  });

  it("every distinct failure resolves to a DISTINCT message key", () => {
    const keys = Object.values(DISCOVERY_ERROR_KEYS);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("retryAfterSeconds — the wait is reported, never invented", () => {
  it("prefers the body value, then the header, then reports 0", () => {
    expect(retryAfterSeconds({ retry_after: 7 }, "12")).toBe(7);
    expect(retryAfterSeconds({}, "12")).toBe(12);
    expect(retryAfterSeconds({}, null)).toBe(0);
    expect(retryAfterSeconds(null, null)).toBe(0);
    expect(retryAfterSeconds({ retry_after: -5 }, null)).toBe(0);
  });
});

describe("classifyDiscoveryDbError — a missing migration is not a failed search", () => {
  it("recognises the PostgREST / SQL signatures of a missing relation", () => {
    expect(
      classifyDiscoveryDbError({
        code: "PGRST205",
        message: "Could not find the table 'public.discovery_runs' in the schema cache",
      }),
    ).toBe("database_not_ready");
    expect(
      classifyDiscoveryDbError({
        code: "42P01",
        message: 'relation "public.discovery_runs" does not exist',
      }),
    ).toBe("database_not_ready");
    expect(
      classifyDiscoveryDbError(new Error("… does not exist")),
    ).toBe("database_not_ready");
    expect(
      classifyDiscoveryDbError({ details: "PGRST205: missing relation" }),
    ).toBe("database_not_ready");
  });

  it("keeps every other persistence failure a plain search failure", () => {
    expect(classifyDiscoveryDbError(new Error("connection reset"))).toBe(
      "search_failed",
    );
    expect(classifyDiscoveryDbError(null)).toBe("search_failed");
  });
});

describe("isTerminalRunStatus", () => {
  it("treats only real end states as terminal", () => {
    for (const status of ["completed", "partial", "cancelled", "failed"])
      expect(isTerminalRunStatus(status)).toBe(true);
    for (const status of ["pending", "running"]) expect(isTerminalRunStatus(status)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A2. Every message that can appear is translated in all four languages
// ---------------------------------------------------------------------------

describe("i18n coverage of the discovery states", () => {
  const keys = [
    ...Object.values(DISCOVERY_ERROR_KEYS),
    DISCOVERY_ERROR_FALLBACK_KEY,
    DISCOVERY_STOP_FAILED_KEY,
    "companyDiscovery.backToDashboard",
    "companyDiscovery.form.stop",
    "companyDiscovery.form.stopping",
    "companyDiscovery.form.searching",
    "companyDiscovery.progress.title",
    "companyDiscovery.progress.pending",
    "companyDiscovery.progress.note",
    "companyDiscovery.progress.keepOpen",
    "companyDiscovery.progress.refresh",
    "companyDiscovery.progress.stopNote",
    "companyDiscovery.runCreated.sourceSearching",
    "companyDiscovery.runCreated.verified",
    "companyDiscovery.runCreated.liveQuery",
    "companyDiscovery.runCreated.liveSource",
    "companyDiscovery.runCreated.liveIdle",
    "companyDiscovery.continue.note",
    "companyDiscovery.continue.button",
    "companyDiscovery.continue.continuing",
    "companyDiscovery.continue.failed",
    "companyDiscovery.status.pending",
    "companyDiscovery.status.running",
    "companyDiscovery.status.completed",
    "companyDiscovery.status.partial",
    "companyDiscovery.status.cancelled",
    "companyDiscovery.status.failed",
  ];

  it("resolves every key to a real translation in de/en/fr/ar", () => {
    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of keys) {
        const value = translate(language, key);
        expect(value, `${language} → ${key}`).not.toBe(key);
        expect(value.trim().length, `${language} → ${key}`).toBeGreaterThan(0);
      }
    }
  });

  it("documents the retry wait with an interpolation slot", () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const value = translate(language, DISCOVERY_ERROR_KEYS.rate_limited);
      expect(value).toContain("{seconds}");
    }
  });
});

// ---------------------------------------------------------------------------
// B. Back to Dashboard — present in every state
// ---------------------------------------------------------------------------

describe("page navigation", () => {
  it("links back to the dashboard with a translated label (no hardcoded text)", () => {
    expect(component).toContain('href="/dashboard"');
    expect(component).toContain('t("companyDiscovery.backToDashboard")');
  });

  it("renders that link in ALL states (form, running, finished)", () => {
    const occurrences = component.split("{backLink}").length - 1;
    expect(occurrences).toBe(3);
  });

  it("mirrors the arrow for RTL with a logical margin", () => {
    expect(component).toContain("rtl:rotate-180");
    expect(component).toContain("me-1.5");
  });
});

// ---------------------------------------------------------------------------
// C. Live state, Stop Search, honest numbers
// ---------------------------------------------------------------------------

describe("live search state", () => {
  it("polls the REAL run instead of guessing progress", () => {
    expect(component).toContain("/api/company-discovery/${runId}");
    expect(component).toContain('cache: "no-store"');
    expect(component).toContain("isTerminalRunStatus(");
  });

  it("stops polling once the run is terminal (and can be re-checked)", () => {
    expect(component).toMatch(/if \(isTerminalRunStatus\(body\.run\.status\)\)/);
    expect(component).toContain("setPollExpired(true)");
    expect(component).toContain('t("companyDiscovery.progress.refresh")');
  });

  it("shows the counters the server measured — no simulated values", () => {
    for (const counter of [
      "run.progress.foundCompanies",
      "run.progress.offersAnalyzed",
      "run.progress.uniqueCompanies",
      "run.progress.duplicatesRemoved",
      "run.progress.companiesRejected",
    ]) {
      expect(component).toContain(counter);
    }
    expect(component).toContain("{run.progress.foundCompanies}");
    expect(component).toContain("/ {run.progress.targetCompanies}");
  });

  it("renders the status the run actually has (completed / partial / failed / cancelled)", () => {
    expect(component).toContain("`companyDiscovery.status.${status}`");
    expect(component).toContain("RunStatusBadge");
  });

  it("treats a partial result as a state, not as an error", () => {
    // The ONLY place found-vs-target is compared is the Continue Research
    // branch, guarded by the real terminal status `partial` — there is no
    // branch that turns a partial result into a failure message.
    expect(component).toMatch(
      /run\.status === "partial" &&[\s\S]{0,80}foundCompanies < run\.progress\.targetCompanies/,
    );
    const comparisons =
      component.split("foundCompanies < run.progress.targetCompanies").length - 1;
    expect(comparisons).toBe(1);
    expect(component).toContain('t("companyDiscovery.progress.note")');
  });

  it("shows the live query/source the engine measured (no simulated values)", () => {
    expect(component).toContain("run.progress.currentQuery");
    expect(component).toContain("run.progress.currentSource");
    expect(component).toContain('t("companyDiscovery.runCreated.liveQuery")');
    expect(component).toContain('t("companyDiscovery.runCreated.liveSource")');
    expect(component).toContain('t("companyDiscovery.runCreated.liveIdle")');
    expect(component).toContain('t("companyDiscovery.runCreated.verified")');
  });

  it("contains no simulated progress (no random, no timer-driven number math)", () => {
    expect(component).not.toMatch(/Math\.random/);
    expect(component).not.toMatch(/setInterval/);
  });

  it("keeps the search button disabled while the request is in flight", () => {
    expect(component).toContain('phase === "submitting"');
    expect(component).toContain("disabled={phase === \"submitting\"}");
  });
});

describe("Stop Search", () => {
  it("posts to the cancel endpoint of the current run", () => {
    expect(component).toContain("/api/company-discovery/${runId}/cancel");
    expect(component).toContain('t("companyDiscovery.form.stop")');
    expect(component).toContain('t("companyDiscovery.form.stopping")');
  });

  it("surfaces a failed stop with its own translated message", () => {
    expect(component).toContain("DISCOVERY_STOP_FAILED_KEY");
    expect(component).toContain("stopError");
  });

  it("shows the cancelled state without overwriting it with a success story", () => {
    expect(component).toContain('run.status === "cancelled"');
    expect(component).toContain('t("companyDiscovery.progress.stopNote")');
  });
});

describe("Continue Research", () => {
  it("offers the button only on the real `partial` status below the target", () => {
    expect(component).toContain('run.status === "partial"');
    expect(component).toContain('t("companyDiscovery.continue.button")');
    expect(component).toContain('t("companyDiscovery.continue.note", {');
  });

  it("reopens the SAME run via its continue endpoint — never /start", () => {
    const handler = component.slice(component.indexOf("function onContinue"));
    expect(handler.slice(0, 700)).toContain("/api/company-discovery/${runId}/continue");
    expect(handler.slice(0, 700)).not.toContain("/start");
  });

  it("resumes the live view on the same runId after the server reopens it", () => {
    const handler = component.slice(component.indexOf("function onContinue"));
    const block = handler.slice(0, 1200);
    expect(block).toContain("setRun(body.run)");
    expect(block).toContain('setPhase("running")');
  });

  it("surfaces a failed continuation with its own translated message", () => {
    expect(component).toContain('t("companyDiscovery.continue.failed")');
    expect(component).toContain("continueError");
  });
});

describe("failure surfacing", () => {
  it("uses the shared code→message mapping instead of one hardcoded line", () => {
    expect(component).toContain("discoveryErrorKey(");
    expect(component).not.toContain("companyDiscovery.error.generic");
    expect(component).toContain("DISCOVERY_ERROR_FALLBACK_KEY");
  });

  it("passes the documented wait to the rate-limit message", () => {
    expect(component).toContain("retryAfterSeconds(");
    expect(component).toContain("{ seconds }");
  });
});

// ---------------------------------------------------------------------------
// D. Route-level architecture locks
// ---------------------------------------------------------------------------

describe("route contract", () => {
  it("the start route answers BEFORE the engine runs (pollable run id)", () => {
    // The engine call lives INSIDE the deferred work, never in the request path.
    const executeBlock = startRoute.slice(
      startRoute.indexOf("const execute = async"),
      startRoute.indexOf("let scheduled"),
    );
    expect(executeBlock).toContain("await runDiscoveryPipeline(");
    expect(startRoute).toContain("runAfterResponse(execute)");
    expect(startRoute).toContain("scheduled");
  });

  it("the progress endpoint is a read and never eats the 4/min budget", () => {
    expect(runRoute).not.toContain("checkRateLimit");
    expect(runRoute).toContain("getDiscoveryRunStrict");
  });

  it("both mutations return the shared machine codes", () => {
    expect(startRoute).toContain("unauthorizedResponse()");
    expect(startRoute).toContain("rateLimitedResponse(limited)");
    expect(startRoute).toContain("discoveryFailure(");
  });
});
