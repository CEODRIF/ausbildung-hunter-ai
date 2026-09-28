"use server";

import { redirect } from "next/navigation";
import {
  deleteEmailAccount,
  getDisconnectBlockers,
  revokeEmailAuthorization,
  type DisconnectBlockers,
} from "@/lib/email-oauth";
import { createClient } from "@/lib/supabase/server";

export async function disconnectEmailAccount(
  formData: FormData,
): Promise<void> {
  const accountId = String(formData.get("accountId") ?? "");
  if (!accountId) redirect("/settings/email?error=account_not_found");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  // Phase 15 — deterministic, server-derived usage guards BEFORE any
  // destructive step (no partial revoke on a blocked disconnect).
  // (redirect() throws — the catch must cover only the count query.)
  let blockers: DisconnectBlockers;
  try {
    blockers = await getDisconnectBlockers(user.id, accountId);
  } catch {
    redirect("/settings/email?error=disconnect_failed");
  }
  if (blockers.activeCampaigns > 0)
    redirect("/settings/email?error=active_campaigns");
  if (blockers.drafts > 0) redirect("/settings/email?error=drafts_in_use");
  try {
    await revokeEmailAuthorization(user.id, accountId);
    await deleteEmailAccount(user.id, accountId);
  } catch {
    redirect("/settings/email?error=disconnect_failed");
  }
  redirect("/settings/email?disconnected=1");
}
