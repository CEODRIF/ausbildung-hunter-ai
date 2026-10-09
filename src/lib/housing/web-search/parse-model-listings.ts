import "server-only";

/**
 * Parsing of the model's structured JSON answer (the "strict JSON array"
 * contract in ./queries).
 *
 * Honesty rules (mirrors ./parse-listing):
 *  - Only values the model actually wrote are returned; unknown stays null.
 *  - Every field is type-coerced AND range-checked — out-of-range numbers
 *    (rents of 999999, 40 rooms) are treated as absent, not trusted.
 *  - A `url` must be a syntactically valid http(s) URL, otherwise the whole
 *    item is dropped (an unparseable item is unusable: without the URL it
 *    cannot be cited, deduped, or linked).
 *  - The caller (discovery) still cross-validates each URL against the URLs
 *    the search tool really returned — the parser does NOT guarantee
 *    provenance, it only guarantees shape.
 *
 * Robustness: the model may wrap the JSON in code fences, add a stray
 * sentence, or (with a tight token budget) be TRUNCATED mid-array. The
 * extractor salvages every complete array element it can find.
 */

export interface ModelListingItem {
  /** Raw (unnormalized) URL as written by the model. */
  url: string;
  title: string | null;
  city: string | null;
  rent_cold_eur: number | null;
  rent_warm_eur: number | null;
  additional_costs_eur: number | null;
  rooms: number | null;
  living_area_sqm: number | null;
  floor: string | null;
  /** ISO date (yyyy-mm-dd) or null. */
  available_from: string | null;
  furnished: boolean | null;
  source: string | null;
}

export interface ModelListingsParse {
  items: ModelListingItem[];
  /** True when a JSON array (possibly repaired/salvaged) was extracted. */
  parsed: boolean;
  /** True when the array appeared to be truncated and was salvaged. */
  truncated: boolean;
}

const MAX_TEXT_LEN = 200;

function asCleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_TEXT_LEN) return null;
  return trimmed;
}

function asMoney(value: unknown): number | null {
  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string") {
    // German number formats: "850", "1.234,50" (comma decimal), "1.234"
    // (thousands dot). Same discipline as parse-listing.ts.
    const cleaned = value.replace(/[\s€]/g, "");
    n = Number.parseFloat(
      cleaned.includes(",") ? cleaned.replace(/\./g, "").replace(",", ".") : cleaned.replace(/\.(?=\d{3})/g, ""),
    );
  } else {
    n = NaN;
  }
  if (!Number.isFinite(n) || n < 1 || n > 100000) return null;
  return Math.round(n * 100) / 100;
}

function asIntInRange(value: unknown, min: number, max: number): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

function asIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  // Round-trip: rejects 2026-02-30 and similar overflow dates.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() + 1 !== mo || dt.getUTCDate() !== d) return null;
  if (y < 2000 || y > 2100) return null;
  return value.trim();
}

function asBool(value: unknown): boolean | null {
  if (typeof value !== "boolean") return null;
  return value;
}

function asUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname || u.hostname.includes(" ")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function coerceItem(raw: unknown): ModelListingItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const url = asUrl(rec.url);
  if (!url) return null; // unusable without a valid URL
  return {
    url,
    title: asCleanString(rec.title),
    city: asCleanString(rec.city),
    rent_cold_eur: asMoney(rec.rent_cold_eur),
    rent_warm_eur: asMoney(rec.rent_warm_eur),
    additional_costs_eur: asMoney(rec.additional_costs_eur),
    rooms: asIntInRange(rec.rooms, 1, 30),
    living_area_sqm: asIntInRange(rec.living_area_sqm, 1, 5000),
    floor: asCleanString(rec.floor),
    available_from: asIsoDate(rec.available_from),
    furnished: asBool(rec.furnished),
    source: asCleanString(rec.source),
  };
}

/**
 * Try to read a JSON array out of `raw`. Returns { value, truncated } or
 * null. Handles: trailing commas, truncated arrays (salvage of complete
 * elements by closing the structure at the last complete element).
 */
function extractJsonArray(raw: string): { value: unknown; truncated: boolean } | null {
  // 1) Straight parse.
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return { value: v, truncated: false };
  } catch {
    /* fall through */
  }
  // 2) Trailing commas (common LLM artifact).
  try {
    const v = JSON.parse(raw.replace(/,\s*([}\]])/g, "$1"));
    if (Array.isArray(v)) return { value: v, truncated: false };
  } catch {
    /* fall through */
  }
  // 3) Truncation salvage: walk the characters, track the stack, and cut at
  //    the LAST position where a top-level array element ended (depth back
  //    to 1 inside the array). Append the closing brackets and re-parse.
  const salvaged = salvageCompleteElements(raw);
  if (salvaged !== null) {
    try {
      const v = JSON.parse(salvaged);
      if (Array.isArray(v)) return { value: v, truncated: true };
    } catch {
      /* give up */
    }
  }
  return null;
}

function salvageCompleteElements(raw: string): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lastCompleteEnd = -1; // index just after a complete top-level element
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 1) lastCompleteEnd = i + 1; // inside the top-level array
    }
  }
  if (lastCompleteEnd === -1) return null;
  // Drop a dangling comma after the last complete element.
  const cut = raw.slice(0, lastCompleteEnd).replace(/,\s*$/, "");
  return `${cut}]`;
}

/**
 * Extract the JSON array region from free model text: strip code fences,
 * then take from the first `[` to the LAST `]`. (A model that obeys the
 * "JSON only" contract produces exactly one array; a chatty one might add
 * prose around it.)
 */
function sliceArrayRegion(text: string): string | null {
  const noFences = text.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "");
  const start = noFences.indexOf("[");
  if (start === -1) return null;
  // Walk from the first "[" (string-aware) to the end of the FIRST top-level
  // array. Everything after it (prose, stray brackets) is excluded; a
  // TRUNCATED answer never reaches depth 0 — in that case take to the end of
  // the text and let the salvage step close the array.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < noFences.length; i++) {
    const ch = noFences[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return noFences.slice(start, i + 1);
    }
  }
  return noFences.slice(start);
}

/**
 * Parse the model's answer into structured listing items.
 * Returns `parsed: false` with no items when no usable JSON array exists —
 * the caller then falls back to citation-only results.
 */
export function parseModelListings(text: string): ModelListingsParse {
  const empty: ModelListingsParse = { items: [], parsed: false, truncated: false };
  if (typeof text !== "string" || text.trim() === "") return empty;

  const region = sliceArrayRegion(text);
  if (region === null) return empty;

  const extracted = extractJsonArray(region);
  if (extracted === null) return empty;

  const seen = new Set<string>();
  const items: ModelListingItem[] = [];
  for (const raw of extracted.value as unknown[]) {
    const item = coerceItem(raw);
    if (!item) continue;
    const key = item.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  if (items.length === 0) return empty;
  return { items, parsed: true, truncated: extracted.truncated };
}
