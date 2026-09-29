import Link from "next/link";
import { Button } from "@/components/ui";
import { Icon, type IconName } from "@/components/icon";

/**
 * Professional empty state: explains what is missing, why it matters, and
 * offers the next action. Never decorative — always actionable.
 */
export interface EmptyStateProps {
  icon: IconName;
  title: string;
  body?: string;
  /** CTA label + internal route (preferred over `action`). */
  cta?: { label: string; href: string };
  /** CTA as a bare action (client callback). */
  action?: { label: string; onClick: () => void };
  /** Extra content below the primary CTA (e.g. a secondary link). */
  footer?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  body,
  cta,
  action,
  footer,
  className = "",
}: EmptyStateProps) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 px-6 py-10 text-center ${className}`}
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
        <Icon name={icon} size={22} />
      </span>
      <h3 className="text-sm font-bold text-ink">{title}</h3>
      {body && (
        <p className="max-w-sm text-xs leading-5 text-muted">{body}</p>
      )}
      {cta && (
        <Link href={cta.href} className="mt-1">
          <Button size="sm">{cta.label}</Button>
        </Link>
      )}
      {action && (
        <Button size="sm" className="mt-1" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
      {footer}
    </div>
  );
}
