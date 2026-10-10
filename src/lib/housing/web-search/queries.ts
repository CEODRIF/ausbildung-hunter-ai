import type { HousingSearchParams } from "@/lib/housing/types";

/**
 * Query construction for housing web discovery.
 *
 * General mode issues MULTIPLE complementary German queries (the market
 * language), each naming the concrete constraints the user set:
 *   - accommodation_type "all": FOUR query families — apartments
 *     (Mietwohnung), shared rooms (WG-Zimmer), student housing
 *     (Studentenwohnung) and private rentals (direkt vom Eigentümer).
 *     Different families surface different index rankings and portals
 *     (WG-Gesucht for rooms, university housing for student offers,
 *     private-landlord pages for direct rentals) — a single "Mietwohnung"
 *     query systematically misses them, which is why a 28-result search
 *     could still display zero listings.
 *   - specific types: TWO complementary phrasings of that type
 *     ("Mietwohnung …" vs. "Wohnung mieten …").
 * Calls are bounded and cost-aware (see ./discovery + ./config): the
 * primary call always runs; complementary calls run in a bounded-
 * parallelism pool and stop early once enough candidates exist, the
 * transaction budget is exhausted, the deadline is near, or a call added
 * no new candidates.
 *
 * The instruction wrapper demands a STRICT JSON answer (one object per
 * listing, unknowns as null). That is the reliable way to get per-listing
 * fields (rents, rooms, area, …) without fabricating anything: discovery
 * cross-validates every JSON URL against the URLs the search tool actually
 * returned, and falls back to citation-only results when the model ignores
 * the format (truncated/garbled JSON).
 *
 * Targeted mode uses ONE query: the domain restriction is applied by the
 * search API itself (Azure `web_search` tool `allowed_domains` filter),
 * never by stuffing `site:` into the query text.
 */

type TypeKey = HousingSearchParams["accommodation_type"];

/** Primary German term per accommodation type. Exported so the multi-round
 *  query planner (./query-planner) reuses the exact same type wording. */
export const TYPE_DE: Record<TypeKey, string> = {
  all: "Mietwohnung",
  apartment: "Mietwohnung",
  wg_room: "WG-Zimmer",
  furnished: "möblierte Wohnung",
  studio: "Studio-Wohnung",
};

/** Complementary German phrasing (different index ranking). Exported for
 *  the same reason as TYPE_DE. */
export const TYPE_DE_ALT: Record<TypeKey, string> = {
  all: "Wohnung mieten",
  apartment: "Wohnung mieten",
  wg_room: "Zimmer in WG mieten",
  furnished: "möblierte Wohnung mieten",
  studio: "Studio mieten",
};

/**
 * Query families for accommodation_type "all" — one per market segment.
 * Order = call order (primary first; the rest are complementary and
 * subject to the cost-aware early-stop). Exported so the multi-round
 * query planner (./query-planner) reuses the exact same families.
 */
export const ALL_TYPE_FAMILIES: readonly string[] = [
  "Mietwohnung", // apartments (incl. normal private rentals)
  "WG-Zimmer mieten", // shared rooms / WG
  "Studentenwohnung mieten", // student housing (also surfaces WGH offers)
  "Wohnung privat direkt vom Eigentümer mieten", // private rentals / direct
];

export interface BuiltQueries {
  /** Complementary German queries for general mode: 4 for "all"
   *  (apartment / WG / student / private rental), 2 for specific types. */
  queries: string[];
  /** The single query used in targeted mode (the primary German one). */
  targetedQuery: string;
}

export type QueryParams = Pick<
  HousingSearchParams,
  | "city"
  | "postal_code"
  | "radius_km"
  | "max_warm_rent"
  | "accommodation_type"
  | "rooms"
  | "min_area_sqm"
  | "available_before"
>;

/**
 * Build ONE raw German query for a type term + the user's constraints.
 * Exported so the multi-round query planner (./query-planner) and the
 * classic pipeline share the exact same constraint wording.
 */
export function buildDeRawQuery(params: QueryParams, typeTerm: string): string {
  const city = params.city.trim();
  const plz = params.postal_code.trim();
  const location = city !== "" ? city : plz;

  const roomsDe = params.rooms === "all" ? null : `${params.rooms} Zimmer`;

  const partsDe: string[] = [typeTerm];
  if (location !== "") partsDe.push(location);
  if (params.max_warm_rent != null) {
    partsDe.push(`bis ${params.max_warm_rent.toLocaleString("de-DE")} Euro Warmmiete`);
  }
  if (roomsDe) partsDe.push(roomsDe);
  if (params.min_area_sqm != null) partsDe.push(`mind. ${params.min_area_sqm} m²`);
  if (params.available_before) {
    // Round-trip validation: some engines normalize overflow dates
    // (e.g. "2026-02-30" → March), which must not leak into the query.
    const d = new Date(params.available_before);
    const [y, m, day] = params.available_before.split("-").map(Number);
    if (
      !Number.isNaN(d.getTime()) &&
      d.getUTCFullYear() === y &&
      d.getUTCMonth() + 1 === m &&
      d.getUTCDate() === day
    ) {
      partsDe.push(`frei ab ${d.toISOString().slice(0, 10)}`);
    }
  }
  if (params.radius_km > 0 && city !== "") partsDe.push(`in der Umgebung von ${city}`);
  return partsDe.filter(Boolean).join(", ").slice(0, 400);
}

/**
 * Explicit web-search + structured-output instruction.
 *
 * The official docs' troubleshooting section is unambiguous: with
 * tool_choice "auto" the model may answer WITHOUT performing a search or
 * WITHOUT citing sources — "prompt more explicitly to browse the web or ask
 * for citations". The JSON contract goes one step further and makes the
 * answer machine-readable, with explicit anti-fabrication rules. The raw
 * constraint query is preserved verbatim inside (tests assert this).
 */
export function wrapInstruction(rawQuery: string): string {
  return (
    `Führe eine Websuche im aktuellen Internet durch und finde konkrete, aktuell ausstehende ` +
    `MIETangebote (keine Kaufangebote!) für: ${rawQuery}. ` +
    `Antworte AUSSCHLIESSLICH mit einem gültigen JSON-Array (kein Markdown, keine Code-Zeichen, ` +
    `kein anderer Text). Jedes Element beschreibt genau EINES der gefundenen Einzelangebote mit den ` +
    `Feldern: "url" (die exakte, direkte URL der EINZELNEN Angebotsseite – keine Such-, ` +
    `Übersichts- oder Startseite), "title", "city", "rent_cold_eur" (Kaltmiete EUR/Monat), ` +
    `"rent_warm_eur" (Warmmiete EUR/Monat), "additional_costs_eur" (Nebenkosten EUR/Monat), ` +
    `"rooms" (Zimmer), "living_area_sqm" (Wohnfläche m²), "floor" (Etage, z. B. "1. OG"), ` +
    `"available_from" ("YYYY-MM-DD" oder null), "furnished" (true/false/null), ` +
    `"deposit_eur" (Kaution in EUR, einmalig), "address" (Straße und Hausnummer, ohne Stadtname), ` +
    `"pets_allowed" (Haustiere erlaubt: true/false/null), "wg_suitable" (auch als WG geeignet: ` +
    `true/false/null), "source" (Portalname). ` +
    `Regeln: Liste SO VIELE konkrete Einzelangebote wie in den Suchergebnissen vorhanden (mind. 5, ` +
    `soweit möglich). Nenne für JEDES Angebot seinen direkten Link (URL) und zitiere die Quellen. ` +
    `Jedes unbekannte Feld muss null sein. Nutze Werte NUR aus den tatsächlichen Websuche-Ergebnissen. ` +
    `Erfinde niemals Preise, Adressen, Zimmerzahlen, Bilder oder sonstige Details. ` +
    `Füge kein Angebot hinzu, das die Websuche nicht tatsächlich zurückgegeben hat. ` +
    `Nenne KEINE Startseite, Suchseite oder Kategorie-Seite als Angebot.`
  );
}

/**
 * Build the search queries for one housing search.
 * Location = the user's city (wins) or postal code.
 */
export function buildHousingQueries(params: QueryParams): BuiltQueries {
  const buildDe = (typeTerm: string): string => buildDeRawQuery(params, typeTerm);

  const type = params.accommodation_type;
  // "all" → one query per market segment (apartments, WG, student, private
  // rental); specific types → primary + complementary phrasing.
  const terms: string[] =
    type === "all"
      ? [...ALL_TYPE_FAMILIES]
      : [TYPE_DE[type], TYPE_DE_ALT[type]];
  // De-duplicate terms (defensive; the families are distinct by design).
  const seen = new Set<string>();
  const queries = terms
    .filter((term) => (seen.has(term) ? false : (seen.add(term), true)))
    .map((term) => wrapInstruction(buildDe(term)));

  return {
    queries,
    targetedQuery: queries[0],
  };
}
