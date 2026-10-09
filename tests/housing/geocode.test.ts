import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { geocodePlace, clearGeocodeCache, geocodeUserAgent } = await import(
  "@/lib/housing/geocode"
);

/** Record every call, answer with a canned handler. Fully offline. */
function fakeFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  clearGeocodeCache(); // module-level cache + request spacing is shared state
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("geocodePlace — parsing & fail-open", () => {
  it("parses a valid Nominatim jsonv2 response", async () => {
    const { impl } = fakeFetch(() =>
      okJson([{ lat: "50.9375", lon: "6.9603", display_name: "Köln, Deutschland" }]),
    );
    const r = await geocodePlace("Köln", { fetchImpl: impl });
    expect(r).toEqual({ lat: 50.9375, lon: 6.9603, label: "Köln, Deutschland" });
  });

  it("queries Nominatim with jsonv2, Germany scope, and the encoded query", async () => {
    const { impl, calls } = fakeFetch(() => okJson([]));
    await geocodePlace("Köln", { fetchImpl: impl });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("nominatim.openstreetmap.org/search");
    expect(calls[0].url).toContain("format=jsonv2");
    expect(calls[0].url).toContain("countrycodes=de");
    expect(calls[0].url).toContain(`q=${encodeURIComponent("Köln")}`);
  });

  it("returns null when the network fails (fail-open, never throws)", async () => {
    const impl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await geocodePlace("Nowhere", { fetchImpl: impl })).toBeNull();
  });

  it("returns null on non-200", async () => {
    const { impl } = fakeFetch(() => new Response("nope", { status: 503 }));
    expect(await geocodePlace("Nowhere", { fetchImpl: impl })).toBeNull();
  });

  it("returns null on empty results or malformed coordinates", async () => {
    const empty = fakeFetch(() => okJson([]));
    expect(await geocodePlace("Nowhere", { fetchImpl: empty.impl })).toBeNull();

    const bad = fakeFetch(() =>
      okJson([{ lat: "not-a-number", lon: "also-not", display_name: "x" }]),
    );
    expect(await geocodePlace("Nowhere2", { fetchImpl: bad.impl })).toBeNull();
  });

  it("returns null (without fetching) for a blank query", async () => {
    const { impl, calls } = fakeFetch(() => okJson([]));
    expect(await geocodePlace("   ", { fetchImpl: impl })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("times out a hanging request (5 s) and fails open", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T12:00:00.000Z"));
    const impl = ((
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const p = geocodePlace("Hanging", { fetchImpl: impl });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toBeNull();
  });
});

describe("geocodePlace — Nominatim usage policy (cache + 1 req/s)", () => {
  it("caches successful results: the same city is fetched only once", async () => {
    const { impl, calls } = fakeFetch(() =>
      okJson([{ lat: "50.94", lon: "6.96", display_name: "Köln" }]),
    );
    const a = await geocodePlace("Köln", { fetchImpl: impl });
    const b = await geocodePlace(" köln ", { fetchImpl: impl }); // trimmed + case-folded
    expect(a).toEqual(b);
    expect(calls).toHaveLength(1);
  });

  it("caches NULL results too (an unresolvable city never hammers the API)", async () => {
    const { impl, calls } = fakeFetch(() => okJson([]));
    expect(await geocodePlace("Unresolvable", { fetchImpl: impl })).toBeNull();
    expect(await geocodePlace("Unresolvable", { fetchImpl: impl })).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("spaces successive requests by at least 1 second (even back-to-back)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T12:00:00.000Z"));
    const { impl, calls } = fakeFetch(() => okJson([]));
    // Issue both in the same tick — the slot must still serialize them.
    const p1 = geocodePlace("stadt a", { fetchImpl: impl });
    const p2 = geocodePlace("stadt b", { fetchImpl: impl });
    await vi.runAllTimersAsync();
    expect(await p1).toBeNull();
    expect(await p2).toBeNull();
    expect(calls).toHaveLength(2);
    // The wall clock advanced by ≥1 s before the second request was served.
    expect(Date.now() - new Date("2026-10-09T12:00:00.000Z").getTime()).toBeGreaterThanOrEqual(
      1000,
    );
  });

  it("LRU-evicts the oldest entry beyond 500 cached keys", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T12:00:00.000Z"));
    const { impl, calls } = fakeFetch(() => okJson([]));
    for (let i = 0; i < 501; i++) {
      const p = geocodePlace(`lru-${i}`, { fetchImpl: impl });
      await vi.advanceTimersByTimeAsync(1000);
      expect(await p).toBeNull();
    }
    expect(calls).toHaveLength(501);

    // lru-0 was evicted → a re-request goes out to the network again.
    const p0 = geocodePlace("lru-0", { fetchImpl: impl });
    await vi.advanceTimersByTimeAsync(1000);
    await p0;
    expect(calls).toHaveLength(502);

    // lru-500 is still cached → no new request.
    const p500 = geocodePlace("lru-500", { fetchImpl: impl });
    await vi.advanceTimersByTimeAsync(1000);
    await p500;
    expect(calls).toHaveLength(502);
  });

  it("clearGeocodeCache drops entries and resets request spacing", async () => {
    const { impl, calls } = fakeFetch(() => okJson([]));
    await geocodePlace("wipe-me", { fetchImpl: impl });
    clearGeocodeCache();
    const p = geocodePlace("wipe-me", { fetchImpl: impl });
    await p;
    expect(calls).toHaveLength(2); // re-fetched after the wipe (spacing also reset)
  });
});

describe("geocodeUserAgent — policy-compliant identity", () => {
  it("defaults to the public app URL", () => {
    vi.stubEnv("APP_URL", "");
    expect(geocodeUserAgent()).toContain("ausbildungsweg.net");
    expect(geocodeUserAgent()).toContain("AusbildungsWeg");
  });

  it("prefers APP_URL when set", () => {
    vi.stubEnv("APP_URL", "https://staging.example.org");
    expect(geocodeUserAgent()).toContain("https://staging.example.org");
  });

  it("is actually sent as the User-Agent header", async () => {
    const { impl, calls } = fakeFetch(() => okJson([]));
    await geocodePlace("Köln", { fetchImpl: impl });
    const headers = calls[0].init?.headers as Record<string, string> | undefined;
    expect(headers?.["User-Agent"]).toContain("AusbildungsWeg");
  });
});
