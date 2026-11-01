import type { Metadata } from "next";
import {
  getBewCampaignView,
  getLatestBewCampaignId,
  hasBewAutomationSchema,
  type BewCampaignView,
} from "@/lib/bewerbung-engine";
import { BewerbungAutomation } from "@/components/bewerbung-automation/client";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Bewerbungs Studio",
};

/**
 * /bewerbung-automation — server component (data loader).
 *
 * The layout already guarantees an authenticated, ACTIVE user and renders the
 * global shell. Here we only resolve the INITIAL state for the client:
 *
 *   - whether the isolated `bew_*` schema is applied (this repo applies
 *     migrations manually, so code may run ahead of the schema — we degrade
 *     to a "pending" notice instead of crashing);
 *   - the most recent campaign + its applications/documents/usage snapshot,
 *     so a returning user lands directly on the right step.
 *
 * All interactivity (the five steps, uploads, generation, send) lives in the
 * client component, which talks to the dedicated server actions — never to
 * the protected standard-email path.
 */
export default async function BewerbungAutomationPage() {
  const { getCurrentUserAndProfile } = await import("@/lib/auth");
  const { user, profile } = await getCurrentUserAndProfile();

  const schemaOk = await hasBewAutomationSchema();

  let view: BewCampaignView | null = null;
  let initialLoadError = false;
  if (schemaOk && user && profile && profile.account_status === "active") {
    // A FAILED initial read is NOT an empty result: the client must show an
    // actionable retry state, never the "no series" empty state (the data
    // may exist — the query just did not succeed).
    try {
      const latestId = await getLatestBewCampaignId(profile.id);
      if (latestId) view = await getBewCampaignView(profile.id, latestId);
    } catch (error) {
      console.error("[bewerbung-automation] initial view load failed", error);
      initialLoadError = true;
    }
  }

  return (
    <BewerbungAutomation
      schemaOk={schemaOk}
      initialView={view}
      initialLoadError={initialLoadError}
      userName={profile?.full_name ?? ""}
      userEmail={profile?.email ?? ""}
    />
  );
}
