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
 * search API itself (`allowed_domains` / Tavily `include_domains`), never by
 * stuffing `site:` into the query text.
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

  return { queries: [de, en], targetedQuery: de };
}
