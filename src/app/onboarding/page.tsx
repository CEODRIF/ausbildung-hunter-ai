import { AuthShell } from "@/components/auth-shell";
import { OnboardingForm } from "@/app/onboarding/onboarding-form";
import { getServerT } from "@/lib/i18n/server";

export default async function OnboardingPage() {
  const t = await getServerT();
  return (
    <AuthShell
      title={t("auth.onboardingTitle")}
      subtitle={t("auth.onboardingSubtitle")}
    >
      <OnboardingForm />
    </AuthShell>
  );
}
