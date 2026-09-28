"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { deleteScan, updateCandidateProfile } from "@/lib/bewerbung-scanner";
import { candidateProfileSchema } from "@/lib/bewerbung-schema";

export async function saveCandidateProfile(formData: FormData) {
  const scanId = String(formData.get("scanId") ?? "");
  const profileJson = String(formData.get("profileJson") ?? "");
  const profile = candidateProfileSchema.parse(JSON.parse(profileJson));
  await updateCandidateProfile(scanId, profile);
}

/** Phase 16 — user-initiated scan deletion (server action; the UI
 *  button is only the trigger — ownership + cascades + storage sweep
 *  are enforced in the lib). */
export async function deleteScanAction(formData: FormData): Promise<void> {
  const scanId = String(formData.get("scanId") ?? "");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      scanId,
    )
  )
    redirect("/bewerbung-scanner");
  try {
    await deleteScan(scanId);
  } catch {
    // "Scan not found" (e.g. double submit) and real failures land in
    // the same place: back to the scanner list. No error details are
    // surfaced to the UI.
  }
  revalidatePath("/bewerbung-scanner");
  redirect("/bewerbung-scanner?deleted=1");
}
