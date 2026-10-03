import type { Metadata } from "next";
import { DeckblattGenerator } from "@/components/deckblatt-generator";
import { DeckblattComingSoon } from "@/components/deckblatt-coming-soon";
import { DECKBLATT_COMING_SOON } from "@/lib/deckblatt/availability";

/**
 * /deckblatt — AI Deckblatt Generator.
 *
 * Server component. Auth + shell come from the layout; all generator state, the
 * photo (which never leaves the browser) and the local rendering live in the
 * client component.
 *
 * The feature is currently parked (see `@/lib/deckblatt/availability`): while
 * DECKBLATT_COMING_SOON is true this route renders the Coming Soon page and
 * <DeckblattGenerator /> is never mounted — so the form, the portrait upload,
 * the design selection, the "Create Deckblatt" button, the quota indicator and
 * the status request all stay out of the page, and nothing talks to
 * /api/deckblatt/*. No generator code was removed: flipping the constant back to
 * false restores the original page exactly as it was.
 */

export function generateMetadata(): Metadata {
  if (!DECKBLATT_COMING_SOON) return {};
  // `absolute` so the title is exactly the Coming Soon one; the root layout's
  // global metadata (and its template for every other page) is untouched.
  return { title: { absolute: "Deckblatt AI — Coming Soon" } };
}

export default function DeckblattPage() {
  if (DECKBLATT_COMING_SOON) return <DeckblattComingSoon />;
  return <DeckblattGenerator />;
}
