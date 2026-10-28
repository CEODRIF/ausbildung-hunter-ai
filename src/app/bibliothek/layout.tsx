import { AppShell } from "@/components/app-shell";
import { getCurrentUserAndProfile } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Deutsch Bibliothek layout — the shared platform shell (sidebar, top bar,
 * mobile drawer, footer) around the public library section.
 *
 * ACCESS MODEL — deliberately PUBLIC, unlike the other shell sections
 * (dashboard/wohnen/… all redirect unauthenticated visitors to /login):
 * the book library is browsable content for guests, so this layout applies
 * NO auth redirect. AppShell is built to render with a null profile (the
 * top bar shows the neutral "Konto" fallback, the admin section stays
 * hidden) — the same NAV_SECTIONS every member sees, with the existing
 * permission rules (admin section is a server-computed profile flag).
 *
 * Content authorization stays in the DATA layer, not the layout: RLS + the
 * explicit `published = true` filter expose only published books, to guests
 * and members alike. No entitlement/plan gate (books are free content; no
 * quota exists for them — inventing one would change billing behavior).
 */
export default async function BibliothekLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const { profile } = await getCurrentUserAndProfile();
  return <AppShell profile={profile ?? null}>{children}</AppShell>;
}
