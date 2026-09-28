"use server";

import { redirect } from "next/navigation";
import { activateQuotaCode } from "@/lib/email-campaigns";

export async function activateQuota(formData: FormData) {
  const code = String(formData.get("code") ?? "").trim();
  if (!code) redirect("/settings/usage?error=missing_code");
  try {
    await activateQuotaCode(code);
  } catch (error) {
    redirect(
      `/settings/usage?error=${encodeURIComponent(error instanceof Error ? error.message : "activation_failed")}`,
    );
  }
  redirect("/settings/usage?activated=1");
}
