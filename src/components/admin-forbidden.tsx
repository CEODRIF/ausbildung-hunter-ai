/**
 * Server-rendered 403 for authenticated users WITHOUT admin membership.
 *
 * The /admin layout previously `redirect("/dashboard")` for every gate
 * failure — an admin account whose database membership was missing was
 * silently bounced to the normal dashboard, which is exactly how the
 * production incident looked. This page makes the denial explicit and
 * diagnosable:
 *
 *   - it is a DEAD END: it renders no admin content and no admin nav;
 *   - the user-initiated link back to /dashboard is navigation, not a
 *     redirect — the authorization decision itself stays server-side;
 *   - the reason is logged server-side by the layout (user id + which
 *     check failed), never rendered into the page.
 */
export function AdminForbidden() {
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 bg-muted/30 p-8 text-center">
      <p className="text-sm font-semibold tracking-wide text-muted">403</p>
      <h1 className="text-2xl font-bold text-ink">No admin access</h1>
      <p className="text-sm text-muted">
        You are signed in, but this account does not have platform admin
        membership. Admin access is granted through the admin membership
        table on the server — it is not based on your email address. If
        you believe this is a mistake, contact the platform owner.
      </p>
      <a
        href="/dashboard"
        className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-ink"
      >
        Back to your dashboard
      </a>
    </div>
  );
}
