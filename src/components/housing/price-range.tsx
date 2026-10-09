"use client";

import { useId } from "react";

interface Props {
  /** Current max warm rent in EUR. */
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  /** Rendered under the slider: min + current value labels. */
  format: (value: number) => string;
}

/**
 * A single-thumb price slider for the "Max. Warmmiete" filter. Purely
 * controlled; the parent decides how the value maps to the search params
 * (the top end means "no cap").
 */
export function PriceRange({ value, min = 0, max = 3000, step = 50, onChange, format }: Props) {
  const id = useId();
  return (
    <div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={Math.min(value, max)}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-2 w-full cursor-pointer appearance-none rounded-full bg-line-strong accent-accent"
        aria-label={id}
      />
      <div className="mt-1.5 flex justify-between text-xs text-muted">
        <span>{format(min)}</span>
        <span className="font-semibold text-ink-soft">{format(value)}</span>
      </div>
    </div>
  );
}
