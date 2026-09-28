import Link from "next/link";
import { AuthShell } from "@/components/auth-shell";
import { VerifyForm } from "@/app/verify/verify-form";

export default function VerifyPage() {
  return (
    <AuthShell
      title="Verify your email"
      subtitle="Enter the 6-digit code to activate your workspace."
    >
      <VerifyForm />
      <p className="mt-8 text-center text-sm text-[#71819a]">
        Need to start over?{" "}
        <Link href="/login" className="font-semibold text-[#2f6fed]">
          Return to sign in
        </Link>
      </p>
    </AuthShell>
  );
}
