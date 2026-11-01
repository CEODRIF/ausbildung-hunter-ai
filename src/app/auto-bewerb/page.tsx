import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AutoBewerbClient } from "@/components/auto-bewerb/auto-bewerb-client";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { getAutoBewerbWorkspace } from "@/lib/auto-bewerb/engine";
import type { AutoBewerbWorkspace } from "@/lib/auto-bewerb/schema";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Bewerbungszentrale",
  description:
    "A professional system for managing, personalizing, scheduling, and automating job applications.",
};

/**
 * AUTO BEWERB — the guided, multi-company application workflow.
 *
 * Server responsibilities (all ownership-scoped, service role after checks):
 *  - probe the auto_bewerb_* schema (graceful "setup pending" state before
 *    the manual migration is applied — no crash, no fake data);
 *  - assemble the whole workspace in a bounded number of queries
 *    (profile + companies + documents + selections + attempts + library +
 *    shared email template + connected mailboxes).
 *
 * Everything else (editing, AI generation via /api/auto-bewerb/*, sending)
 * happens client-side through the API routes and server actions — never
 * through client-supplied user ids.
 */
export default async function AutoBewerbPage() {
  const { user } = await getCurrentUserAndProfile();
  if (!user) redirect("/login");

  const initial: AutoBewerbWorkspace = await getAutoBewerbWorkspace(user.id);
  return <AutoBewerbClient initial={initial} />;
}
