/**
 * The hero aircraft — a hand-built inline SVG airliner.
 *
 * Why SVG and not a photo or a video: the hero needs an element that scales
 * from 140 px (320 px phone) to 240 px (desktop) without a raster request,
 * without layout shift and without a decode cost on the main thread. A few
 * dozen vector nodes are a fraction of the smallest useful PNG and stay
 * perfectly crisp on any DPI.
 *
 * Proportions follow a narrow-body jet in side view (~7:1 fuselage), with the
 * wing and engine drawn first so the fuselage overlaps their roots — that
 * overlap is what makes the silhouette read as an aircraft instead of a tube.
 *
 * Everything is drawn from two gradients (body, wing) plus one brand green.
 * `aria-hidden` — it carries no information.
 */
export function Airplane({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 430 195"
      className={className}
      role="presentation"
      aria-hidden="true"
      focusable="false"
      width="430"
      height="195"
    >
      <defs>
        <linearGradient id="plane-body" x1="0" y1="60" x2="0" y2="120" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.45" stopColor="#f7fafb" />
          <stop offset="1" stopColor="#d8e3ea" />
        </linearGradient>
        <linearGradient id="plane-wing" x1="130" y1="115" x2="300" y2="185" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#f4f8fa" />
          <stop offset="1" stopColor="#b6c6d2" />
        </linearGradient>
        <linearGradient id="plane-fin" x1="30" y1="18" x2="126" y2="96" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#1cb268" />
          <stop offset="1" stopColor="#0a6b3a" />
        </linearGradient>
      </defs>

      {/* contact shadow — flat ellipse, no filter */}
      <ellipse cx="216" cy="188" rx="160" ry="6" fill="#0b1f33" opacity="0.08" />

      {/* horizontal stabiliser (rear) */}
      <path d="M56 104 L8 86 C16 100 34 112 58 115 Z" fill="#c2d0da" />

      {/* main wing — large, swept back toward the tail, under the fuselage */}
      <path
        d="M300 115 C262 134 178 166 126 181 C112 185 103 172 118 166 C180 142 250 126 288 117 Z"
        fill="url(#plane-wing)"
      />
      {/* winglet */}
      <path d="M128 180 C123 170 120 162 119 155 L128 156 C131 163 134 171 136 178 Z" fill="#0a6b3a" opacity="0.9" />

      {/* engine nacelle + pylon, hanging under the wing */}
      <path d="M226 122 L244 127 L244 140 L226 134 Z" fill="#c2d0da" />
      <ellipse cx="202" cy="155" rx="38" ry="14.5" fill="#f0f4f7" />
      <ellipse cx="202" cy="155" rx="38" ry="14.5" fill="none" stroke="#adbdc9" strokeWidth="1.6" />
      <ellipse cx="237" cy="155" rx="6" ry="13" fill="#8698a6" />

      {/* fuselage */}
      <path
        d="M410 84 C406 68 390 64 364 63 L150 63 C108 64 72 74 30 94 C72 112 108 118 150 118 L364 114 C390 112 406 100 410 84 Z"
        fill="url(#plane-body)"
      />
      {/* belly shading */}
      <path
        d="M30 94 C72 112 108 118 150 118 L364 114 C390 112 406 100 410 84 L410 88 C406 102 390 116 364 118 L150 122 C108 122 71 116 30 98 Z"
        fill="#bfcdd8"
        opacity="0.45"
      />

      {/* vertical stabiliser (brand green) */}
      <path d="M122 65 C106 48 94 34 84 21 C66 44 45 72 32 94 L122 65 Z" fill="url(#plane-fin)" />
      <path d="M114 61 C100 47 91 37 85 29 C71 47 57 68 48 84 L114 61 Z" fill="#ffffff" opacity="0.12" />

      {/* cockpit glazing */}
      <path d="M382 70 C394 72 402 78 406 84 L390 86 Z" fill="#2b4a63" opacity="0.85" />
      <path d="M366 68 C374 68 379 69 383 70 L380 86 L365 87 Z" fill="#2b4a63" opacity="0.7" />

      {/* cabin windows */}
      <g fill="#3d5a72" opacity="0.7">
        {Array.from({ length: 13 }, (_, i) => 156 + i * 15).map((x) => (
          <rect key={x} x={x} y={76} width="8" height="7" rx="3.2" />
        ))}
      </g>

      {/* door seams + cheat line */}
      <path d="M210 66 L210 116" stroke="#bccbd5" strokeWidth="1.3" opacity="0.85" />
      <path d="M292 65 L292 114" stroke="#bccbd5" strokeWidth="1.3" opacity="0.8" />
      <path d="M332 64 L332 113" stroke="#bccbd5" strokeWidth="1.3" opacity="0.4" />
      <path d="M148 102 L390 94" stroke="#0a6b3a" strokeWidth="2.6" opacity="0.55" />

      {/* nose highlight */}
      <path d="M364 63 C390 64 406 70 410 84" stroke="#ffffff" strokeWidth="2.2" fill="none" opacity="0.8" />
    </svg>
  );
}
