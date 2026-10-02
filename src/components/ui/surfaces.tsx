import type { ReactNode } from "react";

/**
 * Premium surface primitives — the layered card language of the app.
 *
 *   surface            → .surface-elevated (crisp, data-dense)
 *   surface-elevated   → .glass (translucent, the key floating elements)
 *   surface-floating   → .glass + hover elevation
 *
 * Pure components (no hooks): usable from server and client components.
 * All colors/depth come from the design tokens in globals.css.
 */

export type SurfaceVariant = "surface" | "surface-elevated" | "surface-floating";

const SURFACE_CLASSES: Record<SurfaceVariant, string> = {
  surface: "surface-elevated rounded-3xl",
  "surface-elevated": "glass rounded-3xl",
  "surface-floating":
    "glass rounded-3xl transition-transform duration-300 hover:-translate-y-1",
};

export function GlassCard({
  children,
  className = "",
  variant = "surface",
  as: Component = "div",
  "aria-label": ariaLabel,
}: {
  children: ReactNode;
  className?: string;
  variant?: SurfaceVariant;
  as?: "div" | "section" | "article" | "aside";
  "aria-label"?: string;
}) {
  return (
    <Component aria-label={ariaLabel} className={`${SURFACE_CLASSES[variant]} ${className}`}>
      {children}
    </Component>
  );
}

/** A card that visibly floats above the page (stronger elevation). */
export function FloatingCard({
  children,
  className = "",
  as: Component = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article";
}) {
  return (
    <Component
      className={`glass rounded-3xl shadow-[var(--shadow-float)] ${className}`}
    >
      {children}
    </Component>
  );
}

/**
 * The soft background glow field — render exactly once per screen, as the
 * first child of the page root. Fixed, non-interactive, gradient-only
 * (no blur filters) so it costs nothing on phones.
 */
export function GradientMesh({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`app-mesh ${className}`} />;
}

/** A soft colored orb used as decorative depth behind hero/orb surfaces. */
export function GlowOrb({
  className = "",
  tone = "accent",
}: {
  className?: string;
  tone?: "accent" | "blue" | "pink";
}) {
  const tones = {
    accent: "bg-accent/20",
    blue: "bg-cyan/20",
    pink: "bg-danger/10",
  };
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute rounded-full blur-3xl ${tones[tone]} ${className}`}
    />
  );
}
