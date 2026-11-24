"use client";

import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  Ref,
  TextareaHTMLAttributes,
} from "react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
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

// ---------------------------------------------------------------------------
// Modal open-state registry
// ---------------------------------------------------------------------------
// Root cause of the "bottom nav paints over the modal" bug: the shell's
// content wrapper (`relative z-10`, app-shell.tsx) is a STACKING CONTEXT.
// Any overlay rendered inside it (even `z-50`) is trapped in that context,
// while the fixed glass bottom nav (`z-30`, a SIBLING of the wrapper at the
// shell root) therefore always painted above every modal — no in-context
// z-index bump can ever fix that. The structural fix has two halves:
//   1. every <Modal> portals to `document.body` (root-level stacking — its
//      z-50 now competes at the same level the nav's z-30 lives in), and
//   2. this registry reports "at least one modal open" so the shell HIDES
//      the bottom nav (display:none) while any modal is open and restores
//      it when the last one closes. Overlap becomes impossible, not just
//      unlikely.
let modalOpenCount = 0;
const modalOpenListeners = new Set<(open: boolean) => void>();

function emitModalOpen() {
  const open = modalOpenCount > 0;
  for (const listener of [...modalOpenListeners]) listener(open);
}

/** True while at least one <Modal> is open. */
export function isAnyModalOpen(): boolean {
  return modalOpenCount > 0;
}

/** Subscribe to "at least one <Modal> is open". The listener fires once
 *  immediately with the current state; returns the unsubscribe function. */
export function subscribeModalOpen(listener: (open: boolean) => void): () => void {
  modalOpenListeners.add(listener);
  listener(isAnyModalOpen());
  return () => {
    modalOpenListeners.delete(listener);
  };
}

type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** All sizes portal to `document.body` (escapes parent stacking
   *  contexts — see the registry note above).
   *  "md" (default) = compact centered popup (unchanged legacy behavior).
   *  "form" = centered scrollable dialog: 94vw on mobile / 90vw (max
   *  768px) on desktop, capped at 90dvh (90vh fallback) — it NEVER
   *  extends beyond the viewport. The header row is stable; children
   *  must build their own `flex-1 min-h-0` chain with an
   *  `overflow-y-auto` body so the content scrolls INSIDE the dialog.
   *  "wide" = document-preview workspace: ~80vw (max 1200px) × up to
   *  90vh, flex column so a viewer can fill the remaining height.
   *  "sheet" = confirmation dialog with tall variable content (e.g. a
   *  per-recipient review list): below `lg` the card is a BOTTOM-PINNED
   *  sheet — `bottom: calc(1rem + env(safe-area-inset-bottom))` with
   *  `max-height: calc(100dvh − 2rem − env(top) − env(bottom))` (vh
   *  fallback) — so it is ALWAYS inside the currently visible viewport
   *  (dynamic-viewport based, immune to Android Chrome's collapsible
   *  omnibox and iOS Safari's bottom toolbar; the derivation is pinned
   *  in tests). The body scrolls INSIDE the card, and the `footer`
   *  action row is a pinned `shrink-0` sibling — the primary action can
   *  never scroll away or hide behind the bottom nav, which the registry
   *  hides (display:none) while the modal is open. At `lg+` the sheet
   *  renders EXACTLY like "md" (desktop design unchanged; the bottom nav
   *  does not exist there). */
  size?: "md" | "form" | "wide" | "sheet";
  /** Pinned action row for `size="sheet"` (rendered OUTSIDE the
   *  scrollable body). Ignored by the other sizes. */
  footer?: ReactNode;
};

export function Modal({ open, onClose, title, children, size = "md", footer }: ModalProps) {
  const { t } = useI18n();
  // Portal host — set AFTER mount (client only): this file is SSR'd, where
  // `document` does not exist. Until the host is set, an open modal renders
  // nothing extra (server + first client render agree), then portals to
  // document.body so the overlay escapes parent stacking contexts.
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    // Intentional: document.body only exists post-mount (this file is SSR'd);
    // the portal host is a one-time, constant post-hydration value.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPortalHost(document.body);
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) =>
      event.key === "Escape" && onClose();
    document.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = "hidden";
    // Register with the modal-open registry (the shell hides the bottom nav
    // for the duration — see the note above the registry).
    modalOpenCount += 1;
    emitModalOpen();
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
      modalOpenCount -= 1;
      emitModalOpen();
    };
  }, [open, onClose]);

  if (!open || !portalHost) return null;
  const wide = size === "wide";
  const form = size === "form";
  const sheet = size === "sheet";
  const overlay = (
    <div
      className={
        wide
          ? "fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-5"
          : form
            ? "fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5"
            : sheet
              ? /* Backdrop only (the card positions itself, see below).
                 Portaled to document.body (root-level stacking) AND the shell
                 hides the bottom nav while this modal is open (registry), so
                 nothing can overlap the card. At `lg` this is exactly the
                 centered "md" overlay (no nav on desktop). */
                "fixed inset-0 z-50 lg:flex lg:items-center lg:justify-center lg:p-4"
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
                ? /* BOTTOM-PINNED sheet. The v1 design ("centered card,
                   overlay pb = 96px + envB, cap min(100%, 100dvh−2.5rem)")
                   shipped with fully valid CSS (verified in the #154 build)
                   yet still covered the send button on every phone, for two
                   independent, verified reasons:
                     (a) STACKING TRAP: the shell content wrapper
                         (`relative z-10`) is a stacking context, so this
                         overlay's z-50 is trapped in it — the bottom nav
                         (`z-30`, a SIBLING of the wrapper at the shell root)
                         therefore ALWAYS painted above the entire modal
                         subtree and intercepted taps in its zone. No
                         in-context z-index can escape. → fixed by the
                         document.body portal (root-level z-50) + the nav
                         hide (registry).
                     (b) WRONG-EDGE RESERVATION: the 96px reservation only
                         cleared the CARD BOTTOM (y = 96+envB) above the nav
                         top (y = 70+max(8,envB)) by ~17–26px — but the send
                         BUTTON sits 52px above the card bottom (12+envB
                         footer padding + ~40px button), i.e. at a CONSTANT
                         y ∈ [44, 84] from the viewport bottom (envB
                         cancels out in both terms) — below the nav top on
                         EVERY phone (3-button: 85% of the button under the
                         glass; gesture-nav: 100%). The v1 regression test
                         compared the card edge, not the button edge, so CI
                         was green while the button stayed covered.
                   v2: the card is PINNED to the viewport bottom
                   (`bottom: 1rem + envB`, button bottom at a constant
                   4+envB px above it — deterministic, no centering/cap
                   interplay) and capped by the DYNAMIC viewport
                   (`100dvh − 2rem − envT − envB`, vh fallback) so the top
                   never hides under browser UI (Android omnibox / iOS
                   status bar); the nav is hidden while open, so nothing can
                   cover or intercept the button. The derivation is pinned in
                   tests/auto-bewerb-step7-confirm-modal-mobile.test.tsx.
                   At `lg` it becomes exactly the "md" card. */
                  "absolute inset-x-4 bottom-[calc(1rem_+_env(safe-area-inset-bottom))] z-10 flex flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl max-h-[calc(100vh_-_2rem_-_env(safe-area-inset-top)_-_env(safe-area-inset-bottom))] supports-[height:100dvh]:max-h-[calc(100dvh_-_2rem_-_env(safe-area-inset-top)_-_env(safe-area-inset-bottom))] lg:static lg:inset-x-auto lg:bottom-auto lg:w-full lg:max-w-md lg:max-h-none lg:p-5"
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
              <div className="shrink-0 border-t border-line/70 bg-surface/95 px-4 pb-3 pt-3 backdrop-blur-sm lg:border-0 lg:bg-transparent lg:px-0 lg:pb-0 lg:pt-5 lg:backdrop-blur-none">
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
  return createPortal(overlay, portalHost);
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
