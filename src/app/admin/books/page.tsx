import { redirect } from "next/navigation";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { requireAdmin } from "@/lib/billing/admin";
import { listAdminBooks, bookCoverPublicUrl } from "@/lib/book-library";
import { getServerT, getRequestLang } from "@/lib/i18n/server";
import { localeForLang } from "@/lib/i18n/core";
import { AdminBookManager, type AdminBookView } from "@/components/admin-book-manager";

export const dynamic = "force-dynamic";

/**
 * Admin surface for the Deutsch Bibliothek (books).
 *
 * Gated twice — exactly like the other /admin surfaces: the /admin LAYOUT
 * already requires session + public.admins membership (server-side, with an
 * explicit 403 for non-members), and this page re-checks requireAdmin() as
 * backstop. Every mutation additionally re-gates itself in the server
 * actions; the table data here is service-role-read (admin may see drafts,
 * which the RLS boundary hides from everyone else).
 */
export default async function AdminBooksPage() {
  const { user } = await getCurrentUserAndProfile();
  if (!user) redirect("/login");
  const admin = await requireAdmin();
  if (!admin) redirect("/dashboard");

  const [t, lang] = await Promise.all([getServerT(), getRequestLang()]);
  const locale = localeForLang(lang);
  const books = await listAdminBooks();

  const rows: AdminBookView[] = books.map((book) => ({
    id: book.id,
    title: book.title,
    category: book.category,
    description: book.description ?? "",
    coverUrl: book.cover_path ? bookCoverPublicUrl(book.cover_path) : null,
    downloadUrl: book.download_url,
    published: book.published,
    createdAt: new Date(book.created_at).toLocaleDateString(locale, {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }),
  }));

  return (
    <>
      <div className="mt-8">
        <h1 className="mt-2 text-3xl font-bold tracking-[-0.04em] text-ink">
          {t("admin.books.title")}
        </h1>
        <p className="mt-2 text-sm text-muted">{t("admin.books.subtitle")}</p>
      </div>
      <AdminBookManager books={rows} />
    </>
  );
}
