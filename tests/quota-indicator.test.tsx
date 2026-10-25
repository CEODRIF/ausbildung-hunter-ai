// @vitest-environment jsdom
/**
 * BEHAVIORAL render tests for the ONE shared quota indicator (P0 quota
 * audit, 2026-10-25). All 13 quota surfaces render through this component,
 * so its state machine is the single source of display truth:
 *
 *   - healthy  → GREEN (success tokens) with used/limit, remaining, unit
 *                AND the reset label — never a bare number;
 *   - limit 0  → "unavailable" + upgrade hint, no numbers;
 *   - limit null WITHOUT the server's `unlimited` flag → unknown (a missing
 *                value is NEVER inferred as "unlimited" — regression for
 *                the deckblatt generate response, which carries no limit);
 *   - null used/remaining → honest unknown, never a fabricated 0-of-X;
 *   - remaining 0 → limit-reached (danger) + reset label;
 *   - loading  → placeholder with NO numbers at all.
 */
import "@testing-library/jest-dom/vitest";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  QuotaIndicator,
  makeQuotaLabels,
  quotaDataFromEntitlement,
} from "@/components/quota-indicator";
import type { FeatureEntitlement } from "@/lib/billing/entitlement-service";

const t = (path: string): string => {
  const map: Record<string, string> = {
    "quota.unknown": "Unknown",
    "quota.unlimited": "Unlimited",
    "quota.unavailable": "Unavailable",
    "quota.remaining": "left",
    "quota.limitReached": "Limit reached",
  };
  return map[path] ?? path;
};
const labels = makeQuotaLabels(t);

function renderPill(props: Partial<Parameters<typeof QuotaIndicator>[0]> = {}) {
  return render(
    <QuotaIndicator
      data={{ used: 7, limit: 50, remaining: 43 }}
      unit="emails"
      resetLabel="Resets daily (00:00 UTC)"
      labels={labels}
      {...props}
    />,
  );
}

describe("QuotaIndicator — shared state machine (P0 quota audit)", () => {
  it("healthy state is GREEN and shows used/limit, remaining, unit AND reset label", () => {
    const { container } = renderPill();
    const pill = container.querySelector("[role=status]")!;
    expect(pill.className).toContain("text-success");
    expect(pill.className).toContain("bg-success-soft");
    expect(pill.textContent).toContain("7/50 emails");
    expect(pill.textContent).toContain("43 left");
    expect(pill.textContent).toContain("Resets daily (00:00 UTC)");
  });

  it("limit 0 → unavailable + upgrade hint, NO numbers, neutral tone", () => {
    const { container } = renderPill({
      data: { used: 0, limit: 0, remaining: 0 },
      upgradeHint: "Upgrade",
    });
    const pill = container.querySelector("[role=status]")!;
    expect(pill.textContent).toContain("Unavailable");
    expect(pill.textContent).toContain("Upgrade");
    expect(pill.textContent).not.toContain("0/0");
    expect(pill.className).toContain("text-muted");
  });

  it("`unlimited` ONLY on the server's explicit flag — green unlimited", () => {
    const { container } = renderPill({
      data: { used: 0, limit: null, remaining: null, unlimited: true },
    });
    const pill = container.querySelector("[role=status]")!;
    expect(pill.textContent).toContain("Unlimited");
    expect(pill.className).toContain("text-success");
  });

  it("limit null WITHOUT the unlimited flag → unknown (partial payloads never read as unlimited)", () => {
    const { container } = renderPill({
      // The deckblatt generate response shape: used/remaining known, no limit.
      data: { used: 1, limit: null, remaining: 0 },
    });
    const pill = container.querySelector("[role=status]")!;
    expect(pill.textContent).toContain("Unknown");
    expect(pill.textContent).not.toContain("Unlimited");
  });

  it("failed quota read (nulls) → honest unknown, never a fabricated 0-of-0", () => {
    const { container } = renderPill({
      data: { used: null, limit: null, remaining: null },
    });
    const pill = container.querySelector("[role=status]")!;
    expect(pill.textContent).toContain("Unknown");
    expect(pill.textContent).not.toContain("0/");
  });

  it("remaining 0 → limit-reached (danger tone) WITH the reset label", () => {
    const { container } = renderPill({
      data: { used: 50, limit: 50, remaining: 0 },
    });
    const pill = container.querySelector("[role=status]")!;
    expect(pill.textContent).toContain("Limit reached");
    expect(pill.textContent).toContain("Resets daily (00:00 UTC)");
    expect(pill.className).toContain("text-danger");
  });

  it("loading → placeholder with NO numbers", () => {
    const { container } = renderPill({
      loading: true,
      data: { used: null, limit: null, remaining: null },
    });
    const pill = container.querySelector("[role=status]")!;
    expect(pill.textContent).toContain("…");
    expect(pill.textContent).not.toContain("Unknown");
  });

  it("bar variant renders the progress bar with the real percentage", () => {
    const { container } = renderPill({ variant: "bar" });
    const bar = container.querySelector(".bg-success") as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.style.width).toBe("14%"); // 7/50 = 14%
  });
});

describe("quotaDataFromEntitlement — UI/enforcement parity glue", () => {
  const base = {
    planId: "premium_10d",
    featureId: "automation",
    subscriptionExpiresAt: null,
  };
  const entitlement = (over: Partial<FeatureEntitlement>): FeatureEntitlement =>
    ({
      ...base,
      allowed: true,
      reason: "ok",
      limit: 10,
      used: 3,
      remaining: 7,
      resetsAt: 1799999999999,
      ...over,
    }) as FeatureEntitlement;

  it("ok → real numbers", () => {
    expect(quotaDataFromEntitlement(entitlement({}))).toEqual({
      used: 3,
      limit: 10,
      remaining: 7,
      unlimited: false,
    });
  });

  it("lookup_error → all nulls (the read FAILED — unknown, not 0-of-0)", () => {
    expect(
      quotaDataFromEntitlement(
        entitlement({
          reason: "lookup_error",
          allowed: false,
          limit: 0,
          used: 0,
          remaining: 0,
        }),
      ),
    ).toEqual({ used: null, limit: null, remaining: null });
  });

  it("unmetered (limit null, reason ok) → unlimited: true (server-confirmed)", () => {
    const data = quotaDataFromEntitlement(
      entitlement({
        reason: "ok_legacy_unmetered",
        allowed: true,
        limit: null,
        used: 0,
        remaining: null,
      }),
    );
    expect(data.unlimited).toBe(true);
  });

  it("feature_disabled (limit 0) → unavailable state data, not unlimited", () => {
    const data = quotaDataFromEntitlement(
      entitlement({
        reason: "feature_disabled",
        allowed: false,
        limit: 0,
        used: 0,
        remaining: 0,
      }),
    );
    expect(data.limit).toBe(0);
    expect(data.unlimited).toBe(false);
  });
});
