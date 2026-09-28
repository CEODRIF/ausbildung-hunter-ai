import { AuthShell } from "@/components/auth-shell";
import { OnboardingForm } from "@/app/onboarding/onboarding-form";

export default function OnboardingPage() {
  return (
    <AuthShell
      title="What are you looking for?"
      subtitle="Choose one to personalize your workspace. You can update this later."
    >
      <OnboardingForm />
    </AuthShell>
  );
}
