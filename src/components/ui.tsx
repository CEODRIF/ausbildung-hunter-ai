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
  primary: "btn-neon text-white",
  secondary:
    "border border-line-strong bg-surface text-ink hover:border-accent/40 hover:bg-surface-2",
  /** Green outline — the "Details" affordance on opportunity cards. */
  outline:
    "border border-accent/45 bg-surface text-accent hover:border-accent hover:bg-accent-soft",
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
    lg: "h-12 px-6 text-[15px]",
  };
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-2xl font-semibold transition-[background-color,border-color,color,box-shadow,transform] disabled:cursor-not-allowed disabled:opacity-50 ${sizes[size]} ${buttonStyles[variant]} ${className}`}
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
        <span className="mb-1.5 block text-sm font-semibold text-ink-soft">
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
          <span className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-faint">
            {leading}
          </span>
        )}
        <input
          id={id}
          className={`h-10 w-full rounded-2xl border bg-surface px-3 text-sm text-ink shadow-[var(--shadow-card)] outline-none transition placeholder:text-faint focus:border-accent focus:ring-4 focus:ring-accent/10 ${leading ? "ps-9" : ""} ${error ? "border-danger" : "border-line-strong"} ${className}`}
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
        <span className="mb-1.5 block text-sm font-semibold text-ink-soft">
          {label}
        </span>
      )}
      <textarea
        id={id}
          className={`min-h-24 w-full resize-y rounded-2xl border bg-surface px-3 py-2.5 text-sm leading-5 text-ink outline-none transition placeholder:text-faint focus:border-accent focus:ring-4 focus:ring-accent/10 ${error ? "border-danger" : "border-line-strong"} ${className}`}
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
  /** "md" (default) = compact popup (unchanged legacy behavior).
   *  "form" = centered scrollable dialog: 94vw on mobile / 90vw (max
   *  768px) on desktop, capped at 90dvh (90vh fallback) — it NEVER
   *  extends beyond the viewport. The header row is stable; children
   *  must build their own `flex-1 min-h-0` chain with an
   *  `overflow-y-auto` body so the content scrolls INSIDE the dialog.
   *  "wide" = document-preview workspace: ~80vw (max 1200px) × up to
   *  90vh, flex column so a viewer can fill the remaining height.
   *  "sheet" = confirmation dialog with tall variable content (e.g. a
   *  per-recipient review list): on mobile/tablet (<lg) the card is a
   *  flex column capped at the overlay's free area (100dvh minus the
   *  top/bottom safe areas and the fixed bottom nav's reserved
   *  footprint), the body scrolls INSIDE the card, and the `footer`
   *  action row stays pinned at the card bottom (opaque bg + safe-area
   *  padding) — the primary action can never scroll away or hide
   *  behind the bottom nav. At lg+ it renders EXACTLY like "md"
   *  (desktop design unchanged; the bottom nav does not exist there).
   *  Same geometric contract as the cover-letter AI modal and the
   *  applications confirm dialog (see tests/cover-letter-ai-modal-mobile.test.tsx). */
  size?: "md" | "form" | "wide" | "sheet";
  /** Pinned action row for `size="sheet"` (rendered OUTSIDE the
   *  scrollable body). Ignored by the other sizes. */
  footer?: ReactNode;
};

export function Modal({ open, onClose, title, children, size = "md", footer }: ModalProps) {
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
  const wide = size === "wide";
  const form = size === "form";
  const sheet = size === "sheet";
  return (
    <div
      className={
        wide
          ? "fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-5"
          : form
            ? "fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5"
            : sheet
              ? /* The fixed glass bottom nav (app-shell, z-30 `lg:hidden`) PAINTS
                 above this overlay — the shell content wrapper is a `relative z-10`
                 stacking context that traps the overlay's z-50 — so the contract is
                 GEOMETRIC, not z-index: below `lg` reserve the nav's full footprint
                 (+ margin) via bottom padding, the iOS home-indicator inset via the
                 env() terms, and restore plain `p-4` at `lg` (no nav on desktop →
                 desktop layout unchanged). */
                "fixed inset-0 z-50 flex items-center justify-center p-4 pt-[calc(1rem+env(safe-area-inset-top))] pb-[calc(6rem+env(safe-area-inset-bottom))] lg:p-4"
              : "fixed inset-0 z-50 flex items-center justify-center p-4"
      }
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <button
        className="absolute inset-0 bg-navy/45 backdrop-blur-[2px] dark:bg-black/60"
        aria-label={t("common.close")}
        onClick={onClose}
      />
      <div
        className={
          wide
            ? "relative z-10 flex max-h-[94vh] w-[96vw] max-w-[1200px] flex-col overflow-hidden rounded-2xl border border-line bg-surface p-3 shadow-2xl sm:max-h-[90vh] sm:w-[82vw] sm:p-4"
            : form
              ? "relative z-10 flex max-h-[90vh] supports-[height:100dvh]:max-h-[90dvh] w-[94vw] flex-col overflow-hidden rounded-2xl border border-line bg-surface p-4 shadow-2xl sm:w-[90vw] sm:max-w-3xl sm:p-5"
              : sheet
                ? /* Flex column capped at the overlay's free area (`min(100%, …)`
                   re-bounds when iOS Safari shrinks the layout viewport under the
                   keyboard; dvh cap where supported, vh fallback). Below `lg` the
                   card can never extend past the safe area or into the bottom nav.
                   At `lg` it becomes exactly the "md" card. */
                  "relative z-10 flex w-full max-w-md flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl max-h-[min(100%,calc(100vh_-_2.5rem))] supports-[height:100dvh]:max-h-[min(100%,calc(100dvh_-_2.5rem))] lg:max-h-none lg:p-5"
                : "relative z-10 w-full max-w-md rounded-2xl border border-line bg-surface p-5 shadow-2xl"
        }
      >
        <div
          className={
            wide || form
              ? "mb-3 flex shrink-0 items-center justify-between gap-4"
              : sheet
                ? "mb-0 flex shrink-0 items-start justify-between gap-4 p-4 pb-3 lg:mb-4 lg:p-0"
                : "mb-4 flex items-start justify-between gap-4"
          }
        >
          <h2 className={wide || form ? "min-w-0 truncate text-base font-bold text-ink sm:text-lg" : "text-lg font-bold text-ink"}>{title}</h2>
          <button
            className="shrink-0 rounded-lg p-1.5 text-faint hover:bg-surface-2 hover:text-ink"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <CloseIcon />
          </button>
        </div>
        {sheet ? (
          <>
            {/* Body scrolls INSIDE the card (single scroll region); the footer
                below is a stable sibling, never part of the scroll. */}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 lg:overflow-visible lg:p-0">{children}</div>
            {footer && (
              <div className="shrink-0 border-t border-line/70 bg-surface/95 px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 backdrop-blur-sm lg:border-0 lg:bg-transparent lg:px-0 lg:pb-0 lg:pt-5 lg:backdrop-blur-none">
                {footer}
              </div>
            )}
          </>
        ) : (
          children
        )}
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
