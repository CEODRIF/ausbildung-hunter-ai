import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * /admin — legacy landing for the billing admin area. The former platform
 * overview (community stats, moderation audit, admin identity) was removed
 * with the Community feature; the only remaining admin surface is the
 * user/billing management under /admin/users. The layout's gate
 * (diagnoseAdminAccess) runs first, so anyone reaching this stub already
 * has admin membership.
 */
export default function AdminPage() {
  redirect("/admin/users");
}
