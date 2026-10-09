import type { HousingSearchParams } from "@/lib/housing/types";

/**
 * Query construction for housing web discovery.
 *
 * The PRIMARY query is German (the market language) and names the concrete
 * constraints the user set. In general mode a secondary ENGLISH query is
 * generated only as a retry when the first call yields fewer than 3 usable
 * candidates — so the common case is exactly one (paid) search call.
 *
  * Targeted mode uses ONE query: the domain restriction is applied by the
  * search API itself (Azure `web_search` tool `allowed_domains` filter),
  * never by stuffing `site:` into the query text.
 */

type TypeKey = HousingSearchParams["accommodation_type"];

const TYPE_DE: Record<TypeKey, string> = {
  all: "Mietwohnung",
  apartment: "Mietwohnung",
  wg_room: "WG-Zimmer",
  furnished: "möblierte Wohnung",
  studio: "Studio-Wohnung",
};

const TYPE_EN: Record<TypeKey, string> = {
  all: "rental apartment",
  apartment: "rental apartment",
  wg_room: "shared flat room (WG)",
  furnished: "furnished rental apartment",
  studio: "studio apartment for rent",
};

export interface BuiltQueries {
  /** Always ≥1; index 0 is the primary (German) query. */
  queries: string[];
  /** The single query used in targeted mode (German). */
  targetedQuery: string;
}

/**
 * Explicit web-search instruction wrapped around the raw query.
 *
 * The official docs' troubleshooting section is unambiguous: with
 * tool_choice "auto" the model may answer WITHOUT performing a search or
 * WITHOUT citing sources — "prompt more explicitly to browse the web or ask
 * for citations". A bare query string as `input` is exactly the case that
 * produced "search consumed quota but zero listings displayed", so the
 * instruction is part of the request contract now, not a nicety.
 * The raw query is preserved verbatim inside (tests assert this).
 */
function wrapInstruction(query: string, lang: "de" | "en"): string {
  if (lang === "de") {
    return (
      `Führe eine Websuche im aktuellen Internet durch nach konkreten, aktuell ausstehenden Einzelangeboten für: ${query}. ` +
      `Liste im Ergebnis einzelne konkrete Angebote auf und gib für JEDES Angebot den direkten Link (URL) zur jeweiligen Angebotsseite an ` +
      `(also die URL des einzelnen Objekts, keine Übersichts- oder Suchergebnisseite), mit kurzer Angabe zu Ort und Mietpreis, soweit der Suchtreffer sie nennt. ` +
      `Nutze ausschließlich die Websuche und zitiere die Quellen (Links) direkt in der Antwort.`
    );
  }
  return (
    `Perform a live web search for currently available individual rental listings matching: ${query}. ` +
    `List each concrete listing and give the DIRECT LINK (URL) to the individual listing page for EVERY listing ` +
    `(the URL of the single property, not a search or overview page), with short location and rent details where the search result states them. ` +
    `Use the web search only and cite the sources (links) directly in your answer.`
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

  const roomsDe =
    params.rooms === "all" ? null : `${params.rooms} Zimmer`;
  const roomsEn =
    params.rooms === "all" ? null : `${params.rooms} room${params.rooms > 1 ? "s" : ""}`;

  const partsDe: string[] = [TYPE_DE[params.accommodation_type]];
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
  const de = partsDe.filter(Boolean).join(", ").slice(0, 400);

  const partsEn: string[] = [TYPE_EN[params.accommodation_type]];
  if (location !== "") partsEn.push(location);
  if (params.max_warm_rent != null) partsEn.push(`max ${params.max_warm_rent} EUR warm rent`);
  if (roomsEn) partsEn.push(roomsEn);
  if (params.min_area_sqm != null) partsEn.push(`min ${params.min_area_sqm} sqm`);
  const en = partsEn.filter(Boolean).join(", ").slice(0, 400);

  return {
    queries: [wrapInstruction(de, "de"), wrapInstruction(en, "en")],
    targetedQuery: wrapInstruction(de, "de"),
  };
}
