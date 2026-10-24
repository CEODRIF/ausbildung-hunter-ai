import { getCurrentUserAndProfile } from "@/lib/auth";
import { BewerbungScannerUpload } from "@/components/bewerbung-scanner-upload";
import {
  checkFeature,
  effectiveUploadLimitMbForUser,
} from "@/lib/billing/entitlement-service";

export const dynamic = "force-dynamic";
export default async function BewerbungScannerPage() {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile) return null;
  // TRUE per-file cap for this plan (server-derived): min(plan cap, 10 MB
  // platform ceiling) — the drop hint must not promise 10 MB to a trial
  // user whose plan cap is 2 MB (P0 quota audit, upload-size copy).
  const fileLimitMb = await effectiveUploadLimitMbForUser(user.id);
  // Canonical scanner entitlement for the shared quota indicator (P0 quota
  // audit): this surface previously showed no quota state at all.
  const scannerEntitlement = await checkFeature(user.id, "scanner");
  return (
    <BewerbungScannerUpload
      profile={profile}
      fileLimitMb={fileLimitMb}
      scannerEntitlement={scannerEntitlement}
    />
  );
}
