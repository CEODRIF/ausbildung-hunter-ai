import { describe, expect, it } from "vitest";

import {
  MAX_LISTING_IMAGES,
  sanitizeImageUrls,
  validateImageUrl,
} from "@/lib/housing/web-search/image-safety";

const PAGE = "https://open.nrw/dataset/mieten-koeln";

describe("validateImageUrl — scheme & syntax", () => {
  it("accepts a plain https absolute URL (fragment dropped)", () => {
    expect(validateImageUrl("https://cdn.example.de/img/1.jpg", null)).toBe(
      "https://cdn.example.de/img/1.jpg",
    );
    expect(validateImageUrl("https://cdn.example.de/img/1.jpg#top", null)).toBe(
      "https://cdn.example.de/img/1.jpg",
    );
  });

  it("keeps query params (CDN signed URLs need them)", () => {
    expect(validateImageUrl("https://cdn.example.de/i.jpg?w=800&sig=ab", null)).toBe(
      "https://cdn.example.de/i.jpg?w=800&sig=ab",
    );
  });

  it.each([
    "http://cdn.example.de/img.jpg", // mixed content on an https app
    "data:image/png;base64,AAAA",
    "blob:https://cdn.example.de/uuid",
    "javascript:alert(1)",
    "ftp://cdn.example.de/img.jpg",
    "not a url",
    "",
    "   ",
  ])("rejects %s", (raw) => {
    expect(validateImageUrl(raw, null)).toBeNull();
  });

  it("rejects non-string input", () => {
    expect(validateImageUrl(null, null)).toBeNull();
    expect(validateImageUrl(undefined, null)).toBeNull();
    expect(validateImageUrl(42, null)).toBeNull();
    expect(validateImageUrl({ url: "https://x.de/a.jpg" }, null)).toBeNull();
  });

  it("rejects credentials in the URL", () => {
    expect(validateImageUrl("https://user:pass@cdn.example.de/a.jpg", null)).toBeNull();
    expect(validateImageUrl("https://user@cdn.example.de/a.jpg", null)).toBeNull();
  });

  it("rejects oversized URLs and control characters", () => {
    expect(validateImageUrl(`https://cdn.example.de/${"a".repeat(3000)}.jpg`, null)).toBeNull();
    expect(validateImageUrl("https://cdn.example.de/a\nb.jpg", null)).toBeNull();
    expect(validateImageUrl("https://cdn.example.de/a\x00b.jpg", null)).toBeNull();
  });
});

describe("validateImageUrl — host safety (SSRF-adjacent)", () => {
  it.each([
    "https://10.0.0.8/img.jpg",
    "https://192.168.1.5/img.jpg",
    "https://169.254.169.254/latest/meta-data/", // cloud metadata endpoint
    "https://127.0.0.1:8080/img.jpg",
    "https://172.16.0.1/img.jpg",
    "https://100.64.0.1/img.jpg", // CGNAT
    "https://[::1]/img.jpg",
    "https://[fd12:3456::1]/img.jpg", // unique local
    "https://[fe80::1]/img.jpg", // link-local
  ])("rejects private/reserved IP-literal host %s", (raw) => {
    expect(validateImageUrl(raw, null)).toBeNull();
  });

  it("accepts a PUBLIC IP-literal host", () => {
    expect(validateImageUrl("https://93.184.216.34/img.jpg", null)).toBe(
      "https://93.184.216.34/img.jpg",
    );
  });

  it.each([
    "https://localhost/img.jpg",
    "https://db.internal/img.jpg",
    "https://nas.local/img.jpg",
  ])("rejects non-public hostname %s", (raw) => {
    expect(validateImageUrl(raw, null)).toBeNull();
  });
});

describe("validateImageUrl — relative references", () => {
  it("resolves a root-relative URL against the page (og:image='/media/1.jpg')", () => {
    expect(validateImageUrl("/media/wohnung-1.jpg", PAGE)).toBe(
      "https://open.nrw/media/wohnung-1.jpg",
    );
  });

  it("resolves a path-relative URL against the page directory", () => {
    expect(validateImageUrl("images/1.jpg", "https://open.nrw/dataset/mieten")).toBe(
      "https://open.nrw/dataset/images/1.jpg",
    );
  });

  it("rejects a relative reference without a base (provider metadata is absolute)", () => {
    expect(validateImageUrl("/media/1.jpg", null)).toBeNull();
    expect(validateImageUrl("images/1.jpg", null)).toBeNull();
  });

  it("a relative reference resolving to a non-https base is rejected", () => {
    expect(validateImageUrl("/media/1.jpg", "http://insecure.example.de/page")).toBeNull();
  });
});

describe("sanitizeImageUrls — batch behaviour", () => {
  it("keeps order, drops invalid entries", () => {
    expect(
      sanitizeImageUrls(
        [
          "https://cdn.example.de/1.jpg",
          "http://cdn.example.de/2.jpg", // rejected
          "data:image/png;base64,xx", // rejected
          "https://cdn.example.de/3.jpg",
        ],
        PAGE,
      ),
    ).toEqual(["https://cdn.example.de/1.jpg", "https://cdn.example.de/3.jpg"]);
  });

  it("dedupes (case-insensitive host normalization via URL canonicalization)", () => {
    expect(
      sanitizeImageUrls(["https://cdn.example.de/1.jpg", "https://cdn.example.de/1.jpg#x"], PAGE),
    ).toEqual(["https://cdn.example.de/1.jpg"]);
  });

  it(`caps at ${MAX_LISTING_IMAGES} URLs`, () => {
    const many = Array.from({ length: 10 }, (_, i) => `https://cdn.example.de/${i}.jpg`);
    expect(sanitizeImageUrls(many, PAGE)).toHaveLength(MAX_LISTING_IMAGES);
  });

  it("never throws on malformed input (non-strings dropped, relative refs need a base)", () => {
    expect(sanitizeImageUrls(null, PAGE)).toEqual([]);
    expect(sanitizeImageUrls("https://cdn.example.de/1.jpg", PAGE)).toEqual([]);
    expect(
      sanitizeImageUrls([null, 42, {}, "https://ok.example.de/1.jpg"], PAGE),
    ).toEqual(["https://ok.example.de/1.jpg"]);
    // No base: relative/word references are rejected, absolutes pass.
    expect(sanitizeImageUrls(["bad", "https://ok.example.de/1.jpg"], null)).toEqual([
      "https://ok.example.de/1.jpg",
    ]);
  });

  it("resolves page-relative references like a browser (same host as the fetched page)", () => {
    // HTML semantics: an <img src="x"> / og:image="x" on the page resolves
    // against the page URL. The result stays on the already-validated host,
    // so this is safe; a dead reference simply 404s in the browser and the
    // UI falls back to the placeholder.
    expect(sanitizeImageUrls(["photos/1.jpg"], "https://open.nrw/dataset/mieten")).toEqual([
      "https://open.nrw/dataset/photos/1.jpg",
    ]);
  });
});
