/**
 * Community identity — generated (non-human) usernames.
 *
 * Pure/isomorphic: no React, no DOM, no network — testable in node with an
 * injected RNG.
 *
 * Design:
 *  - A username is ALWAYS "Adjective + Creature" (e.g. "BlueFalcon",
 *    "SilverFox"). The word lists deliberately contain no personal first
 *    names, so a generated identity can never look like someone's real name
 *    (§5: not the real name, not a human).
 *  - The lists are curated (64 × 48 = 3 072 combinations). That is far above
 *    the expected member count for a long time; even when collisions start
 *    to matter, uniqueness is enforced by the database (case-insensitive
 *    unique index) and the onboarding flow simply regenerates on "taken".
 *  - `generateCommunityUsername` accepts an injected RNG so tests are
 *    deterministic; the default uses `crypto.getRandomValues`.
 */

import {
  COMMUNITY_MAX_USERNAME_LENGTH,
  COMMUNITY_MIN_USERNAME_LENGTH,
  COMMUNITY_USERNAME_REGEX,
} from "../community";

const ADJECTIVES = [
  "Blue",
  "Silver",
  "Golden",
  "Crimson",
  "Emerald",
  "Sapphire",
  "Amber",
  "Violet",
  "Scarlet",
  "Midnight",
  "Star",
  "Shadow",
  "Crystal",
  "Solar",
  "Lunar",
  "Frost",
  "Storm",
  "Thunder",
  "Rapid",
  "Brave",
  "Noble",
  "Wise",
  "Silent",
  "Swift",
  "Bright",
  "Royal",
  "Mystic",
  "Ancient",
  "Calm",
  "Lucky",
  "Bold",
  "Clever",
  "Gentle",
  "Happy",
  "Jolly",
  "Kind",
  "Merry",
  "Proud",
  "Quiet",
  "Sharp",
  "Sunny",
  "Wild",
  "Cosmic",
  "Electric",
  "Fading",
  "Floating",
  "Gliding",
  "Hidden",
  "Iron",
  "Jade",
  "Kaleido",
  "Lava",
  "Maple",
  "Moss",
  "Ocean",
  "Pixel",
  "Quiet",
  "Ruby",
  "Sage",
  "Tidal",
  "Twilight",
  "Velvet",
  "Zephyr",
  "Arctic",
  "Copper",
] as const;

const CREATURES = [
  "Falcon",
  "Fox",
  "Wolf",
  "Eagle",
  "Owl",
  "Lynx",
  "Bear",
  "Hawk",
  "Deer",
  "Lion",
  "Tiger",
  "Panther",
  "Otter",
  "Hare",
  "Swan",
  "Dolphin",
  "Shark",
  "Comet",
  "Nova",
  "Orbit",
  "Wave",
  "Peak",
  "Ridge",
  "Canyon",
  "Forest",
  "Glacier",
  "Meteor",
  "Phoenix",
  "Dragon",
  "Griffin",
  "Sprite",
  "Golem",
  "Sphinx",
  "Kraken",
  "Turtle",
  "Raven",
  "Stag",
  "Viper",
  "Wolf",
  "Heron",
  "Ibex",
  "Kestrel",
  "Lizard",
  "Manta",
  "Narwhal",
  "Orca",
  "Puma",
  "Quetzal",
  "Ray",
] as const;

/** Deduplicated, order-preserving copy of a word list. */
function dedupe(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

const ADJ: readonly string[] = dedupe(ADJECTIVES);
const CRE: readonly string[] = dedupe(CREATURES);

/** Uniform integer in [0, max) from the injected RNG (0 ≤ rng() < 1). */
function pick(list: readonly string[], rng: () => number): string {
  const index = Math.min(list.length - 1, Math.floor(rng() * list.length));
  return list[Math.max(0, index)];
}

const defaultRng = (): number => {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return bytes[0] / 0x1_0000_0000;
};

/**
 * Generate one candidate username ("AdjectiveCreature", 5–24 chars — always
 * inside the valid range). The result is a CANDIDATE: uniqueness is enforced
 * by the database at claim time (the onboarding flow regenerates on conflict).
 */
export function generateCommunityUsername(rng: () => number = defaultRng): string {
  const name = `${pick(ADJ, rng)}${pick(CRE, rng)}`;
  return name.slice(0, COMMUNITY_MAX_USERNAME_LENGTH);
}

/**
 * Retry helper for the onboarding flow: keep generating until a candidate
 * the server accepted comes back (the server re-checks uniqueness either
 * way, so even a false positive here is harmless — it costs one extra
 * round-trip at most).
 */
export function generateUniqueCandidate(
  taken: (candidate: string) => boolean,
  rng: () => number = defaultRng,
  maxAttempts = 5,
): string {
  for (let i = 0; i < maxAttempts; i++) {
    const candidate = generateCommunityUsername(rng);
    if (!taken(candidate)) return candidate;
  }
  return generateCommunityUsername(rng);
}

/** Structural sanity for anything that will become a username. */
export function isPlausibleCommunityUsername(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length >= COMMUNITY_MIN_USERNAME_LENGTH &&
    trimmed.length <= COMMUNITY_MAX_USERNAME_LENGTH &&
    COMMUNITY_USERNAME_REGEX.test(trimmed)
  );
}
