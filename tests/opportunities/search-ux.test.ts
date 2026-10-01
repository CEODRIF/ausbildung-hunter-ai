import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createAdminMock, baseParams, jsonResponse } =
  await import("../helpers");

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));
const { createAdminClient } = await import("@/lib/supabase/admin");

vi.mock("@/lib/auth", () => ({
  getCurrentUserAndProfile: vi.fn(),
}));
const { getCurrentUserAndProfile } = await import("@/lib/auth");

import {
  normalizeSearchParams,
  parseSearchUrlState,
  sanitizeSearchUrlState,
  serializeSearchState,
} from "@/lib/opportunities/types";

let adminMock: Awaited<ReturnType<typeof createAdminMock>>;

function authed(userId: string) {
  vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
    user: { id: userId },
    profile: { account_status: "active" },
  } as never);
}

beforeEach(() => {
  adminMock = createAdminMock();
  vi.mocked(createAdminClient).mockReturnValue(adminMock.admin as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const searchUrl = (qs: string) =>
  `http://localhost/api/opportunities/search?${qs}`;

describe("search route validation", () => {
  it("requires authentication", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
      user: null,
      profile: null,
    } as never);
    const { GET } = await import("@/app/api/opportunities/search/route");
    const response = await GET(new Request(searchUrl("goal=arbeit")));
    expect(response.status).toBe(401);
  });

  it("rejects invalid sort values", async () => {
    authed("u-1");
    const { GET } = await import("@/app/api/opportunities/search/route");
    const response = await GET(
      new Request(searchUrl("goal=arbeit&sort=bogus")),
    );
    expect(response.status).toBe(400);
  });

  it("enforces safe pagination bounds", async () => {
    authed("u-1");
    const { GET } = await import("@/app/api/opportunities/search/route");
    for (const qs of [
      "goal=arbeit&page=0",
      "goal=arbeit&page=201",
      "goal=arbeit&pageSize=51",
      "goal=arbeit&pageSize=0",
    ]) {
      const response = await GET(new Request(searchUrl(qs)));
      expect(response.status).toBe(400);
    }
  });

  it("rejects distance sorting without a location (never silent)", async () => {
    authed("u-1");
    const { GET } = await import("@/app/api/opportunities/search/route");
    const response = await GET(
      new Request(searchUrl("goal=arbeit&sort=distance")),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/location/i);
  });

  it("rejects distance_max without a location", async () => {
    authed("u-1");
    const { GET } = await import("@/app/api/opportunities/search/route");
    const response = await GET(
      new Request(searchUrl("goal=arbeit&distance_max=10")),
    );
    expect(response.status).toBe(400);
  });

  it("rejects home-office and training-type filters for Arbeit", async () => {
    authed("u-1");
    const { GET } = await import("@/app/api/opportunities/search/route");
    const homeOffice = await GET(
      new Request(searchUrl("goal=arbeit&home_office=yes")),
    );
    expect(homeOffice.status).toBe(400);
    const training = await GET(
      new Request(searchUrl("goal=arbeit&training_type=DUALES_STUDIUM")),
    );
    expect(training.status).toBe(400);
  });

  it("accepts Ausbildung-only filters for Ausbildung", async () => {
    authed("u-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ergebnisliste: [], maxErgebnisse: 0 })),
    );
    const { GET } = await import("@/app/api/opportunities/search/route");
    const response = await GET(
      new Request(
        searchUrl(
          "goal=ausbildung&training_type=DUALES_STUDIUM&home_office=yes",
        ),
      ),
    );
    expect(response.status).toBe(200);
  });

  it("supports the shareable q alias for keyword", async () => {
    authed("u-1");
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        urls.push(String(url));
        return jsonResponse({ ergebnisliste: [], maxErgebnisse: 0 });
      }),
    );
    const { GET } = await import("@/app/api/opportunities/search/route");
    const response = await GET(
      new Request(searchUrl("goal=arbeit&q=marketing+assistant")),
    );
    expect(response.status).toBe(200);
    expect(urls[0]).toContain("was=marketing+assistant");
  });

  it("never sends unsupported BA parameters for any filter combination", async () => {
    authed("u-1");
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        urls.push(String(url));
        return jsonResponse({ ergebnisliste: [], maxErgebnisse: 0 });
      }),
    );
    const { GET } = await import("@/app/api/opportunities/search/route");
    await GET(
      new Request(
        searchUrl(
          "goal=ausbildung&role=Kaufmann&company=Perzukunft&location=Berlin&freshness=4w&sort=newest&employment=full_time&training_type=AUSBILDUNG&home_office=yes&salary=1&distance_max=20",
        ),
      ),
    );
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).not.toContain("arbeitszeit=");
      expect(url).not.toContain("beruf=");
      expect(url).not.toContain("arbeitgeber=");
      expect(url).not.toContain("veroeffentlichtseit="); // 4w is server-side
    }
  });
});

describe("normalizeSearchParams (explicit, never silent)", () => {
  it("normalizes sort=match without a match request to relevance", () => {
    const normalized = normalizeSearchParams(
      baseParams({ sort: "match", match: false }),
    );
    expect(normalized.sort).toBe("relevance");
  });

  it("keeps sort=match when match is requested", () => {
    const normalized = normalizeSearchParams(
      baseParams({ sort: "match", match: true }),
    );
    expect(normalized.sort).toBe("match");
  });

  it("throws for distance sorting without a location", () => {
    expect(() =>
      normalizeSearchParams(baseParams({ sort: "distance" })),
    ).toThrow(/location/i);
  });

  it("allows distance sorting with a location", () => {
    const normalized = normalizeSearchParams(
      baseParams({ sort: "distance", location: "Berlin" }),
    );
    expect(normalized.sort).toBe("distance");
  });
});

describe("shareable URL state", () => {
  it("keeps whitelisted values and drops unknown/secret ones", () => {
    const sanitized = sanitizeSearchUrlState(
      "goal=ausbildung&q=marketing&location=Berlin&freshness=14d&sort=newest&token=secret&user_id=hacker&id=123&service_role=abc",
    );
    const params = new URLSearchParams(sanitized);
    expect(params.get("goal")).toBe("ausbildung");
    expect(params.get("q")).toBe("marketing");
    expect(params.get("location")).toBe("Berlin");
    // Legacy value mapping: 14d → 2w.
    expect(params.get("freshness")).toBe("2w");
    expect(params.get("sort")).toBe("newest");
    expect(params.has("token")).toBe(false);
    expect(params.has("user_id")).toBe(false);
    expect(params.has("id")).toBe(false);
    expect(params.has("service_role")).toBe(false);
  });

  it("maps legacy freshness values (14d→2w, 30d→4w) and salary (1→documented, 0→any)", () => {
    const twoWeeks = new URLSearchParams(
      sanitizeSearchUrlState("goal=arbeit&freshness=14d"),
    );
    expect(twoWeeks.get("freshness")).toBe("2w");
    const fourWeeks = new URLSearchParams(
      sanitizeSearchUrlState("goal=arbeit&freshness=30d"),
    );
    expect(fourWeeks.get("freshness")).toBe("4w");
    const documented = new URLSearchParams(
      sanitizeSearchUrlState("goal=arbeit&salary=1"),
    );
    expect(documented.get("salary")).toBe("documented");
    const anySalary = new URLSearchParams(
      sanitizeSearchUrlState("goal=arbeit&salary=0"),
    );
    // "any" is the default — not re-serialized.
    expect(anySalary.get("salary")).toBeNull();
  });

  it("round-trips Work place cities (curated only, deduped, invalid dropped)", () => {
    const raw = "goal=arbeit&cities=Berlin,München,Bogus,Berlin";
    const state = parseSearchUrlState(raw, "ausbildung");
    expect(state.cities).toEqual(["Berlin", "München"]);
    const serialized = serializeSearchState(state);
    expect(serialized).toContain("cities=Berlin%2CM%C3%BCnchen");
    // A normalized city selection serializes as cities, not as legacy location.
    expect(serialized).not.toContain("location=");
  });

  it("round-trips beginn (now + real months) and the contact-email filter", () => {
    const state = parseSearchUrlState(
      "goal=ausbildung&beginn=2026-11&email=available",
      "arbeit",
    );
    expect(state.beginn).toBe("2026-11");
    expect(state.contact_email).toBe("available");
    const again = parseSearchUrlState(serializeSearchState(state), "arbeit");
    expect(again).toEqual(state);
    const nowState = parseSearchUrlState("goal=arbeit&beginn=now", "ausbildung");
    expect(nowState.beginn).toBe("now");
  });

  it("drops invalid beginn months (schema-validated)", () => {
    const state = parseSearchUrlState("goal=arbeit&beginn=2026-13", "arbeit");
    expect(state.beginn).toBe("any");
  });

  it("drops the whole state when goal is missing or invalid", () => {
    expect(sanitizeSearchUrlState("location=Berlin")).toBe("");
    expect(sanitizeSearchUrlState("goal=hacking&location=Berlin")).toBe("");
  });

  it("drops invalid individual values", () => {
    const sanitized = sanitizeSearchUrlState(
      "goal=arbeit&freshness=someday&sort=chaos&radius=99999",
    );
    // goal is valid, but the invalid values fail the schema → state dropped.
    expect(sanitized).toBe("");
  });

  it("round-trips through parse + serialize without leaking defaults", () => {
    const raw =
      "goal=ausbildung&q=mechanik&location=Hamburg&sort=newest&salary=1&page=2";
    const state = parseSearchUrlState(raw, "arbeit");
    expect(state.goal).toBe("ausbildung");
    expect(state.keyword).toBe("mechanik");
    expect(state.location).toBe("Hamburg");
    expect(state.sort).toBe("newest");
    expect(state.salary).toBe("documented"); // legacy salary=1 mapped
    expect(state.page).toBe(2);
    expect(state.match).toBe(true); // UI default when absent
    const serialized = serializeSearchState(state);
    const again = parseSearchUrlState(serialized, "arbeit");
    expect(again).toEqual(state);
  });

  it("falls back to defaults for an empty or invalid state", () => {
    const state = parseSearchUrlState("", "ausbildung");
    expect(state.goal).toBe("ausbildung");
    expect(state.keyword).toBe("");
    expect(state.freshness).toBe("any");
    expect(state.sort).toBe("relevance");
    expect(state.page).toBe(1);
    expect(state.radius).toBeNull();
    expect(state.distance_max).toBeNull();
    const invalid = parseSearchUrlState("goal=xxx&radius=-5", "arbeit");
    expect(invalid.goal).toBe("arbeit");
  });
});
