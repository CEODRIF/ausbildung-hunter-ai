/**
 * Listing extraction from a FETCHED page (targeted mode, fetchable domains).
 *
 * Honesty rules:
 *  - Only information ACTUALLY PRESENT on the page is extracted.
 *  - JSON-LD (schema.org) is the primary source: structured, unambiguous.
 *  - The text fallback matches only EXPLICIT labelled values ("Kaltmiete:",
 *    "Wohnfläche … m²", "Zimmer") — never guesses.
 *  - Anything not found stays null. Unknown is represented, never invented.
 */

export interface ParsedListingPage {
  /** True when JSON-LD supplied at least one field. */
  fromJsonLd: boolean;
  title: string | null;
  rentColdEur: number | null;
  rentWarmEur: number | null;
  rooms: number | null;
  livingAreaSqm: number | null;
  city: string | null;
  postalCode: string | null;
  availableFrom: string | null; // ISO date when the page states it
  /** ISO date: page states the offer is only available until then. */
  availableUntil: string | null;
  /** Image URLs from JSON-LD `image` (structured, strongest channel).
   *  RAW — server-side URL validation happens in the pipeline. */
  images: string[];
  /** og:image / twitter:image content of the fetched page, when present.
   *  RAW, may be relative (resolved + validated in the pipeline). */
  ogImage: string | null;
}

const JSONLD_RE = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const SCHEMA_TYPES = new Set([
  "apartment",
  "residence",
  "house",
  "placestostay",
  "hostel",
  "singleresidence",
  "singlefamilyresidence",
  "rentallisting",
  "housingcomplex",
]);

interface JsonLdNode {
  [key: string]: unknown;
}

function asRecord(value: unknown): JsonLdNode | null {
  return typeof value === "object" && value !== null ? (value as JsonLdNode) : null;
}
function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number.parseFloat(value.replace(/\s/g, "").replace(",", "."));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Collect candidate schema.org nodes (handles @graph wrappers and arrays). */
function collectNodes(payload: unknown, out: JsonLdNode[] = []): JsonLdNode[] {
  if (Array.isArray(payload)) {
    for (const item of payload) collectNodes(item, out);
    return out;
  }
  const rec = asRecord(payload);
  if (!rec) return out;
  const type = rec["@type"];
  const types = Array.isArray(type) ? type : [type];
  if (types.some((t) => typeof t === "string" && SCHEMA_TYPES.has(t.toLowerCase()))) {
    out.push(rec);
  }
  const graph = rec["@graph"];
  if (graph) collectNodes(graph, out);
  return out;
}

function extractFromJsonLd(nodes: JsonLdNode[]): Partial<ParsedListingPage> {
  const result: Partial<ParsedListingPage> = {};
  for (const node of nodes) {
    // title
    if (result.title == null) result.title = asString(node.name) ?? asString(node.headline);
    // rooms
    if (result.rooms == null) {
      result.rooms = asNumber(node.numRooms) ?? asNumber(node.rooms) ?? null;
    }
    // area
    if (result.livingAreaSqm == null) {
      const floorSize = asRecord(node.floorSize);
      const area = floorSize
        ? asNumber(floorSize.value)
        : asNumber(node.floorSize);
      result.livingAreaSqm = area;
    }
    // availability
    if (result.availableFrom == null) result.availableFrom = asString(node.availableFrom);
    if (result.availableUntil == null) result.availableUntil = asString(node.availableUntil) ?? asString(node.occupancyDateEnd);
    // location (node.address, node.location, or nested location.address —
    // prefer the record that actually carries locality/postal code)
    const addressRec = asRecord(node.address);
    const locationRec = asRecord(node.location);
    const nestedAddress = locationRec ? asRecord(locationRec.address) : null;
    const locationCandidates = [addressRec, locationRec, nestedAddress].filter(
      (x): x is JsonLdNode => x !== null,
    );
    const location =
      locationCandidates.find(
        (c) => asString(c.addressLocality) !== null || asString(c.postalCode) !== null,
      ) ?? locationCandidates[0] ?? null;
    if (location) {
      if (result.city == null) {
        result.city = asString(location.addressLocality) ?? asString(location.addressRegion) ?? null;
      }
      if (result.postalCode == null) result.postalCode = asString(location.postalCode);
    }
    // images
    const img = node.image;
    if (img && Array.isArray(img) && result.images === undefined) {
      result.images = img.filter((i): i is string => typeof i === "string").slice(0, 5);
    } else if (img && typeof img === "string" && result.images === undefined) {
      result.images = [img];
    }
    // offers / prices
    const offers = asRecord(node.offers);
    if (offers) {
      if (result.rentColdEur == null) {
        result.rentColdEur =
          asNumber(offers.price) ?? asNumber(offers.lowPrice) ?? null;
      }
      // priceSpecification may be a single record or an array (schema.org).
      const specs = Array.isArray(offers.priceSpecification)
        ? offers.priceSpecification
        : [offers.priceSpecification];
      for (const spec of specs) {
        const priceSpec = asRecord(spec);
        if (!priceSpec) continue;
        const desc = (asString(priceSpec.description) ?? "").toLowerCase();
        const price = asNumber(priceSpec.price);
        if (price != null) {
          if (desc.includes("warm")) result.rentWarmEur ??= price;
          else if (desc.includes("kalt")) result.rentColdEur ??= price;
        }
      }
      // A plain single price on a rental schema is conventionally the cold
      // rent in the German market — record it as cold, never as "verified
      // warm".
      if (result.rentColdEur == null && asNumber(offers.price) != null) {
        result.rentColdEur = asNumber(offers.price);
      }
    }
  }
  return result;
}

/**
 * Content of a <meta property|name="…"> tag (attribute order agnostic).
 * Open Graph / Twitter image metadata is PUBLIC page metadata — the page
 * itself was fetched under the fetchable-domain policy, so referencing
 * its declared image is legitimate. (Absolute or relative; validation +
 * resolution against the page URL happens in the pipeline.)
 */
function metaContent(html: string, prop: string): string | null {
  const tagRe = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, "i");
  const tag = html.match(tagRe);
  if (!tag) return null;
  const content = tag[0].match(/content=["']([^"']*)["']/i);
  const value = content ? content[1].trim() : "";
  return value === "" ? null : value;
}

function extractSocialImage(html: string): string | null {
  return (
    metaContent(html, "og:image") ??
    metaContent(html, "og:image:secure_url") ??
    metaContent(html, "twitter:image") ??
    metaContent(html, "twitter:image:src")
  );
}

// --- conservative explicit-text fallback (no JSON-LD) -----------------------

/** German number "1.234" (thousands dot) or "1234,50" — best effort. */
function parseGermanNumber(raw: string): number | null {
  const cleaned = raw.replace(/\s/g, "");
  const n = Number.parseFloat(cleaned.includes(",") ? cleaned.replace(".", "").replace(",", ".") : cleaned.replace(/\.(?=\d{3})/g, ""));
  return Number.isFinite(n) ? n : null;
}

function extractFromText(html: string): Partial<ParsedListingPage> {
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  const result: Partial<ParsedListingPage> = {};

  // \d{1,5}(?:[ .,]\d{1,3}){0,3} captures "750", "1.234", "1234,50", "1.234,56".
  const cold = text.match(/Kaltmiete\s*(?:von)?\s*[:\-–]?\s*(\d{1,5}(?:[ .,]\d{1,3}){0,3})\s*(?:€|EUR|Euro)/i);
  if (cold) result.rentColdEur = parseGermanNumber(cold[1]);
  const warm = text.match(/Warmmiete\s*(?:von)?\s*[:\-–]?\s*(\d{1,5}(?:[ .,]\d{1,3}){0,3})\s*(?:€|EUR|Euro)/i);
  if (warm) result.rentWarmEur = parseGermanNumber(warm[1]);

  const rooms = text.match(/(\d+)\s+(?:Zimmer|Zi\.?)\b/i);
  if (rooms) result.rooms = Number.parseInt(rooms[1], 10);

  const area = text.match(/(?:Wohnfl[äa]che|Gr[öo]ße)\s*(?:von)?\s*[:\-–]?\s*(\d{2,4}(?:[.,]\d{1,2})?)\s*(?:m²|qm|q\.m\.?|Quadratmeter)/i);
  if (area) result.livingAreaSqm = parseGermanNumber(area[1]);

  const titleTag = text.match(/<title[^>]*>([\s\S]{6,200}?)<\/title>/i);
  if (titleTag) result.title = titleTag[1].replace(/\s+/g, " ").trim().slice(0, 200) || null;

  return result;
}

/**
 * Extract listing fields from a fetched HTML page. Never throws on
 * malformed content — returns nulls for whatever is absent.
 */
export function parseListingPage(html: string): ParsedListingPage {
  const empty: ParsedListingPage = {
    fromJsonLd: false,
    title: null,
    rentColdEur: null,
    rentWarmEur: null,
    rooms: null,
    livingAreaSqm: null,
    city: null,
    postalCode: null,
    availableFrom: null,
    availableUntil: null,
    images: [],
    ogImage: null,
  };

  const ldBlocks = [...html.matchAll(JSONLD_RE)];
  const nodes: JsonLdNode[] = [];
  for (const block of ldBlocks) {
    try {
      collectNodes(JSON.parse(block[1]), nodes);
    } catch {
      // Malformed JSON-LD: skip this block, keep going.
    }
  }

  const fromLd = extractFromJsonLd(nodes);
  const fromText = nodes.length > 0 ? {} : extractFromText(html);

  return {
    ...empty,
    ...fromText,
    ...fromLd,
    fromJsonLd: nodes.length > 0,
    title: fromLd.title ?? fromText.title ?? null,
    rentColdEur: fromLd.rentColdEur ?? fromText.rentColdEur ?? null,
    rentWarmEur: fromLd.rentWarmEur ?? fromText.rentWarmEur ?? null,
    rooms: fromLd.rooms ?? fromText.rooms ?? null,
    livingAreaSqm: fromLd.livingAreaSqm ?? fromText.livingAreaSqm ?? null,
    city: fromLd.city ?? null,
    postalCode: fromLd.postalCode ?? null,
    availableFrom: fromLd.availableFrom ?? null,
    availableUntil: fromLd.availableUntil ?? null,
    images: fromLd.images ?? [],
    ogImage: extractSocialImage(html),
  };
}
