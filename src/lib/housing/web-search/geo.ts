import "server-only";

/**
 * Location correctness for the housing web search.
 *
 * 2026-10-10 production incident: a search for Berlin displayed listings
 * from Frankfurt because the pipeline labelled EVERY result with the
 * user's requested city (`city = params.city`) regardless of where the
 * listing actually is. Bing's geo-bias is soft — a "Mietwohnung Berlin"
 * query legitimately returns other cities' results, portal search pages,
 * and mis-scraped items.
 *
 * Rule implemented here:
 *   - A result may only be labelled with the requested city when its
 *     LOCATION EVIDENCE (fetched page > cited model JSON > title/URL slug)
 *     supports it.
 *   - Evidence naming a KNOWN different German city → the result is a
 *     city mismatch and is REJECTED (counted, never shown).
 *   - Evidence that is absent or not a known city → the result is shown
 *     with an explicit "location unverified" flag — never with the
 *     requested city.
 *   - A differing 5-digit postal code is decisive (mismatch).
 *
 * The city table is intentionally conservative (major German cities +
 * unambiguous aliases). Names not in the table are treated as unknown
 * (possibly a district we don't know — e.g. "Neukölln" must never be
 * rejected for a Berlin search).
 */

/** Fold a city name to a normalized key: lowercase, umlauts/ß folded,
 *  punctuation and repeated whitespace collapsed. */
export function normalizeCityKey(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFC")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Known German cities: folded key (including unambiguous aliases) →
 * display name. Note the deliberate disambiguation: "frankfurt" (am
 * Main) and "frankfurt oder" are DIFFERENT cities.
 */
export const CITIES: Record<string, string> = {
  aachen: "Aachen",
  augsburg: "Augsburg",
  berlin: "Berlin",
  bielefeld: "Bielefeld",
  bochum: "Bochum",
  bonn: "Bonn",
  bremen: "Bremen",
  chemnitz: "Chemnitz",
  darmstadt: "Darmstadt",
  dresden: "Dresden",
  duesseldorf: "Düsseldorf",
  dortmund: "Dortmund",
  duisburg: "Duisburg",
  essen: "Essen",
  erfurt: "Erfurt",
  frankfurt: "Frankfurt (Main)",
  "frankfurt am main": "Frankfurt (Main)",
  "frankfurt oder": "Frankfurt (Oder)",
  freiburg: "Freiburg (Breisgau)",
  "freiburg breisgau": "Freiburg (Breisgau)",
  "halle saale": "Halle (Saale)",
  halle: "Halle (Saale)",
  hannover: "Hannover",
  heidelberg: "Heidelberg",
  hamburg: "Hamburg",
  kassel: "Kassel",
  karlsruhe: "Karlsruhe",
  kiel: "Kiel",
  koeln: "Köln",
  leipzig: "Leipzig",
  luebeck: "Lübeck",
  magdeburg: "Magdeburg",
  mainz: "Mainz",
  mannheim: "Mannheim",
  muenchen: "München",
  muenster: "Münster",
  nuernberg: "Nürnberg",
  paderborn: "Paderborn",
  potsdam: "Potsdam",
  rostock: "Rostock",
  stuttgart: "Stuttgart",
  ulm: "Ulm",
  wiesbaden: "Wiesbaden",
  wuppertal: "Wuppertal",
};

/** Resolved canonical key ("Frankfurt (Main)") or null = not a known city. */
export function canonicalCityKey(name: string): string | null {
  const folded = normalizeCityKey(name);
  if (!folded) return null;
  return CITIES[folded] ?? null;
}

export function isKnownCity(name: string): boolean {
  return canonicalCityKey(name) !== null;
}

/** `long` equals `short` or starts with it as a full word
 *  ("berlin mitte" ~ "berlin"). Input must already be folded. */
function startsWithWord(long: string, short: string): boolean {
  return long === short || long.startsWith(`${short} `);
}

export type CityMatchStatus = "match" | "mismatch" | "unknown";

export interface CityMatch {
  status: CityMatchStatus;
  /** The evidence city as given (display string), or null. */
  evidenceCity: string | null;
  /** Canonical key of the evidence city when it is a known city. */
  evidenceKey: string | null;
}

/**
 * Compare location evidence against the requested location.
 *
 * - A DIFFERENT 5-digit postal code in the evidence is decisive: mismatch.
 * - Both sides a known city: equal = match, different = mismatch.
 * - Evidence unknown (absent, or a name not in the table): never a
 *   mismatch (could be an unknown district) — unknown, unless it is a
 *   district-style extension of the requested name ("berlin mitte").
 */
export function matchCity(
  requestedCity: string,
  requestedPlz: string,
  evidenceCity: string | null,
  evidencePlz: string | null,
): CityMatch {
  const reqPlz = (requestedPlz ?? "").trim();
  const evPlz = (evidencePlz ?? "").trim();
  const reqFolded = normalizeCityKey(requestedCity ?? "");
  const evFolded = normalizeCityKey(evidenceCity ?? "");
  const evCanon = evFolded ? (CITIES[evFolded] ?? null) : null;

  // 1) Postal codes are precise evidence.
  if (reqPlz && evPlz) {
    if (reqPlz === evPlz) {
      return { status: "match", evidenceCity: evidenceCity, evidenceKey: evCanon };
    }
    return { status: "mismatch", evidenceCity: evidenceCity, evidenceKey: evCanon };
  }

  // 2) City-name evidence.
  if (!evFolded) {
    return { status: "unknown", evidenceCity: null, evidenceKey: null };
  }
  if (!reqFolded) {
    // Requested by postal code only — we have no PLZ→city table, so a
    // city name can neither confirm nor refute the request.
    return { status: "unknown", evidenceCity: evidenceCity, evidenceKey: evCanon };
  }
  const reqCanon = CITIES[reqFolded] ?? null;
  if (reqCanon && evCanon) {
    return {
      status: reqCanon === evCanon ? "match" : "mismatch",
      evidenceCity,
      evidenceKey: evCanon,
    };
  }
  // One or both sides unknown: only a district-style containment counts
  // as supporting evidence ("Berlin-Mitte" for a Berlin request).
  if (startsWithWord(evFolded, reqFolded) || (reqCanon && !evCanon && startsWithWord(reqFolded, evFolded))) {
    return { status: "match", evidenceCity, evidenceKey: evCanon };
  }
  return { status: "unknown", evidenceCity, evidenceKey: evCanon };
}

/**
 * Find a KNOWN city name inside free text (title or URL slug). Uses
 * single-word keys only, word-boundary exact matches — "Frankfurter
 * Allee" (a street IN Berlin) must NOT extract "Frankfurt".
 */
const TEXT_CITY_KEYS = Object.keys(CITIES)
  .filter((k) => !k.includes(" "))
  .sort((a, b) => b.length - a.length);

export function extractCityFromText(text: string): string | null {
  if (!text) return null;
  const folded = ` ${normalizeCityKey(text)} `;
  for (const key of TEXT_CITY_KEYS) {
    if (folded.includes(` ${key} `)) return CITIES[key];
  }
  return null;
}
