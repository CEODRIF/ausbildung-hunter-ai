import { describe, expect, it } from "vitest";

import { parseListingPage } from "@/lib/housing/web-search/parse-listing";

function jsonLdPage(payload: unknown, extra = ""): string {
  return `<html><head><title>Fallback Title</title></head><body>${extra}<script type="application/ld+json">${
    typeof payload === "string" ? payload : JSON.stringify(payload)
  }</script></body></html>`;
}

describe("parseListingPage — JSON-LD (schema.org)", () => {
  it("extracts all fields from an Apartment node", () => {
    const html = jsonLdPage({
      "@context": "https://schema.org",
      "@type": "Apartment",
      name: "3-Zimmer-Wohnung in Köln-Ehrenfeld",
      numRooms: 3,
      floorSize: { "@type": "QuantitativeValue", value: 72, unitCode: "MTK" },
      address: { "@type": "PostalAddress", addressLocality: "Köln", postalCode: "50823" },
      availableFrom: "2026-11-01",
      image: ["https://cdn.example/img1.jpg", "https://cdn.example/img2.jpg"],
      offers: {
        "@type": "Offer",
        price: 1150,
        priceCurrency: "EUR",
        priceSpecification: [
          { "@type": "PriceSpecification", description: "Kaltmiete", price: 1150 },
          { "@type": "PriceSpecification", description: "Warmmiete", price: 1450 },
        ],
      },
    });
    const p = parseListingPage(html);
    expect(p.fromJsonLd).toBe(true);
    expect(p.title).toBe("3-Zimmer-Wohnung in Köln-Ehrenfeld");
    expect(p.rooms).toBe(3);
    expect(p.livingAreaSqm).toBe(72);
    expect(p.city).toBe("Köln");
    expect(p.postalCode).toBe("50823");
    expect(p.availableFrom).toBe("2026-11-01");
    expect(p.images).toEqual(["https://cdn.example/img1.jpg", "https://cdn.example/img2.jpg"]);
    expect(p.rentColdEur).toBe(1150);
    expect(p.rentWarmEur).toBe(1450);
  });

  it("walks @graph wrappers and arrays", () => {
    const html = jsonLdPage({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebSite", name: "Site" },
        {
          "@type": ["PlaceToStay", "Residence"],
          headline: "WG-Zimmer Berlin",
          rooms: 1,
          location: { address: { addressLocality: "Berlin", postalCode: "10115" } },
        },
      ],
    });
    const p = parseListingPage(html);
    expect(p.fromJsonLd).toBe(true);
    expect(p.title).toBe("WG-Zimmer Berlin");
    expect(p.rooms).toBe(1);
    expect(p.city).toBe("Berlin"); // nested location.address
    expect(p.postalCode).toBe("10115");
  });

  it("accepts string prices and scalar floorSize, caps images at 5", () => {
    const html = jsonLdPage({
      "@type": "House",
      name: "Haushälfte",
      offers: { price: "850", lowPrice: null },
      floorSize: "90",
      image: ["a.jpg", "b.jpg", "c.jpg", "d.jpg", "e.jpg", "f.jpg"],
    });
    const p = parseListingPage(html);
    expect(p.rentColdEur).toBe(850);
    expect(p.livingAreaSqm).toBe(90);
    expect(p.images).toHaveLength(5);
  });

  it("maps occupancyDateEnd to availableUntil", () => {
    const html = jsonLdPage({ "@type": "Residence", name: "x", occupancyDateEnd: "2026-10-01" });
    expect(parseListingPage(html).availableUntil).toBe("2026-10-01");
  });

  it("prefers JSON-LD values over text matches", () => {
    const html = jsonLdPage(
      { "@type": "Apartment", name: "JSON-LD Title", offers: { price: 1000 } },
      "<p>Kaltmiete 750 €</p>",
    );
    const p = parseListingPage(html);
    expect(p.rentColdEur).toBe(1000);
    expect(p.title).toBe("JSON-LD Title");
  });
});

describe("parseListingPage — malformed content", () => {
  it("skips malformed JSON-LD blocks and falls back to explicit text", () => {
    const html = `<html><head><title>Gute Wohnung</title></head><body>
      <script type="application/ld+json">{broken json!!</script>
      <p>Kaltmiete: 750 €</p><p>Warmmiete von 980,50 €</p><p>3 Zimmer</p><p>Wohnfläche: 55 m²</p>
    </body></html>`;
    const p = parseListingPage(html);
    expect(p.fromJsonLd).toBe(false);
    expect(p.title).toBe("Gute Wohnung");
    expect(p.rentColdEur).toBe(750);
    expect(p.rentWarmEur).toBe(980.5);
    expect(p.rooms).toBe(3);
    expect(p.livingAreaSqm).toBe(55);
  });

  it("ignores JSON-LD without a housing schema type (uses text fallback)", () => {
    const html = jsonLdPage(
      { "@type": "Product", name: "Sofa", offers: { price: 199 } },
      "<p>Kaltmiete 600 €</p>",
    );
    const p = parseListingPage(html);
    expect(p.fromJsonLd).toBe(false);
    expect(p.title).not.toBe("Sofa");
    expect(p.rentColdEur).toBe(600);
  });

  it("returns nulls for everything absent — never invents values", () => {
    const p = parseListingPage("<html><body><p>Schönes Objekt in ruhiger Lage</p></body></html>");
    expect(p).toEqual({
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
      docTitle: null,
      depositEur: null,
      address: null,
      publishedAt: null,
      description: null,
      rentalSignal: null,
    });
  });

  it("extracts the source's own datePublished (never our verification time)", () => {
    const html = `<html><body><script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Apartment",
      datePublished: "2025-09-30",
    })}</script></body></html>`;
    const p = parseListingPage(html);
    expect(p.publishedAt).toBe("2025-09-30");
  });

  it("extracts og:description / meta description (page metadata)", () => {
    const og = parseListingPage(
      `<html><head><meta property="og:description" content="Helle 2-Zi im Zentrum"></head><body></body></html>`,
    );
    expect(og.description).toBe("Helle 2-Zi im Zentrum");
    const meta = parseListingPage(
      `<html><head><meta name="description" content="Zimmer in ruhiger WG"></head><body></body></html>`,
    );
    expect(meta.description).toBe("Zimmer in ruhiger WG");
    expect(parseListingPage("<html></html>").description).toBeNull();
  });

  it("never throws on empty input", () => {
    expect(() => parseListingPage("")).not.toThrow();
    expect(parseListingPage("").title).toBeNull();
  });
});

describe("parseListingPage — social image metadata (og/twitter)", () => {
  it("extracts og:image (attribute order agnostic)", () => {
    const html = `<html><head>
      <meta property="og:image" content="https://cdn.example.de/og/1.jpg">
    </head><body></body></html>`;
    expect(parseListingPage(html).ogImage).toBe("https://cdn.example.de/og/1.jpg");
  });

  it("extracts og:image when content comes BEFORE the property attribute", () => {
    const html = `<html><head>
      <meta content="https://cdn.example.de/og/2.jpg" property="og:image">
    </head><body></body></html>`;
    expect(parseListingPage(html).ogImage).toBe("https://cdn.example.de/og/2.jpg");
  });

  it("falls back to twitter:image, then keeps og:image's precedence", () => {
    const onlyTwitter = `<html><head><meta name="twitter:image" content="https://cdn.example.de/t.jpg"></head><body></body></html>`;
    expect(parseListingPage(onlyTwitter).ogImage).toBe("https://cdn.example.de/t.jpg");
    const both = `<html><head>
      <meta property="og:image" content="https://cdn.example.de/og.jpg">
      <meta name="twitter:image" content="https://cdn.example.de/t.jpg">
    </head><body></body></html>`;
    expect(parseListingPage(both).ogImage).toBe("https://cdn.example.de/og.jpg");
  });

  it("accepts relative og:image values (resolved later in the pipeline)", () => {
    const html = `<html><head><meta property="og:image" content="/media/wohnung-1.jpg"></head><body></body></html>`;
    expect(parseListingPage(html).ogImage).toBe("/media/wohnung-1.jpg");
  });

  it("returns null when no social image tag exists", () => {
    expect(parseListingPage("<html><head><title>x</title></head><body></body></html>").ogImage).toBeNull();
  });

  it("does not confuse a JSON-LD string that mentions og:image for a real tag", () => {
    const html = jsonLdPage(
      { "@type": "Apartment", name: "x", description: "see og:image in the meta" },
      "",
    );
    expect(parseListingPage(html).ogImage).toBeNull();
  });
});

describe("parseListingPage — German number parsing", () => {
  it("parses thousands separators and decimal commas", () => {
    const html = `<html><body>
      <p>Kaltmiete 1.234 €</p>
      <p>Warmmiete 1434,50 €</p>
      <p>Wohnfläche 80 qm</p>
    </body></html>`;
    const p = parseListingPage(html);
    expect(p.rentColdEur).toBe(1234);
    expect(p.rentWarmEur).toBe(1434.5);
    expect(p.livingAreaSqm).toBe(80);
  });

  it("extracts the deposit (Kaution) only when explicitly labelled", () => {
    const p = parseListingPage("<html><body><p>Kaution: 1.500 €</p></body></html>");
    expect(p.depositEur).toBe(1500);
    const none = parseListingPage("<html><body><p>1.500 €</p></body></html>");
    expect(none.depositEur).toBeNull();
  });

  it("does not extract unlabelled numbers", () => {
    const p = parseListingPage("<html><body><p>Preis 500 € für die Miete</p></body></html>");
    expect(p.rentColdEur).toBeNull();
    expect(p.rentWarmEur).toBeNull();
  });
});

describe("parseListingPage — extended fields (docTitle, address, rental signal)", () => {
  it("extracts the document <title> even when JSON-LD provides a different name", () => {
    const p = parseListingPage(jsonLdPage({ "@type": "Apartment", name: "JSON-LD Name" }));
    expect(p.title).toBe("JSON-LD Name");
    expect(p.docTitle).toBe("Fallback Title");
  });

  it("extracts the document <title> from the text fallback too", () => {
    const p = parseListingPage("<html><head><title>Mietwohnung Köln</title></head><body></body></html>");
    expect(p.docTitle).toBe("Mietwohnung Köln");
  });

  it("returns null docTitle when no <title>/og:title exists", () => {
    expect(parseListingPage("<html><body><p>Kaltmiete 500 €</p></body></html>").docTitle).toBeNull();
  });

  it("extracts streetAddress from JSON-LD (address), city stays the locality", () => {
    const p = parseListingPage(
      jsonLdPage({
        "@type": "Apartment",
        name: "x",
        address: { addressLocality: "Köln", postalCode: "50667", streetAddress: "Musterstraße 12" },
      }),
    );
    expect(p.city).toBe("Köln");
    expect(p.address).toBe("Musterstraße 12");
  });

  it("classifies a rental page (rental markers without sale markers)", () => {
    const p = parseListingPage(
      "<html><body><p>Kaltmiete 800 €</p><p>Warmmiete 1000 €</p><p>Kaution 1600 €</p></body></html>",
    );
    expect(p.rentalSignal).toBe("rental");
  });

  it("classifies a sale page (sale markers without rental markers)", () => {
    const p = parseListingPage("<html><body><p>Kaufpreis 350.000 €</p></body></html>");
    expect(p.rentalSignal).toBe("sale");
  });

  it("stays null when both rental and sale markers appear (ambiguous)", () => {
    const p = parseListingPage("<html><body><p>Kaufpreis 300.000 € oder Miete 1500 €</p></body></html>");
    expect(p.rentalSignal).toBeNull();
  });
});
