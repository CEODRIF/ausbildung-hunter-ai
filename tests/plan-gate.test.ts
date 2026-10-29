/**
 * Mandatory plan-selection gate (getPlanGate) — server-authoritative
 * mapping + redirect-loop / safe-exit source contract.
 *
 * Pinned behavior (docs/subscription-system-design-2026-10-24 §2/§5):
 *   - NO subscription row at all (new user, or existing user who never
 *     selected) → selectionRequired (redirect to /settings/billing).
 *   - Only a historical `free` row (permanent Free plan REMOVED, 2026-10-24
 *     revision / D9) → ALSO selectionRequired: a `free` row grants nothing
 *     and is no longer a valid selection (unknown plan ids normalize to it).
 *   - Any OTHER historical row (trial, plus/pro, active/canceled/expired,
 *     admin-granted or mock-verified) → NOT selectionRequired: a selection
 *     exists; the entitlement engine alone decides what it grants (fail
 *     closed for metered features in every lapsed state).
 *   - expired TRIAL row → trialExpired (the prominent red banner), which is
 *     the plan-nudge mechanism — never a forced redirect.
 *   - lookup failure → NEITHER flag: a transient DB error must not bounce
 *     users who do have a plan; metered features are denied fail-closed by
 *     the resolver (pinned in the entitlement boundary tests).
 *
 * Source contract (redirect-loop safety):
 *   - every protected tool layout gates with getPlanGate + redirect and
 *     renders the banner only when the server gate says trialExpired;
 *   - the settings area (safe exit: account settings, plan selection,
 *     sign-out, support) shows the banner but NEVER redirects on
 *     selectionRequired;
 *   - the redirect TARGET (/settings/billing) is itself ungated → a loop
 *     is structurally impossible;
 *   - AppShell renders the server notice above <main> (prominent).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const resolveMock = vi.fn();
vi.mock("@/lib/billing/entitlement-service", () => ({
  resolveSubscription: (...args: unknown[]) => resolveMock(...args),
}));

import { getPlanGate } from "@/lib/billing/plan-gate";

const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const USER = "11111111-1111-4111-8111-111111111111";

function resolved(over: Record<string, unknown> = {}) {
  return {
    planId: "free",
    status: "none",
    provider: null,
    periodStartMs: null,
    periodEndMs: null,
    trialUsed: false,
    row: null,
    planRow: null,
    lookupFailed: false,
    ...over,
  };
}

function row(over: Record<string, unknown> = {}) {
  return {
    plan: "plus",
    status: "active",
    provider: "manual",
    current_period_start: "2026-10-01T00:00:00.000Z",
    current_period_end: "2026-10-31T00:00:00.000Z",
    canceled_at: null,
    trial_activated_at: null,
    ...over,
  };
}

describe("getPlanGate — the server-authoritative mapping", () => {
  it("new user with NO subscription row → plan selection is required", async () => {
    resolveMock.mockResolvedValue(resolved({ row: null }));
    const gate = await getPlanGate(USER, NOW);
    expect(gate).toEqual({ selectionRequired: true, trialExpired: false });
    // Deterministic time: the gate's clock is passed through, never Date.now()
    // inside.
    expect(resolveMock).toHaveBeenCalledWith(USER, NOW);
  });

  it("existing user with a valid ACTIVE paid subscription → no redirect, no banner", async () => {
    resolveMock.mockResolvedValue(
      resolved({
        planId: "plus",
        status: "active",
        provider: "mock",
        row: row(),
      }),
    );
    const gate = await getPlanGate(USER, NOW);
    expect(gate).toEqual({ selectionRequired: false, trialExpired: false });
  });

  it("existing user with an ACTIVE trial → no redirect, no banner", async () => {
    resolveMock.mockResolvedValue(
      resolved({
        planId: "trial",
        status: "active",
        row: row({
          plan: "trial",
          trial_activated_at: "2026-10-22T12:00:00.000Z",
        }),
      }),
    );
    const gate = await getPlanGate(USER, NOW);
    expect(gate).toEqual({ selectionRequired: false, trialExpired: false });
  });

  it("EXPIRED trial → banner state, and NOT a forced selection redirect (a selection exists; the engine revoked trial entitlements)", async () => {
    resolveMock.mockResolvedValue(
      resolved({
        planId: "free",
        status: "expired",
        row: row({
          plan: "trial",
          status: "expired",
          current_period_end: "2026-10-23T12:00:00.000Z",
          trial_activated_at: "2026-10-20T12:00:00.000Z",
        }),
      }),
    );
    const gate = await getPlanGate(USER, NOW);
    expect(gate).toEqual({ selectionRequired: false, trialExpired: true });
  });

  it("expired PAID plan → no banner (the banner is trial-specific) and no selection redirect (historical choice; the engine grants NO entitlements)", async () => {
    resolveMock.mockResolvedValue(
      resolved({
        planId: "free",
        status: "expired",
        row: row({ status: "expired" }),
      }),
    );
    const gate = await getPlanGate(USER, NOW);
    expect(gate).toEqual({ selectionRequired: false, trialExpired: false });
  });

  it("canceled row → neither flag (the engine decides what a canceled sub grants)", async () => {
    resolveMock.mockResolvedValue(
      resolved({
        planId: "free",
        status: "canceled",
        row: row({
          status: "canceled",
          canceled_at: "2026-10-20T00:00:00.000Z",
        }),
      }),
    );
    const gate = await getPlanGate(USER, NOW);
    expect(gate).toEqual({ selectionRequired: false, trialExpired: false });
  });

  it("a historical 'free' row → selectionRequired (D9: the permanent Free plan was removed — a free row grants nothing and is no longer a valid selection)", async () => {
    resolveMock.mockResolvedValue(
      resolved({
        planId: "free",
        status: "active",
        row: row({ plan: "free" }),
      }),
    );
    const gate = await getPlanGate(USER, NOW);
    expect(gate).toEqual({ selectionRequired: true, trialExpired: false });
  });

  it("an unknown plan value (normalized to the 'free' sentinel by the resolver) → selectionRequired, fail safe toward plan selection, never toward a grant", async () => {
    resolveMock.mockResolvedValue(
      resolved({
        planId: "free",
        status: "active",
        row: row({ plan: "gold" }), // not a known plan id
      }),
    );
    const gate = await getPlanGate(USER, NOW);
    expect(gate).toEqual({ selectionRequired: true, trialExpired: false });
  });

  it("subscription LOOKUP FAILURE (no row visible) → neither flag: no forced redirect AND no expired-trial banner (expiration unknown)", async () => {
    resolveMock.mockResolvedValue(resolved({ lookupFailed: true, row: null }));
    const gate = await getPlanGate(USER, NOW);
    expect(gate).toEqual({ selectionRequired: false, trialExpired: false });
  });

  it("subscription LOOKUP FAILURE with a stale row → still neither flag", async () => {
    resolveMock.mockResolvedValue(
      resolved({
        lookupFailed: true,
        planId: "trial",
        status: "expired",
        row: row({ plan: "trial", status: "expired" }),
      }),
    );
    const gate = await getPlanGate(USER, NOW);
    expect(gate).toEqual({ selectionRequired: false, trialExpired: false });
  });
});

describe("plan gate — redirect-loop / safe-exit source contract", () => {
  const read = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

  const GATED_TOOL_AREAS = [
    "dashboard",
    "deckblatt",
    "opportunities",
    "bewerbung-automation",
    "bewerbung-scanner",
    "wohnen",
  ];

  it("every protected tool layout: server gate + redirect + conditional banner", () => {
    for (const area of GATED_TOOL_AREAS) {
      const src = read(`src/app/${area}/layout.tsx`);
      expect(src, area).toContain("await getPlanGate(user.id)");
      expect(src, area).toContain(
        'if (gate.selectionRequired) redirect("/settings/billing")',
      );
      expect(src, area).toContain(
        "topNotice={gate.trialExpired ? <TrialExpiredNotice /> : undefined}",
      );
    }
  });

  it("the AI area (fragment layout) uses the same gate and the same banner condition", () => {
    const src = read("src/app/ai/layout.tsx");
    expect(src).toContain("await getPlanGate(user.id)");
    expect(src).toContain(
      'if (gate.selectionRequired) redirect("/settings/billing")',
    );
    expect(src).toContain("{gate.trialExpired && <TrialExpiredNotice />}");
  });

  it("safe exit: the settings area (plan selection, account settings, sign-out, support) shows the banner but NEVER redirects on selectionRequired", () => {
    const src = read("src/app/settings/layout.tsx");
    expect(src).toContain("await getPlanGate(user.id)");
    expect(src).toContain("<TrialExpiredNotice />");
    expect(src).not.toContain("selectionRequired) redirect");
  });

  it("the redirect TARGET (/settings/billing) is never gated → a redirect loop is structurally impossible", () => {
    const page = read("src/app/settings/billing/page.tsx");
    expect(page).not.toContain("getPlanGate");
    expect(page).not.toContain('redirect("/settings/billing")');
    expect(
      existsSync(
        resolve(__dirname, "..", "src/app/settings/billing/layout.tsx"),
      ),
    ).toBe(false);
  });

  it("authentication entry points are ungated (no gate on /login)", () => {
    const login = read("src/app/login/page.tsx");
    expect(login).not.toContain("getPlanGate");
  });

  it("AppShell renders the server-supplied notice ABOVE <main> (prominent, near the top)", () => {
    const src = read("src/components/app-shell.tsx");
    const noticeIdx = src.indexOf("{topNotice}");
    const mainIdx = src.indexOf("<main");
    expect(noticeIdx).toBeGreaterThan(-1);
    expect(mainIdx).toBeGreaterThan(noticeIdx);
  });
});
