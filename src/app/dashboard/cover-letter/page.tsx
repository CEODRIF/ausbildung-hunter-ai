import { CoverLetterBuilder } from "@/components/cover-letter-builder";
import { getCurrentUserAndProfile } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Cover Letter — Anschreiben Builder.
 *
 * The dashboard layout already handles auth (login / email confirmation /
 * onboarding redirects), so this page only resolves the session user to
 * hand the builder its identity. The user id scopes the per-user
 * localStorage persistence; all letter content is edited and stored
 * client-side, can be imported from the latest scanner candidate profile
 * and from the user's CV, and is printed via a dedicated A4 portal so the
 * exported PDF is exactly the letter — nothing else. The account profile
 * itself is not needed (the letter is never filled by guessing).
 */
export default async function CoverLetterPage() {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return null;
  return <CoverLetterBuilder userId={user.id} />;
}
