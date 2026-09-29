import { getCurrentUserAndProfile } from "@/lib/auth";
import { BewerbungScannerUpload } from "@/components/bewerbung-scanner-upload";

export const dynamic = "force-dynamic";
export default async function BewerbungScannerPage() {
  const { profile } = await getCurrentUserAndProfile();
  if (!profile) return null;
  return <BewerbungScannerUpload profile={profile} />;
}
