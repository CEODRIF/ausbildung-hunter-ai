/**
 * Smart Sending — sender-level pacing configuration.
 *
 * The guarantee: two messages from the SAME sender account are never sent
 * less than MIN_SEND_INTERVAL_MS apart, no matter how many campaigns,
 * workers, tabs or reloads are involved. The atomic enforcement itself
 * lives in Postgres (`reserve_sender_slot` — one conditional UPDATE, one
 * winner per window); this module only defines the interval the engine
 * asks the database to enforce.
 *
 * The database also enforces a 5000ms floor, so even a bug here can never
 * pace below 5 seconds.
 */

/** Absolute floor — no interval below this may ever be applied. */
export const HARD_MIN_SEND_INTERVAL_MS = 5000;
/** The configured minimum interval: the fixed default (safest mode —
 *  deliberately NO randomization at launch: always 6000ms). */
export const MIN_SEND_INTERVAL_MS = 6000;
/** Upper bound for any future randomization (stays 5000–6000ms). */
export const MAX_SEND_INTERVAL_MS = 6000;

/** Clamp any proposed interval into the only legal range (5000–6000ms). */
export function clampSendIntervalMs(value: number): number {
  if (!Number.isFinite(value)) return MIN_SEND_INTERVAL_MS;
  return Math.min(
    MAX_SEND_INTERVAL_MS,
    Math.max(HARD_MIN_SEND_INTERVAL_MS, Math.round(value)),
  );
}

/** The interval the worker currently asks for: fixed 6000ms. */
export function sendIntervalMs(): number {
  return clampSendIntervalMs(MIN_SEND_INTERVAL_MS);
}

/** How long one batch may wait for a busy sender slot before stopping
 *  cleanly (the messages simply stay queued for the next tick). Kept
 * short so a single serverless call stays within its time budget — and
 * stopping early is always safe, because the reservation happens BEFORE
 * any message is claimed (no partial state can be left behind). */
export const SENDER_SLOT_WAIT_BUDGET_MS = 8000;
