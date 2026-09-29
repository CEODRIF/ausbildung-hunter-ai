import Link from "next/link";
import { Icon, type IconName } from "@/components/icon";

/**
 * Dashboard feature card: icon, title, one-line explanation, action link.
 * Subtle hover lift + border highlight (150 ms, reduced-motion aware via
 * the global prefers-reduced-motion guard in globals.css).
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
      className={`group flex flex-col gap-3 rounded-2xl border border-line bg-surface p-5 transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-0.5 hover:border-line-strong hover:card-shadow ${className}`}
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent transition-colors group-hover:bg-accent group-hover:text-white">
        <Icon name={icon} size={20} />
      </span>
      <span className="font-bold text-ink">{title}</span>
      <span className="text-xs leading-5 text-muted">{text}</span>
      <span className="mt-auto inline-flex items-center gap-1.5 pt-1 text-xs font-bold text-accent">
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
