import { Globe } from "lucide-react";

/**
 * The animated Internet Discovery orb — a soft 3D search sphere with
 * orbiting source nodes and pulse rings.
 *
 * Pure CSS/SVG (no JS timers, no WebGL): the animation only runs while
 * `active` is true (a REAL running run), and the global
 * prefers-reduced-motion rule freezes everything for users who opt out.
 * The orb is decorative — the status lines below it are the source of
 * truth (they render only what the backend actually reported).
 */

const NODES = [
  { top: "-6%", left: "38%", size: 12, delay: "0s" },
  { top: "18%", left: "94%", size: 9, delay: "-1.8s" },
  { top: "82%", left: "78%", size: 11, delay: "-3.2s" },
  { top: "92%", left: "24%", size: 8, delay: "-4.6s" },
  { top: "30%", left: "-4%", size: 10, delay: "-6s" },
];

export function SearchOrb({
  active = false,
  size = 190,
}: {
  /** True only while the run status is genuinely "running". */
  active?: boolean;
  size?: number;
}) {
  const orb = (
    <div
      aria-hidden="true"
      className="relative"
      style={{ width: size, height: size }}
    >
      {/* pulse rings */}
      {active && (
        <>
          <span className="orb-ring absolute inset-0 rounded-full border border-accent/30" />
          <span
            className="orb-ring absolute inset-0 rounded-full border border-cyan/25"
            style={{ animationDelay: "-1.3s" }}
          />
        </>
      )}

      {/* orbiting nodes (two counter-rotating rings) */}
      <div className={`absolute inset-0 ${active ? "anim-orbit" : ""}`}>
        <span
          className="absolute rounded-full bg-accent shadow-[0_0_14px_rgba(var(--glow-accent-rgb),0.65)]"
          style={{
            width: NODES[0].size,
            height: NODES[0].size,
            top: NODES[0].top,
            left: NODES[0].left,
          }}
        />
        <span
          className="absolute rounded-full bg-cyan shadow-[0_0_12px_rgba(90,141,248,0.6)]"
          style={{
            width: NODES[1].size,
            height: NODES[1].size,
            top: NODES[1].top,
            left: NODES[1].left,
          }}
        />
      </div>
      <div className={`absolute inset-0 ${active ? "anim-orbit-reverse" : ""}`}>
        <span
          className="absolute rounded-full bg-ai shadow-[0_0_12px_rgba(155,123,247,0.6)]"
          style={{
            width: NODES[2].size,
            height: NODES[2].size,
            top: NODES[2].top,
            left: NODES[2].left,
          }}
        />
        <span
          className="absolute rounded-full bg-accent/70"
          style={{
            width: NODES[3].size,
            height: NODES[3].size,
            top: NODES[3].top,
            left: NODES[3].left,
          }}
        />
        <span
          className="absolute rounded-full bg-cyan/70"
          style={{
            width: NODES[4].size,
            height: NODES[4].size,
            top: NODES[4].top,
            left: NODES[4].left,
          }}
        />
      </div>

      {/* the sphere: layered radial gradients = soft 3D */}
      <div
        className={`absolute inset-[12%] rounded-full ${active ? "anim-orb-breathe" : ""}`}
        style={{
          background:
            "radial-gradient(circle at 32% 28%, rgba(255,255,255,0.95) 0%, rgba(199,190,254,0.9) 26%, rgba(123,108,246,0.85) 52%, rgba(88,71,232,0.9) 78%, rgba(76,56,196,0.95) 100%)",
          boxShadow: active
            ? "0 30px 60px -18px rgba(var(--glow-accent-rgb),0.55), inset 0 -14px 30px rgba(64,48,160,0.35), inset 0 10px 24px rgba(255,255,255,0.75)"
            : "0 22px 44px -18px rgba(var(--glow-accent-rgb),0.35), inset 0 -12px 26px rgba(64,48,160,0.25), inset 0 8px 20px rgba(255,255,255,0.6)",
        }}
      >
        {/* glass highlight */}
        <span
          className="absolute inset-x-[18%] top-[8%] h-[26%] rounded-full bg-white/55 blur-md"
          aria-hidden="true"
        />
        <span className="absolute inset-0 flex items-center justify-center text-white/95">
          <Globe size={Math.round(size * 0.19)} strokeWidth={1.4} />
        </span>
      </div>
    </div>
  );

  return active ? <div className="anim-float">{orb}</div> : orb;
}
