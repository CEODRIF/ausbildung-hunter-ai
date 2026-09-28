"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  assertDraftOwnership,
  assertSenderOwnership,
} from "@/lib/application-drafts";
import {
  deleteEmailAccount,
  getDisconnectBlockers,
  revokeEmailAuthorization,
  type DisconnectBlockers,
} from "@/lib/email-oauth";
import { createAdminClient } from "@/lib/supabase/admin";
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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Phase 18 — reassign a draft's sender to another email account owned by the
 * same user, unblocking a disconnect. Changes ONLY `sender_email_account_id`
 * (subject/body, recipients, attachments and opportunity data are separate
 * rows/columns and stay untouched).
 *
 * Server-side verification only:
 * - both ids must be UUIDs (before any DB access),
 * - the draft must belong to the session user (`assertDraftOwnership`),
 * - the destination account must exist, belong to the session user and be
 *   active/connected (`assertSenderOwnership`).
 * A client-supplied `user_id` is never trusted. Every failure path
 * (foreign/missing draft, foreign/missing/inactive account, DB error) lands
 * on the same fixed, generic redirect — no DB/FK/internal details leak.
 */
export async function reassignDraftSender(formData: FormData): Promise<void> {
  const draftId = String(formData.get("draftId") ?? "");
  const emailAccountId = String(formData.get("emailAccountId") ?? "");
  if (!UUID_RE.test(draftId) || !UUID_RE.test(emailAccountId))
    redirect("/settings/email?error=reassign_failed");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  try {
    await assertDraftOwnership(user.id, draftId);
    const destination = await assertSenderOwnership(user.id, emailAccountId);
    const admin = createAdminClient();
    const { error } = await admin
      .from("application_drafts")
      .update({ sender_email_account_id: destination.id })
      .eq("id", draftId)
      .eq("user_id", user.id);
    if (error) throw new Error("Unable to reassign draft sender.");
  } catch {
    redirect("/settings/email?error=reassign_failed");
  }
  revalidatePath("/settings/email");
  revalidatePath("/applications/new");
  redirect("/settings/email?reassigned=1");
}
