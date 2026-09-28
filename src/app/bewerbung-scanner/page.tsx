import Link from "next/link";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { BewerbungScannerUpload } from "@/components/bewerbung-scanner-upload";

export const dynamic = "force-dynamic";
export default async function BewerbungScannerPage() {
  const { profile } = await getCurrentUserAndProfile();
  if (!profile) return null;
  return (
    <>
      <div className="mx-auto max-w-5xl px-5 pt-6 sm:px-8 lg:px-10">
        <Link
          href="/dashboard"
          className="text-sm font-semibold text-[#2f6fed]"
        >
          ← Back to dashboard
        </Link>
      </div>
      <BewerbungScannerUpload profile={profile} />
    </>
  );
}
