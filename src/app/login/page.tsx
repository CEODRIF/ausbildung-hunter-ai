import { AuthShell } from "@/components/auth-shell";
import { LoginForm } from "@/app/login/login-form";

/**
 * Sign-in page.
 *
 * `?error=suspended` is the bounce target of the protected layouts
 * (dashboard / onboarding) for accounts whose profile is suspended. It used to
 * be dropped on the floor — the user landed on a bare sign-in form with no
 * explanation of why they were sent back. The notice is rendered through the
 * form's initial error state, so the message and the submit feedback share one
 * place in the UI.
 */
const NOTICES: Record<string, string> = {
  suspended:
    "Your account has been suspended. Please contact support if you believe this is a mistake.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.error;
  const code = Array.isArray(raw) ? raw[0] : raw;
  const notice = code ? NOTICES[code] : undefined;

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to continue building your next chapter."
    >
      <LoginForm initialError={notice} />
    </AuthShell>
  );
}
