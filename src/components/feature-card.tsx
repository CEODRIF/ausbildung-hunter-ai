import Link from "next/link";
import { Icon, type IconName } from "@/components/icon";

/**
 * Dashboard feature card: icon, title, one-line explanation, action link.
 * Premium floating surface with a soft hover lift (150–300 ms,
 * reduced-motion aware via the global prefers-reduced-motion guard).
 */
export interface FeatureCardProps {
  icon: IconName;
  title: string;
  text: string;
  /** Action label + internal route. */
  action: { label: string; href: string };
  className?: string;
}

export function FeatureCard({ icon, title, text, action, className = "" }: FeatureCardProps) {
  return (
    <Link
      href={action.href}
      className={`group surface-elevated relative flex flex-col gap-3 overflow-hidden rounded-3xl p-5 transition-[transform,box-shadow] duration-300 hover:-translate-y-1 hover:shadow-[var(--shadow-float)] ${className}`}
    >
      <span className="pointer-events-none absolute -top-10 -end-10 h-28 w-28 rounded-full bg-accent/10 blur-2xl transition-opacity duration-300 group-hover:opacity-100 sm:opacity-60" />
      <span className="relative flex h-11 w-11 items-center justify-center rounded-2xl bg-accent-soft text-accent transition-colors duration-300 group-hover:bg-accent group-hover:text-white">
        <Icon name={icon} size={20} />
      </span>
      <span className="relative font-bold tracking-tight text-ink">{title}</span>
      <span className="relative text-xs leading-5 text-muted">{text}</span>
      <span className="relative mt-auto inline-flex items-center gap-1.5 pt-1 text-xs font-bold text-accent">
        {action.label}
        <Icon
          name="arrowRight"
          size={14}
          className="transition-transform duration-200 group-hover:translate-x-0.5 rtl:rotate-180 rtl:group-hover:-translate-x-0.5"
        />
      </span>
    </Link>
  );
}
