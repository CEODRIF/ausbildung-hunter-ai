"use server";

import { redirect } from "next/navigation";
import {
  deleteEmailAccount,
  revokeEmailAuthorization,
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
  try {
    await revokeEmailAuthorization(user.id, accountId);
    await deleteEmailAccount(user.id, accountId);
  } catch {
    redirect("/settings/email?error=disconnect_failed");
  }
  redirect("/settings/email?disconnected=1");
}
