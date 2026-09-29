import Link from "next/link";
import { AuthShell } from "@/components/auth-shell";
import { ResendForm } from "@/app/verify/resend-form";

/**
 * The 6-digit verification code flow is gone — account activation now happens
 * through the Supabase Auth confirmation link. This page is the destination
 * for signed-in users whose email is not (yet) confirmed: it tells them a
 * link was sent to their email and offers a resend.
 */
export default function VerifyPage() {
  return (
    <AuthShell
      title="Check your email"
      subtitle="We sent a verification link to your email address."
    >
      <div className="space-y-5">
        <p className="text-sm leading-6 text-[#71819a]">
          Click the link in the email to activate your account — it takes you
          straight to setup. If it doesn&apos;t arrive within a few minutes,
          check your spam folder or request another link below.
        </p>
        <ResendForm />
        <div className="space-y-2 text-center">
          <p className="text-sm text-[#71819a]">
            <Link
              href="/login"
              className="font-semibold text-[#2f6fed] hover:text-[#255dcc]"
            >
              Go to sign in
            </Link>
          </p>
          <p className="text-sm text-[#71819a]">
            <Link
              href="/register"
              className="font-semibold text-[#2f6fed] hover:text-[#255dcc]"
            >
              Register with a different email
            </Link>
          </p>
        </div>
      </div>
    </AuthShell>
  );
}
