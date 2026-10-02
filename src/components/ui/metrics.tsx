import type { ReactNode } from "react";

/**
 * Metric + section primitives. Pure (no hooks) — pass translated strings.
 * MetricCard shows REAL values only: the optional `sub` line is rendered
 * only when the caller has actual data for it (no invented trends).
 */

export function MetricCard({
  label,
  value,
  icon,
  sub,
  tone = "default",
  className = "",
}: {
  label: string;
  value: string | number;
  icon?: ReactNode;
  /** Optional second line — only pass real data (never a fake trend). */
  sub?: string;
  tone?: "default" | "accent" | "success" | "warning" | "danger";
  className?: string;
}) {
  const toneIcon = {
    default: "bg-surface-2 text-muted",
    accent: "bg-accent-soft text-accent",
    success: "bg-success-soft text-success",
    warning: "bg-warning-soft text-warning",
    danger: "bg-danger-soft text-danger",
  }[tone];
  return (
    <div
      className={`surface-elevated group relative overflow-hidden rounded-3xl p-5 transition-shadow duration-300 hover:shadow-[var(--shadow-float)] ${className}`}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">
          {label}
        </p>
        {icon && (
          <span
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${toneIcon}`}
          >
            {icon}
          </span>
        )}
      </div>
      <p className="num mt-2 text-3xl font-extrabold text-ink sm:text-[34px] sm:leading-10">
        {value}
      </p>
      {sub && <p className="mt-1.5 truncate text-xs font-medium text-faint">{sub}</p>}
    </div>
  );
}

export function SectionHeader({
  title,
  subtitle,
  action,
  className = "",
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`mb-4 flex items-end justify-between gap-4 ${className}`}>
      <div className="min-w-0">
        <h2 className="text-lg font-bold tracking-tight text-ink sm:text-xl">
          {title}
        </h2>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
