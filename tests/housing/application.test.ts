import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createAdminMock } = await import("../helpers");

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
const { createAdminClient } = await import("@/lib/supabase/admin");

const { mockGenerate } = vi.hoisted(() => ({ mockGenerate: vi.fn() }));
vi.mock("@/lib/ai-service", () => ({
  provider: () => ({ generateText: mockGenerate }),
}));

const {
  fallbackApplicationDraft,
  generateApplicationDraft,
  createApplication,
  listApplications,
  updateApplicationStatus,
} = await import("@/lib/housing/application");
const { normalizeListing } = await import("@/lib/housing/providers");

/**
 * A live-style listing (the demo fixtures were removed 2026-10-10). The
 * application lib functions accept a listing object — their contract is
 * source-agnostic, so an inline normalized listing is the test data.
 */
const listing = normalizeListing({
  provider: "example-licensed-provider",
  source_id: "src-1",
  title: "2-Zimmer-Wohnung in Köln-Ehrenfeld",
  listing_url: "https://immobilienscout24.de/expose/123456789",
  city: "Köln",
  rent_warm_eur: 850,
  data_status: "live",
});

const appRow = {
  id: "app-1",
  user_id: "user-1",
  listing_ref: {
    provider: listing.provider,
    source_id: listing.source_id,
    title: listing.title,
    url: listing.listing_url,
  },
  title: listing.title,
  message_draft: "Draft text",
  status: "prepared",
  timeline: [{ status: "prepared", at: "2026-10-09T00:00:00.000Z" }],
  created_at: "2026-10-09T00:00:00.000Z",
  updated_at: "2026-10-09T00:00:00.000Z",
};

let adminMock: Awaited<ReturnType<typeof createAdminMock>>;

beforeEach(() => {
  adminMock = createAdminMock({
    singleData: (table) => (table === "housing_applications" ? appRow : null),
    maybeSingleData: (table) => (table === "housing_applications" ? appRow : null),
  });
  vi.mocked(createAdminClient).mockReturnValue(adminMock.admin as never);
  mockGenerate.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("application draft generation", () => {
  it("the deterministic fallback contains the applicant + listing facts", () => {
    const draft = fallbackApplicationDraft(listing, {
      firstName: "Max",
      lastName: "Mustermann",
      occupation: "Auszubildender",
      moveInDate: "2026-11-01",
      note: "Ich bin zuverlässig.",
    });
    expect(draft).toContain("Max Mustermann");
    expect(draft).toContain(listing.title);
    expect(draft).toContain("Köln");
    expect(draft).toContain("2026-11-01");
    expect(draft).toContain("Ich bin zuverlässig.");
  });

  it("generateApplicationDraft uses the AI when available", async () => {
    mockGenerate.mockResolvedValue("Sehr geehrte Damen und Herren, ...");
    const { text, ai_assisted } = await generateApplicationDraft(listing, {
      firstName: "Max",
      lastName: "Mustermann",
      occupation: null,
      moveInDate: null,
      note: null,
    });
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(ai_assisted).toBe(true);
    expect(text).toBe("Sehr geehrte Damen und Herren, ...");
  });

  it("falls back to the deterministic draft (ai_assisted=false) when the AI fails", async () => {
    mockGenerate.mockRejectedValue(new Error("AI down"));
    const { text, ai_assisted } = await generateApplicationDraft(listing, {
      firstName: "Max",
      lastName: "Mustermann",
      occupation: null,
      moveInDate: null,
      note: null,
    });
    expect(ai_assisted).toBe(false);
    expect(text).toContain("Max Mustermann");
  });
});

describe("application persistence (server-derived, user-scoped)", () => {
  it("createApplication writes user_id from the session, status prepared, a 1-entry timeline", async () => {
    const row = await createApplication("user-1", listing, "Draft text", listing.title);
    expect(row.id).toBe("app-1");
    const insert = adminMock.calls.find(
      (c) => c.table === "housing_applications" && c.op === "insert",
    );
    expect(insert).toBeDefined();
    const payload = insert?.args[0] as Record<string, unknown>;
    expect(payload.user_id).toBe("user-1");
    expect(payload.status).toBe("prepared");
    expect((payload.timeline as unknown[]).length).toBe(1);
    expect(payload.listing_ref).toMatchObject({
      provider: listing.provider,
      source_id: listing.source_id,
    });
  });

  it("listApplications is scoped to the authenticated user", async () => {
    await listApplications("user-1");
    const userScope = adminMock.calls.find(
      (c) =>
        c.table === "housing_applications" && c.op === "eq" && c.args[0] === "user_id",
    );
    expect(userScope?.args[1]).toBe("user-1");
  });

  it("updateApplicationStatus appends to the timeline and scopes to the user", async () => {
    await updateApplicationStatus("user-1", "app-1", "contacted");
    const update = adminMock.calls.find(
      (c) => c.table === "housing_applications" && c.op === "update",
    );
    expect(update).toBeDefined();
    const payload = update?.args[0] as Record<string, unknown>;
    expect(payload.status).toBe("contacted");
    const timeline = payload.timeline as Array<{ status: string }>;
    expect(timeline.map((t) => t.status)).toEqual(["prepared", "contacted"]);
    const userScope = adminMock.calls.find(
      (c) =>
        c.table === "housing_applications" && c.op === "eq" && c.args[0] === "user_id",
    );
    expect(userScope?.args[1]).toBe("user-1");
  });
});
