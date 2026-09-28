import Link from "next/link";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { requireAdmin } from "@/lib/billing/admin";
import { listAdminUsers } from "@/lib/billing/admin-users";
import {
  AdminUserActions,
  type AdminUserRow,
} from "@/components/admin-user-actions";

export const dynamic = "force-dynamic";

/** Phase 10 — admin foundation. Gated twice: the page requires an active
 *  session AND a verified admin membership (server-side). */
export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string; feedback?: string }>;
}) {
  const { user } = await getCurrentUserAndProfile();
  if (!user) redirect("/login");
  const admin = await requireAdmin();
  if (!admin) redirect("/dashboard");

  const params = await searchParams;
  const users = await listAdminUsers(params.email ?? undefined);

  return (
    <main className="min-h-screen bg-[#f6f8fb] px-5 py-8 sm:px-8 lg:px-10">
      <div className="mx-auto max-w-5xl">
        <Link
          href="/dashboard"
          className="text-sm font-semibold text-[#2f6fed]"
        >
          ← Back to dashboard
        </Link>
        <div className="mt-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-[#2f6fed]">Admin</p>
            <h1 className="mt-2 text-3xl font-bold tracking-[-0.04em] text-[#10203b]">
              User administration
            </h1>
            <p className="mt-2 text-sm text-[#71819a]">
              Every action is authorized server-side and written to the admin
              audit log.
            </p>
          </div>
          <AdminFilterForm initial={params.email ?? ""} />
        </div>
        {params.feedback && (
          <p className="mt-4 rounded-xl bg-[#eaf8f3] px-4 py-3 text-sm font-semibold text-[#1b9b70]">
            {params.feedback}
          </p>
        )}

        <Card className="mt-6 overflow-hidden">
          {users.length === 0 ? (
            <p className="px-6 py-10 text-center text-sm text-[#8290a4]">
              No users match this filter.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead>
                  <tr className="border-b border-[#edf0f4] text-[11px] uppercase tracking-[0.08em] text-[#8b9ab0]">
                    <th className="px-5 py-3">User</th>
                    <th className="px-5 py-3">Goal</th>
                    <th className="px-5 py-3">Plan</th>
                    <th className="px-5 py-3">Today (email / AI)</th>
                    <th className="px-5 py-3">Role</th>
                    <th className="px-5 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#edf0f4]">
                  {users.map((row) => (
                    <tr key={row.id}>
                      <td className="px-5 py-3">
                        <p className="font-semibold text-[#1d3458]">
                          {row.full_name}
                        </p>
                        <p className="text-xs text-[#8290a4]">{row.email}</p>
                      </td>
                      <td className="px-5 py-3 text-xs text-[#546783]">
                        {row.selected_goal ?? "—"}
                      </td>
                      <td className="px-5 py-3">
                        {row.subscription ? (
                          <span className="text-xs font-semibold text-[#1d3458]">
                            {row.subscription.plan}{" "}
                            <span className="text-[#8290a4]">
                              ({row.subscription.status}
                              {row.subscription.current_period_end
                                ? ` until ${new Date(row.subscription.current_period_end).toLocaleDateString("de-DE")}`
                                : ""}
                              )
                            </span>
                          </span>
                        ) : (
                          <span className="text-xs text-[#8290a4]">Free</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-xs text-[#546783]">
                        {row.usage_today.emails_sent} /{" "}
                        {row.usage_today.ai_requests}
                      </td>
                      <td className="px-5 py-3">
                        {row.is_admin ? (
                          <span className="rounded-md bg-[#f2edff] px-1.5 py-0.5 text-[10px] font-bold text-[#805ad5]">
                            ADMIN
                          </span>
                        ) : (
                          <span className="text-xs text-[#8290a4]">user</span>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        <AdminUserActions
                          actorId={admin.id}
                          row={row as AdminUserRow}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </main>
  );
}

function AdminFilterForm({ initial }: { initial: string }) {
  return (
    <form action="/admin" method="GET" className="flex items-center gap-2">
      <input
        type="search"
        name="email"
        defaultValue={initial}
        placeholder="Filter by email…"
        className="w-56 rounded-xl border border-[#dbe3ef] bg-white px-3 py-2 text-sm"
      />
      <button
        type="submit"
        className="rounded-xl bg-[#2f6fed] px-4 py-2 text-sm font-bold text-white"
      >
        Filter
      </button>
    </form>
  );
}
