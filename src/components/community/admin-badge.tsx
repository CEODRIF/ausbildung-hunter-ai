/**
 * The platform-admin verification badge — an ORIGINAL compact mark (red
 * circle, white check) placed next to the admin's Community display name,
 * conceptually where a verified badge sits. It is NOT a copy of any
 * trademarked verified icon.
 *
 * RENDER CONTRACT: this component never decides who is an admin. It renders
 * only when the CALLER (server-enriched data) says so — the flag travels
 * from the database author id through server-only enrichment
 * (isPlatformAdminId), so a client can never self-award it.
 */
export function AdminBadge({
  label,
  size = 14,
  className,
}: {
  label: string;
  size?: number;
  /** Optional placement hook (margin etc.) — the badge mark itself never
   *  changes; callers may only shift where it sits next to the name. */
  className?: string;
}) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`inline-flex shrink-0 translate-y-[1px] items-center justify-center rounded-full bg-danger align-middle${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size }}
    >
      <svg
        width={size * 0.62}
        height={size * 0.62}
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        <path
          d="M3.5 8.5l3 3 6-6.5"
          stroke="white"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
