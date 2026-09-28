"use server";

import { updateCandidateProfile } from "@/lib/bewerbung-scanner";
import { candidateProfileSchema } from "@/lib/bewerbung-schema";

export async function saveCandidateProfile(formData: FormData) {
  const scanId = String(formData.get("scanId") ?? "");
  const profileJson = String(formData.get("profileJson") ?? "");
  const profile = candidateProfileSchema.parse(JSON.parse(profileJson));
  await updateCandidateProfile(scanId, profile);
}
