import { AuthShell } from "@/components/auth-shell";
import { RegisterForm } from "@/app/register/register-form";

export default function RegisterPage() {
  return (
    <AuthShell
      title="Create your workspace"
      subtitle="Start organizing your path toward the right opportunity."
    >
      <RegisterForm />
    </AuthShell>
  );
}
