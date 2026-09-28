import { AuthShell } from "@/components/auth-shell";
import { LoginForm } from "@/app/login/login-form";

export default function LoginPage() {
  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to continue building your next chapter."
    >
      <LoginForm />
    </AuthShell>
  );
}
