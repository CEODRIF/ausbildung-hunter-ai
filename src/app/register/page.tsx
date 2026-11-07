import { AuthShell } from "@/components/auth-shell";
import { RegisterForm } from "@/app/register/register-form";
import { getServerT } from "@/lib/i18n/server";

export default async function RegisterPage() {
  const t = await getServerT();
  return (
    <AuthShell
      title={t("auth.registerTitle")}
      subtitle={t("auth.registerSubtitle")}
    >
      <RegisterForm />
    </AuthShell>
  );
}
