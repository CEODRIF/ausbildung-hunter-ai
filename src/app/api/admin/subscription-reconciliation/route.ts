import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/billing/admin";
import { checkRateLimit, tooManyRequests } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { isPlanId } from "@/lib/billing/plans";
import { classifyRawSubscription } from "@/lib/billing/entitlement-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/subscription-reconciliation — READ-ONLY reconciliation
 * report (the 2026-10-24 entitlement-fix Phase 4 dry-run).
 *
 * What it does: classifies every subscription row with the same
 * server-authoritative state machine the entitlement resolver uses
 * (classifyRawSubscription) and flags inconsistencies for MANUAL owner
 * decision:
 *   - unknown_plan:            plan value outside the known catalog
 *   - no_profile:              subscription user has no profile row
 *   - profile_not_active:      profile suspended/pending
 *   - canceled_future_end:     canceled with period end still in the future
 *                              (informational: per the documented rule the
 *                              entitlement already ended at cancellation;
 *                              the end date is display-only)
 *   - email_shared_with_other_account: the profile email belongs to MORE
 *                              THAN ONE account and at least one of them
 *                              holds a subscription row — the signature of
 *                              a mis-linked row (e.g. the known Pro row on
 *                              the wrong user id). FLAGGED ONLY: this
 *                              endpoint never reassigns, repairs, or
 *                              mutates anything.
 *
 * What it never does: writes, repairs ownership, grants or revokes
 * entitlements, or uses the historical plan label for any decision.
 * Auth: requireAdmin (server session) + admin rate limit. SELECTs only.
 */

const REPORT_LIMIT = 5000;

interface SubRow {
  user_id: string;
  plan: string;
  status: string;
  provider: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  canceled_at: string | null;
  trial_activated_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

interface ProfileRow {
  id: string;
  email: string;
  full_name: string | null;
  account_status: string;
}

export async function GET(): Promise<NextResponse> {
  const adminUser = await requireAdmin();
  if (!adminUser)
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  const limited = await checkRateLimit("admin_actions", adminUser.id);
  if (!limited.allowed) return tooManyRequests(limited);

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    // Missing/misconfigured service role: fail closed, nothing to report.
    return NextResponse.json(
      { error: "Service unavailable." },
      { status: 503 },
    );
  }

  const { data: subData, error: subError } = await admin
    .from("subscriptions")
    .select(
      "user_id, plan, status, provider, current_period_start, current_period_end, canceled_at, trial_activated_at, created_at, updated_at",
    )
    .limit(REPORT_LIMIT);
  if (subError || !subData) {
    return NextResponse.json(
      { error: "Subscription report unavailable." },
      { status: 503 },
    );
  }
  const rows = subData as SubRow[];

  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const profiles = new Map<string, ProfileRow>();
  if (userIds.length > 0) {
    // .in() supports at most a few hundred values per call: batch to be safe.
    const BATCH = 200;
    for (let i = 0; i < userIds.length; i += BATCH) {
      const batch = userIds.slice(i, i + BATCH);
      const { data, error } = await admin
        .from("profiles")
        .select("id, email, full_name, account_status")
        .in("id", batch);
      if (error || !data) continue; // profiles are advisory in this report
      for (const p of data as ProfileRow[]) profiles.set(p.id, p);
    }
  }

  // Mis-link signature: a subscription holder whose email is ALSO used by
  // another account. The holder's profile alone is not enough (the other
  // account usually has NO subscription row), so query all profiles that
  // carry one of the holder emails (case-insensitive grouping; both the
  // stored and lowercased spellings are matched). Heuristic FLAG only —
  // final ownership decisions are manual (see the runbook in the PR).
  const holderEmails = new Map<string, string>(); // lowercased → stored
  for (const p of profiles.values()) {
    const stored = p.email?.trim();
    if (!stored) continue;
    holderEmails.set(stored.toLowerCase(), stored);
  }
  const sharedEmails = new Set<string>();
  const allEmails = [
    ...new Set([...holderEmails.values(), ...holderEmails.keys()]),
  ];
  for (let i = 0; i < allEmails.length; i += 100) {
    const values = allEmails.slice(i, i + 100);
    const { data, error } = await admin
      .from("profiles")
      .select("id, email")
      .in("email", values);
    if (error || !data) continue;
    const countByEmail = new Map<string, number>();
    for (const p of data as Array<{ id: string; email: string }>) {
      const key = p.email?.trim().toLowerCase() ?? "";
      if (!key) continue;
      countByEmail.set(key, (countByEmail.get(key) ?? 0) + 1);
    }
    for (const [key, n] of countByEmail) if (n > 1) sharedEmails.add(key);
  }
  // Pending payments (state v2): an in-flight mock checkout is "payment
  // pending" — it grants NOTHING until verified completion (which writes
  // the subscription row). Listed separately so the report can classify
  // "pending payment" accounts even before any subscription row exists.
  let pendingCheckouts: Array<{
    user_id: string;
    plan_id: string;
    status: string;
    created_at: string | null;
    expires_at: string | null;
  }> = [];
  try {
    const { data: pcData, error: pcError } = await admin
      .from("mock_checkouts")
      .select("user_id, plan_id, status, created_at, expires_at")
      .eq("status", "pending")
      .limit(REPORT_LIMIT);
    if (!pcError && pcData)
      pendingCheckouts = pcData as (typeof pendingCheckouts)[number][];
  } catch {
    pendingCheckouts = []; // advisory section — the report itself must not fail
  }
  const pendingByUser = new Set(pendingCheckouts.map((c) => c.user_id));

  const nowMs = Date.now();
  const totals: Record<string, number> = {
    none: 0,
    active: 0,
    canceled: 0,
    expired: 0,
    invalid: 0,
  };
  const stateTotals: Record<string, number> = {};
  const report = rows.map((r) => {
    const profile = profiles.get(r.user_id) ?? null;
    const classified = classifyRawSubscription(
      {
        plan: r.plan,
        status: r.status,
        current_period_end: r.current_period_end,
      },
      { nowMs },
    );
    totals[classified] = (totals[classified] ?? 0) + 1;

    // State v2 (docs/subscription-system-design-2026-10-24 §2/§7): the
    // fine-grained classification the reconciliation report must show.
    const endMs = r.current_period_end
      ? Date.parse(r.current_period_end)
      : null;
    const computedExpired =
      r.status === "active" &&
      endMs !== null &&
      !Number.isNaN(endMs) &&
      endMs <= nowMs;
    let state: string;
    if (classified === "canceled") state = "canceled";
    else if (classified === "expired")
      state = r.plan === "trial" ? "trial_expired" : "expired";
    else if (classified === "active") {
      if (r.plan === "trial") state = "trial_active";
      else if (r.provider === "manual") state = "admin_granted";
      else state = "paid_active";
    } else if (classified === "none") {
      // An existing row that grants no plan entitlements (plan 'free').
      state = "invalid";
    } else state = classified; // 'invalid' (lookup failure — not expected on raw rows)
    if (computedExpired && classified === "active")
      state = r.plan === "trial" ? "trial_expired" : "expired";
    stateTotals[state] = (stateTotals[state] ?? 0) + 1;

    const flags: string[] = [];
    if (!isPlanId(r.plan)) flags.push("unknown_plan");
    if (!profile) flags.push("no_profile");
    else if (profile.account_status !== "active")
      flags.push("profile_not_active");
    if (r.status === "canceled" && r.current_period_end) {
      const end = Date.parse(r.current_period_end);
      if (!Number.isNaN(end) && end > nowMs) flags.push("canceled_future_end");
    }
    if (
      profile?.email &&
      sharedEmails.has(profile.email.trim().toLowerCase())
    ) {
      flags.push("email_shared_with_other_account");
    }

    return {
      user_id: r.user_id,
      email: profile?.email ?? null,
      full_name: profile?.full_name ?? null,
      profile_status: profile?.account_status ?? null,
      plan: r.plan,
      status: r.status,
      provider: r.provider,
      current_period_start: r.current_period_start,
      current_period_end: r.current_period_end,
      canceled_at: r.canceled_at,
      trial_activated_at: r.trial_activated_at,
      classified,
      state,
      pending_checkout: pendingByUser.has(r.user_id),
      flags,
    };
  });

  return NextResponse.json({
    generatedAt: new Date(nowMs).toISOString(),
    read_only: true,
    truncated: rows.length >= REPORT_LIMIT,
    totals,
    stateTotals,
    pendingCheckouts,
    // Accounts with NO subscription row at all (never selected a plan,
    // one-trial never used) do not appear in this row-based report — they
    // are the `selection_required` population, handled per-user by the
    // plan gate at request time (src/lib/billing/plan-gate.ts).
    note: "Row-based report: accounts without any subscription row (never selected a plan) are not listed; they are enforced per-user by the plan-selection gate.",
    rows: report,
  });
}
