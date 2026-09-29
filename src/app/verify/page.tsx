import Link from "next/link";
import { AuthShell } from "@/components/auth-shell";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { ResendForm } from "@/app/verify/resend-form";

/**
 * Destination for accounts that are NOT yet email-confirmed: tells the user
 * a confirmation link was sent to their email and offers a resend
 * (supabase.auth.resend — pure Supabase).
 *
 * The page is state-aware: a user whose email IS confirmed (e.g. inconsistent
 * account data) sees an accurate message instead of "check your email".
 */
export default async function VerifyPage() {
  const { user } = await getCurrentUserAndProfile();
  const confirmed = Boolean(user?.email_confirmed_at);

  return (
    <AuthShell
      title={
        confirmed
          ? "We couldn't finish setting up your account"
          : "Check your email"
      }
      subtitle={
        confirmed
          ? "Your email address is already confirmed."
          : "We sent a verification link to your email address."
      }
    >
      <div className="space-y-5">
        {confirmed ? (
          <>
            <p className="text-sm leading-6 text-muted">
              Your email is confirmed, but your account data looks incomplete.
              Please sign in again — if the problem persists, contact support.
            </p>
            <p className="text-center text-sm text-muted">
              <Link
                href="/login"
                className="font-semibold text-accent hover:text-accent-deep"
              >
                Go to sign in
              </Link>
            </p>
          </>
        ) : (
          <>
            <p className="text-sm leading-6 text-muted">
              Click the link in the email to activate your account — it takes
              you straight to setup. If it doesn&apos;t arrive within a few
              minutes, check your spam folder or request another link below.
            </p>
            <ResendForm />
            <div className="space-y-2 text-center">
              <p className="text-sm text-muted">
                <Link
                  href="/login"
                  className="font-semibold text-accent hover:text-accent-deep"
                >
                  Go to sign in
                </Link>
              </p>
              <p className="text-sm text-muted">
                <Link
                  href="/register"
                  className="font-semibold text-accent hover:text-accent-deep"
                >
                  Register with a different email
                </Link>
              </p>
            </div>
          </>
        )}
      </div>
    </AuthShell>
  );
}
