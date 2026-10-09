import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";
import { lookup } from "node:dns/promises";

// Offline: all DNS resolution is mocked — no real lookups in tests.
// `fetchPublicPage`/`guardedFetch` always call lookup with { all: true }, so
// the mock is typed against that overload (same pattern as
// tests/security/ssrf-redirect.test.ts).
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn<
    (hostname: string, options?: { all: true }) => Promise<
      Array<{ address: string; family: number }>
    >
  >(),
}));

type LookupAll = (
  hostname: string,
  options?: { all: true },
) => Promise<Array<{ address: string; family: number }>>;
const dnsLookup = vi.mocked(lookup) as unknown as Mock<LookupAll>;

import {
  assertFetchableUrl,
  guardedFetch,
  hostBelongsTo,
  isUnsafeIp,
  UnsafeUrlError,
} from "@/lib/housing/web-search/url-guard";
import type { AllowedDomain } from "@/lib/housing/web-search/config";

const OPEN_NRW: AllowedDomain = {
  domain: "open.nrw",
  label: "Open.NRW",
  policy: "fetchable",
  rationale: "test",
};
const PUBLIC_IP = "93.184.216.34";

/** Injected into assertFetchableUrl — returns the RAW IP strings (its contract). */
const publicLookup = vi.fn(async () => [PUBLIC_IP]);

beforeEach(() => {
  vi.clearAllMocks();
  dnsLookup.mockReset();
  dnsLookup.mockResolvedValue([{ address: PUBLIC_IP, family: 4 }]);
});

describe("isUnsafeIp", () => {
  it.each([
    ["0.0.0.0", true],
    ["10.1.2.3", true],
    ["127.0.0.1", true],
    ["169.254.169.254", true], // cloud metadata endpoint
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["100.64.0.1", true], // CGNAT
    ["192.0.2.1", true], // TEST-NET-1
    ["198.18.0.1", true],
    ["192.168.0.1", true],
    ["224.0.0.1", true], // multicast
    ["255.255.255.255", true],
    ["::", true],
    ["::1", true],
    ["fc00::1", true],
    ["fd12::1", true],
    ["fe80::1", true],
    ["::ffff:127.0.0.1", true], // IPv4-mapped loopback
    ["1.1.1.1", false],
    ["8.8.8.8", false],
    ["172.32.0.1", false], // outside 172.16/12
    ["100.128.0.1", false], // outside CGNAT
    ["192.167.255.255", false],
    ["2606:4700:4700::1111", false],
    ["::ffff:8.8.8.8", false],
    ["not-an-ip", true],
  ])("isUnsafeIp(%s) = %s", (ip, expected) => {
    expect(isUnsafeIp(ip)).toBe(expected);
  });
});

describe("hostBelongsTo", () => {
  it("accepts the exact domain, www-prefixed, and subdomains", () => {
    expect(hostBelongsTo("open.nrw", OPEN_NRW)).toBe(true);
    expect(hostBelongsTo("www.open.nrw", OPEN_NRW)).toBe(true);
    expect(hostBelongsTo("data.open.nrw", OPEN_NRW)).toBe(true);
    expect(hostBelongsTo("OPEN.NRW", OPEN_NRW)).toBe(true);
  });

  it("rejects lookalikes (no dot-boundary bypass)", () => {
    expect(hostBelongsTo("notopen.nrw", OPEN_NRW)).toBe(false);
    expect(hostBelongsTo("open.nrw.evil.example", OPEN_NRW)).toBe(false);
    expect(hostBelongsTo("evilopen.nrw", OPEN_NRW)).toBe(false);
  });
});

describe("assertFetchableUrl", () => {
  it("rejects non-https protocols", async () => {
    await expect(
      assertFetchableUrl("http://open.nrw/dataset/x", OPEN_NRW, publicLookup),
    ).rejects.toThrow(UnsafeUrlError);
  });

  it("rejects credentials in the URL", async () => {
    await expect(
      assertFetchableUrl("https://user:pass@open.nrw/dataset/x", OPEN_NRW, publicLookup),
    ).rejects.toThrow(UnsafeUrlError);
  });

  it("rejects hosts outside the allowlisted domain", async () => {
    await expect(
      assertFetchableUrl("https://evil.example/dataset/x", OPEN_NRW, publicLookup),
    ).rejects.toThrow(/allowlist/);
  });

  it("rejects unparseable URLs", async () => {
    await expect(assertFetchableUrl("not a url", OPEN_NRW, publicLookup)).rejects.toThrow(
      UnsafeUrlError,
    );
  });

  it("rejects when DNS resolves to a private address (SSRF)", async () => {
    const evilLookup = vi.fn(async () => ["192.168.1.10"]);
    await expect(
      assertFetchableUrl("https://open.nrw/dataset/x", OPEN_NRW, evilLookup),
    ).rejects.toThrow(/unsafe address/);
  });

  it("rejects when DNS yields no results", async () => {
    const emptyLookup = vi.fn(async () => []);
    await expect(
      assertFetchableUrl("https://open.nrw/dataset/x", OPEN_NRW, emptyLookup),
    ).rejects.toThrow(/no DNS/);
  });

  it("accepts a public https URL on an allowlisted host", async () => {
    const url = await assertFetchableUrl("https://open.nrw/dataset/x", OPEN_NRW, publicLookup);
    expect(url.hostname).toBe("open.nrw");
    expect(publicLookup).toHaveBeenCalledWith("open.nrw");
  });
});

function htmlResponse(body: string, init?: ResponseInit) {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    ...init,
  });
}

describe("guardedFetch", () => {
  it("fetches an allowlisted page and returns text", async () => {
    // Signature mirrors fetch; args are read back via mock.calls below.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      htmlResponse("<html><body>hi</body></html>"),
    );
    const page = await guardedFetch("https://open.nrw/dataset/x", OPEN_NRW, { fetchImpl });
    expect(page.text).toBe("<html><body>hi</body></html>");
    expect(page.finalUrl).toBe("https://open.nrw/dataset/x");
    expect(page.truncated).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({
      "user-agent": expect.stringContaining("AusbildungsWegBot"),
    });
  });

  it("re-validates every manual redirect hop (blocks redirect to internal target)", async () => {
    const fetchImpl = (vi.fn(async (_url: RequestInfo | URL) => {
      if (String(_url).endsWith("/dataset/x")) {
        return new Response(null, {
          status: 301,
          headers: { location: "https://10.0.0.1/internal" },
        });
      }
      return htmlResponse("should never be reached");
    })) as unknown as typeof fetch;
    await expect(
      guardedFetch("https://open.nrw/dataset/x", OPEN_NRW, { fetchImpl }),
    ).rejects.toThrow(UnsafeUrlError);
    // Only the first hop was fetched; the internal target was never requested.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after max redirect hops", async () => {
    let hop = 0;
    const fetchImpl = vi.fn(async () => {
      hop += 1;
      return new Response(null, {
        status: 302,
        headers: { location: `https://open.nrw/dataset/hop${hop + 1}` },
      });
    });
    await expect(
      guardedFetch("https://open.nrw/dataset/hop1", OPEN_NRW, { fetchImpl }),
    ).rejects.toThrow(/too many redirects/);
    expect(hop).toBe(4); // original + 3 allowed hops, 4th redirect rejected
  });

  it("rejects redirect chains leaving the allowlisted host", async () => {
    const fetchImpl = (vi.fn(async (_url: RequestInfo | URL) => {
      const u = String(_url);
      if (u.endsWith("/dataset/x")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://www.immobilienscout24.de/expose/123456789" },
        });
      }
      return htmlResponse("nope");
    })) as unknown as typeof fetch;
    // open.nrw host cannot be redirected into immowelt/is24 (different domain entry).
    await expect(
      guardedFetch("https://open.nrw/dataset/x", OPEN_NRW, { fetchImpl }),
    ).rejects.toThrow(UnsafeUrlError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("surfaces non-OK statuses as a controlled error", async () => {
    const fetchImpl = vi.fn(async () => htmlResponse("nope", { status: 404 }));
    await expect(
      guardedFetch("https://open.nrw/dataset/x", OPEN_NRW, { fetchImpl }),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("rejects non-HTML/JSON content types", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("binary", { status: 200, headers: { "content-type": "application/pdf" } }),
    );
    await expect(
      guardedFetch("https://open.nrw/dataset/x", OPEN_NRW, { fetchImpl }),
    ).rejects.toThrow(/HTML\/JSON/);
  });

  it("truncates oversized bodies at the byte cap", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(65); // "A"
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 10; i += 1) controller.enqueue(chunk);
        controller.close();
      },
    });
    const fetchImpl = vi.fn(
      async () => new Response(stream, { status: 200, headers: { "content-type": "text/html" } }),
    );
    const page = await guardedFetch("https://open.nrw/dataset/x", OPEN_NRW, { fetchImpl });
    expect(page.truncated).toBe(true);
    expect(page.text.length).toBeLessThanOrEqual(64 * 1024 * 8); // well under 512KB + slack
    expect(page.text.length).toBeGreaterThan(64 * 1024 * 5);
  });

  it("rejects DNS failures with UnsafeUrlError (fail closed, no raw network throw)", async () => {
    dnsLookup.mockRejectedValueOnce(new Error("ENOTFOUND"));
    const fetchImpl = vi.fn();
    await expect(
      guardedFetch("https://open.nrw/dataset/x", OPEN_NRW, { fetchImpl: fetchImpl as never }),
    ).rejects.toThrow(UnsafeUrlError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
