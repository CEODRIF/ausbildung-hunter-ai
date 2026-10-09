import type { HousingSearchParams } from "@/lib/housing/types";

/**
 * Query construction for housing web discovery.
 *
 * BOTH general-mode queries are German (the market language) and name the
 * concrete constraints the user set. They use COMPLEMENTARY phrasings
 * ("Mietwohnung …" vs. "Wohnung mieten …") so the two paid calls retrieve
 * different index rankings and the merged result set is materially larger
 * than a single call. The secondary call only runs when the first under-
 * delivered (see LIMITS.webModeSecondCallThreshold) — cost-aware.
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

/** Primary German term per accommodation type. */
const TYPE_DE: Record<TypeKey, string> = {
  all: "Mietwohnung",
  apartment: "Mietwohnung",
  wg_room: "WG-Zimmer",
  furnished: "möblierte Wohnung",
  studio: "Studio-Wohnung",
};

/** Complementary German phrasing (different index ranking). */
const TYPE_DE_ALT: Record<TypeKey, string> = {
  all: "Wohnung mieten",
  apartment: "Wohnung mieten",
  wg_room: "Zimmer in WG mieten",
  furnished: "möblierte Wohnung mieten",
  studio: "Studio mieten",
};

export interface BuiltQueries {
  /** Exactly 2 complementary German queries for general mode. */
  queries: [string, string];
  /** The single query used in targeted mode (the primary German one). */
  targetedQuery: string;
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
function wrapInstruction(rawQuery: string): string {
  return (
    `Führe eine Websuche im aktuellen Internet durch und finde konkrete, aktuell ausstehende ` +
    `Mietangebote für: ${rawQuery}. ` +
    `Antworte AUSSCHLIESSLICH mit einem gültigen JSON-Array (kein Markdown, keine Code-Zeichen, ` +
    `kein anderer Text). Jedes Element beschreibt genau EINES der gefundenen Einzelangebote mit den ` +
    `Feldern: "url" (die exakte, direkte URL der EINZELNEN Angebotsseite – keine Such-, ` +
    `Übersichts- oder Startseite), "title", "city", "rent_cold_eur" (Kaltmiete EUR/Monat), ` +
    `"rent_warm_eur" (Warmmiete EUR/Monat), "additional_costs_eur" (Nebenkosten EUR/Monat), ` +
    `"rooms" (Zimmer), "living_area_sqm" (Wohnfläche m²), "floor" (Etage, z. B. "1. OG"), ` +
    `"available_from" ("YYYY-MM-DD" oder null), "furnished" (true/false/null), "source" (Portalname). ` +
    `Regeln: Liste SO VIELE konkrete Einzelangebote wie in den Suchergebnissen vorhanden (mind. 5, ` +
    `soweit möglich). Nenne für JEDES Angebot seinen direkten Link (URL) und zitiere die Quellen. ` +
    `Jedes unbekannte Feld muss null sein. Nutze Werte NUR aus den tatsächlichen Websuche-Ergebnissen. ` +
    `Erfinde niemals Preise, Adressen, Zimmerzahlen, Bilder oder sonstige Details. ` +
    `Füge kein Angebot hinzu, das die Websuche nicht tatsächlich zurückgegeben hat.`
  );
}

/**
 * Build the search queries for one housing search.
 * Location = the user's city (wins) or postal code.
 */
export function buildHousingQueries(
  params: Pick<
    HousingSearchParams,
    | "city"
    | "postal_code"
    | "radius_km"
    | "max_warm_rent"
    | "accommodation_type"
    | "rooms"
    | "min_area_sqm"
    | "available_before"
  >,
): BuiltQueries {
  const city = params.city.trim();
  const plz = params.postal_code.trim();
  const location = city !== "" ? city : plz;

  const roomsDe = params.rooms === "all" ? null : `${params.rooms} Zimmer`;

  const buildDe = (typeTerm: string): string => {
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
  };

  const primary = wrapInstruction(buildDe(TYPE_DE[params.accommodation_type]));
  const secondary = wrapInstruction(buildDe(TYPE_DE_ALT[params.accommodation_type]));

  return {
    queries: [primary, secondary],
    targetedQuery: primary,
  };
}
