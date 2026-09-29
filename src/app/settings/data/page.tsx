import { redirect } from "next/navigation";
import { Card } from "@/components/ui";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { getServerT } from "@/lib/i18n/server";
import { DeleteAccountForm } from "@/app/settings/data/delete-account-form";

export const dynamic = "force-dynamic";

/** Phase 11 — GDPR data controls: export (portability) + deletion
 *  (erasure). Both actions run server-side against the session user only. */
export default async function DataSettingsPage() {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    redirect("/login");
  const t = await getServerT();

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-3xl">
        <Card className="p-6">
          <h2 className="font-bold text-ink-soft">{t("account.exportTitle")}</h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            {t("account.exportBody")}
          </p>
          <a
            href="/api/account/export"
            className="mt-5 inline-flex h-11 items-center rounded-xl bg-accent px-5 text-sm font-semibold text-white hover:bg-accent-deep"
          >
            {t("account.exportCta")}
          </a>
        </Card>

        <Card className="mt-5 border-danger/25 p-6">
          <h2 className="font-bold text-danger">{t("account.deleteTitle")}</h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            {t("account.deleteBody")}
          </p>
          <DeleteAccountForm email={String(profile.email ?? "")} />
        </Card>
      </div>
    </div>
  );
}
