import { CvBuilder } from "@/components/cv-builder";
import { getCurrentUserAndProfile } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Templates — CV Builder.
 *
 * The dashboard layout already handles auth (login / email confirmation /
 * onboarding redirects), so this page only resolves the session user to
 * hand the builder its identity: the user id scopes localStorage
 * persistence, and the account profile name/email pre-fill the (empty)
 * personal details — never fabricated, always the user's own data.
 * The actual CV content is edited + stored client-side and can be
 * imported from the latest Bewerbung Scanner candidate profile.
 */
export default async function TemplatesPage() {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user) return null;
  return (
    <CvBuilder
      userId={user.id}
      profileFullName={profile?.full_name ?? ""}
      profileEmail={user.email ?? ""}
    />
  );
}
