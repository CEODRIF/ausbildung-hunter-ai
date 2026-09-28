/**
 * Deterministic text utilities for the matching engine.
 * No LLM, no network. Every function is a pure function of its input.
 */

/** German education hierarchy rank used by the provider layer. A documented
 *  higher qualification satisfies a lower documented requirement. */
export type EducationLevel =
  "basic" | "intermediate" | "advanced" | "university";

export const EDUCATION_RANK: Record<EducationLevel, number> = {
  basic: 1,
  intermediate: 2,
  advanced: 3,
  university: 4,
};

/** Fold German umlauts so "Ärztehaus" matches "Aerztehaus", "Straße" matches
 *  "Strasse" (documented normalization, applied everywhere in matching). */
export function foldUmlauts(value: string): string {
  return value
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss");
}

/** Canonical token form: German lowercasing, umlaut folding, non-alphanumerics
 *  → single spaces, trimmed. */
export function normalizeText(value: string): string {
  return foldUmlauts(value)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function tokensOf(value: string): string[] {
  const normalized = normalizeText(value);
  return normalized ? normalized.split(" ") : [];
}

/** Content tokens (length ≥ 4) — short tokens ("it", "ui", "und") are too
 *  generic to be evidence. Documented. */
export function contentTokens(value: string): string[] {
  return tokensOf(value).filter((token) => token.length >= 4);
}

/** German CEFR scale. */
export type CefrLevel = 1 | 2 | 3 | 4 | 5 | 6;
export const CEFR_ORDER: Record<CefrLevel, string> = {
  1: "A1",
  2: "A2",
  3: "B1",
  4: "B2",
  5: "C1",
  6: "C2",
};

/** Parse a documented CEFR level out of free text. Returns null when no
 *  level is documented (never guessed). */
export function parseCefrLevel(text: string | null): CefrLevel | null {
  if (!text) return null;
  const normalized = normalizeText(text);
  const match = normalized.match(/\b(a[12]|b[12]|c[12])\b/);
  if (match) {
    const code = match[1];
    const levels: Record<string, CefrLevel> = {
      a1: 1,
      a2: 2,
      b1: 3,
      b2: 4,
      c1: 5,
      c2: 6,
    };
    return levels[code];
  }
  if (
    /muttersprache|native|fließend|native speaker|muttersprachlich/.test(
      normalized,
    )
  ) {
    return 6; // native is treated as C2-equivalent (documented)
  }
  return null;
}

/** Canonical language names (deterministic synonym map). */
const LANGUAGE_SYNONYMS: Record<string, string> = {
  deutsch: "german",
  german: "german",
  de: "german",
  englisch: "english",
  english: "english",
  en: "english",
  französisch: "french",
  french: "french",
  fr: "french",
  spanisch: "spanish",
  spanish: "spanish",
  es: "spanish",
  italienisch: "italian",
  italian: "italian",
  it: "italian",
  portugiesisch: "portuguese",
  portuguese: "portuguese",
  pt: "portuguese",
  russisch: "russian",
  russian: "russian",
  ru: "russian",
  türkisch: "turkish",
  turkish: "turkish",
  tr: "turkish",
  arabisch: "arabic",
  arabic: "arabic",
  ar: "arabic",
  polnisch: "polish",
  polish: "polish",
  pl: "polish",
};

export function canonicalLanguageName(name: string): string {
  const normalized = normalizeText(name);
  const single = normalized.split(" ")[0] ?? "";
  return LANGUAGE_SYNONYMS[single] ?? (normalized || single);
}

/** Parse an opportunity language requirement like "German B1", "Deutsch",
 *  "Englisch B2" into name + optional level. */
export function parseLanguageRequirement(
  raw: string,
): { name: string; cefr: CefrLevel | null } | null {
  const normalized = normalizeText(raw);
  if (!normalized) return null;
  const cefr = parseCefrLevel(normalized);
  const withoutLevel = normalized
    .replace(/\b(a[12]|b[12]|c[12])\b/g, " ")
    .replace(
      /muttersprache|native|fließend|native speaker|muttersprachlich/g,
      " ",
    )
    .trim();
  const name = canonicalLanguageName(withoutLevel);
  if (!name) return null;
  return { name, cefr };
}

/** Map a documented education string (free text, German) onto the hierarchy.
 *  Returns null when no level is recognizable (never guessed). */
export function parseEducationLevel(
  text: string | null,
): EducationLevel | null {
  if (!text) return null;
  const normalized = foldUmlauts(text.toLowerCase())
    .replace(/\s+/g, " ")
    .trim();
  // Order matters: the more specific terms are checked first.
  if (/fachhochschulreife|fachabitur|fachobert/.test(normalized))
    return "advanced";
  if (
    /hochschulreife|gymnasial|abitur|bachelor|master|diplom|studienabschluss|fernstudium|universit/.test(
      normalized,
    )
  )
    return "university";
  if (
    /mittlere reife|mittlerer schulabschluss|mittlere schulreife|realschul|mittelschul|realgymnasium|sekundar/i.test(
      normalized,
    )
  )
    return "intermediate";
  if (/hauptschul|haupt-?schulreife|berufsreife/.test(normalized))
    return "basic";
  return null;
}

/** Parse a documented date leniently: full ISO, YYYY-MM, or YYYY.
 *  Returns epoch ms or null (never guessed). */
export function parseDateMs(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  const full = trimmed.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
  if (full) {
    const year = Number(full[1]);
    const month = Number(full[2]);
    const day = full[3] ? Number(full[3]) : 1;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const ms = Date.UTC(year, month - 1, day);
    return Number.isNaN(ms) ? null : ms;
  }
  const yearOnly = trimmed.match(/^(\d{4})$/);
  if (yearOnly) {
    const ms = Date.UTC(Number(yearOnly[1]), 0, 1);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/** Mean Gregorian year in ms (deterministic constant, no wall clock). */
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/** Documented experience in years between two parsed dates (clamped ≥ 0). */
export function documentedYearsMs(startMs: number, endMs: number): number {
  return Math.max(0, endMs - startMs) / MS_PER_YEAR;
}

/**
 * Extract an explicitly documented experience requirement (in whole years)
 * from a requirement line, e.g. "2 Jahre Erfahrung", "3 Jahre
 * Berufserfahrung", "5 years of experience". Returns null when no such
 * statement exists — experience is never inferred from other wording.
 */
export function parseExperienceRequirement(line: string): number | null {
  const normalized = foldUmlauts(line.toLowerCase())
    .replace(/\s+/g, " ")
    .trim();
  const german = normalized.match(
    /(\d{1,2})\s*jahre\s*(?:berufserfahrung|erfahrung|relevante erfahrung)/,
  );
  if (german) return Math.min(50, Number(german[1]));
  const english = normalized.match(
    /(\d{1,2})\s*(?:years?|yrs?)\s+(?:of\s+)?experience/,
  );
  if (english) return Math.min(50, Number(english[1]));
  return null;
}

/** Postal-code token (5 digits) when present in a location string. */
export function postalToken(value: string): string | null {
  const match = value.match(/\b\d{5}\b/);
  return match ? match[0] : null;
}
