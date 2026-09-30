import { FaqPage } from "@/components/faq";

export const dynamic = "force-dynamic";

/**
 * FAQ — Frequently Asked Questions.
 *
 * The dashboard layout already handles auth (login / email confirmation /
 * onboarding redirects), so this page only renders the client FAQ UI. Content
 * is static and fully localized (de/en/fr/ar); search + filtering are local
 * and instant (no API round-trip).
 */
export default function FaqRoutePage() {
  return <FaqPage />;
}
