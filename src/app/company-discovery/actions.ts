"use server";

import { getCurrentUserAndProfile } from "@/lib/auth";
import { createDiscoveryDraft } from "@/lib/company-discovery/campaigns";

/**
 * "Create campaign from selection" on /company-discovery.
 *
 * The session is resolved on the server (the client never supplies an id) and
 * the work itself lives in the feature module, so it is unit-testable without
 * a request. The draft is persisted immediately — closing the page, a refresh
 * or a re-login never loses it.
 */
export interface CreateDiscoveryDraftState {
  ok: boolean;
  draftId?: string;
  /** false when the draft was saved WITHOUT its run link (schema drift). */
  linked?: boolean;
  /** Machine code the UI maps to a translated message (never internals). */
  code?: string;
}

export async function createDiscoveryDraftAction(input: {
  runId: string;
  recipients: Array<{ email: string; companyName?: string | null }>;
}): Promise<CreateDiscoveryDraftState> {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    return { ok: false, code: "unauthorized" };
  if (!input.runId || !Array.isArray(input.recipients) || input.recipients.length === 0)
    return { ok: false, code: "invalid_params" };

  const result = await createDiscoveryDraft({
    userId: user.id,
    runId: input.runId,
    recipients: input.recipients,
  });
  return result.ok
    ? { ok: true, draftId: result.draftId, linked: result.linked }
    : { ok: false, code: result.code };
}
