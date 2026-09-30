/** Client-safe relative time formatting (notifications, admin history).
 *  Falls back to a plain date for older items. */
export function relativeTime(
  iso: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
  locale: string,
): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso.slice(0, 10);
  const diffMs = Date.now() - then;
  if (diffMs < 60_000) return t("header.justNow");
  if (diffMs < 3_600_000)
    return t("header.minutesAgo", { n: Math.max(1, Math.round(diffMs / 60_000)) });
  if (diffMs < 86_400_000)
    return t("header.hoursAgo", { n: Math.round(diffMs / 3_600_000) });
  return new Date(iso).toLocaleDateString(locale);
}
