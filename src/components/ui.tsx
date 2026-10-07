"use client";

import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  Ref,
  TextareaHTMLAttributes,
} from "react";
import { useEffect } from "react";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/icon";

/**
 * Shared primitives. All colors come from the design tokens (globals.css) so
 * light and dark themes work from the same component code — no per-theme
 * class branching in components.
 */

export const buttonStyles = {
  primary:
    "btn-neon text-white shadow-[0_8px_22px_rgba(var(--glow-accent-rgb),0.3)] hover:shadow-[0_10px_26px_rgba(var(--glow-accent-rgb),0.38)]",
  secondary:
    "border border-line-strong bg-surface text-ink-soft hover:border-faint hover:bg-surface-2",
  ghost: "text-muted hover:bg-surface-2 hover:text-ink",
  dark:
    "border border-transparent bg-navy text-white shadow-[0_8px_18px_rgba(var(--glow-navy-rgb),0.18)] hover:bg-navy-soft dark:border-line dark:shadow-[0_8px_18px_rgba(0,0,0,0.35)]",
} as const;

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof buttonStyles;
  size?: "sm" | "md" | "lg";
  children: ReactNode;
};

export function Button({
  className = "",
  variant = "primary",
  size = "md",
  children,
  ...props
}: ButtonProps) {
  const sizes = {
    sm: "h-9 px-3.5 text-xs",
    md: "h-11 px-4.5 text-sm",
    lg: "h-12 px-5 text-sm",
  };
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-2xl font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${sizes[size]} ${buttonStyles[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  /**
   * React 19: `ref` is a regular prop on function components. It reaches the
   * DOM input through the `...props` spread below (forwarded, never captured).
   */
  ref?: Ref<HTMLInputElement>;
  label?: string;
  hint?: string;
  error?: string;
  leading?: ReactNode;
  /** Small de-emphasized suffix inside the label (e.g. "optional"). */
  labelSuffix?: string;
};

export function Input({
  label,
  hint,
  error,
  leading,
  labelSuffix,
  id,
  className = "",
  ...props
}: InputProps) {
  return (
    <label className="block" htmlFor={id}>
      {label && (
        <span className="mb-2 block text-sm font-semibold text-ink-soft">
          {label}
          {labelSuffix && (
            <span className="ms-1.5 text-xs font-normal text-faint">
              {labelSuffix}
            </span>
          )}
        </span>
      )}
      <span className="relative block">
        {leading && (
          <span className="pointer-events-none absolute start-3.5 top-1/2 -translate-y-1/2 text-faint">
            {leading}
          </span>
        )}
        <input
          id={id}
          className={`h-12 w-full rounded-2xl border bg-surface px-3.5 text-sm text-ink shadow-[var(--shadow-card)] outline-none transition placeholder:text-faint focus:border-accent focus:ring-4 focus:ring-accent/10 ${leading ? "ps-10" : ""} ${error ? "border-danger" : "border-line-strong"} ${className}`}
          {...props}
        />
      </span>
      {error ? (
        <span className="mt-1.5 block text-xs font-medium text-danger">
          {error}
        </span>
      ) : hint ? (
        <span className="mt-1.5 block text-xs text-muted">{hint}</span>
      ) : null}
    </label>
  );
}

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label?: string;
  hint?: string;
  error?: string;
};

/** Multi-line input with the same visual contract as <Input>. */
export function Textarea({
  label,
  hint,
  error,
  id,
  className = "",
  ...props
}: TextareaProps) {
  return (
    <label className="block" htmlFor={id}>
      {label && (
        <span className="mb-2 block text-sm font-semibold text-ink-soft">
          {label}
        </span>
      )}
      <textarea
        id={id}
          className={`min-h-28 w-full resize-y rounded-2xl border bg-surface px-3.5 py-3 text-sm leading-6 text-ink outline-none transition placeholder:text-faint focus:border-accent focus:ring-4 focus:ring-accent/10 ${error ? "border-danger" : "border-line-strong"} ${className}`}
        {...props}
      />
      {error ? (
        <span className="mt-1.5 block text-xs font-medium text-danger">
          {error}
        </span>
      ) : hint ? (
        <span className="mt-1.5 block text-xs text-muted">{hint}</span>
      ) : null}
    </label>
  );
}

type CardProps = {
  children: ReactNode;
  className?: string;
  as?: "div" | "section";
};

export function Card({ children, className = "", as = "div" }: CardProps) {
  const Component = as;
  return (
    <Component
      className={`rounded-3xl border border-line bg-surface shadow-[var(--shadow-card)] ${className}`}
    >
      {children}
    </Component>
  );
}

type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
};

export function Modal({ open, onClose, title, children }: ModalProps) {
  const { t } = useI18n();
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) =>
      event.key === "Escape" && onClose();
    document.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <button
        className="absolute inset-0 bg-navy/45 backdrop-blur-[2px] dark:bg-black/60"
        aria-label={t("common.close")}
        onClick={onClose}
      />
      <div className="relative z-10 w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-2xl">
        <div className="mb-5 flex items-start justify-between gap-4">
          <h2 className="text-lg font-bold text-ink">{title}</h2>
          <button
            className="rounded-lg p-1.5 text-faint hover:bg-surface-2 hover:text-ink"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <CloseIcon />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function LoadingState({ label }: { label?: string }) {
  const { t } = useI18n();
  const text = label ?? t("common.loading");
  return (
    <div
      className="flex items-center gap-3 text-sm text-muted"
      role="status"
      aria-label={text}
    >
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
      {text}
    </div>
  );
}

export function ErrorState({
  title,
  description,
  onRetry,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
}) {
  const { t } = useI18n();
  const headline = title ?? t("common.error");
  const body = description ?? t("common.errorHint");
  return (
    <div
      className="rounded-2xl border border-danger/30 bg-danger-soft p-5"
      role="alert"
    >
      <div className="flex gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-danger/15 text-danger">
          <Icon name="alert" size={16} strokeWidth={2} />
        </span>
        <div>
          <h2 className="font-semibold text-danger">{headline}</h2>
          <p className="mt-1 text-sm leading-6 text-danger/75">{body}</p>
          {onRetry && (
            <Button
              className="mt-3"
              variant="secondary"
              size="sm"
              onClick={onRetry}
            >
              {t("common.retry")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Compat export — canonical icon now lives in @/components/icon. */
export function CloseIcon() {
  return <Icon name="x" size={17} strokeWidth={2} />;
}

/** Compat export. */
export function AlertIcon() {
  return <Icon name="alert" size={16} strokeWidth={2} />;
}
