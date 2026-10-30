/**
 * AUTO BEWERB — /api/auto-bewerb/profile-photo route contract.
 *
 * The route is the ONLY way a browser ever touches the photo: same-origin,
 * session-cookie-protected requests. Ownership always comes from the
 * authenticated session (never the body/query), uploads are rate-limited,
 * engine error codes map to honest HTTP statuses, and the GET response
 * streams the OWNER's own bytes with no-store (the private bucket is never
 * exposed — no signed URLs, no public read).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkRateLimit,
  tooManyRequests,
} from "@/lib/rate-limit";
import {
  deleteAutoBewerbProfilePhoto,
  getAutoBewerbProfilePhotoRef,
  resolveAutoBewerbPhotoDataUrl,
  uploadAutoBewerbProfilePhoto,
} from "@/lib/auto-bewerb/engine";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auto-bewerb/engine", () => ({
  uploadAutoBewerbProfilePhoto: vi.fn(),
  deleteAutoBewerbProfilePhoto: vi.fn(),
  getAutoBewerbProfilePhotoRef: vi.fn(),
  resolveAutoBewerbPhotoDataUrl: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitHeaders: (r: { limit: number; count: number }) => ({
    "x-ratelimit-limit": String(r.limit),
    "x-ratelimit-remaining": String(r.limit - r.count),
  }),
  tooManyRequests: vi.fn(),
}));

import { DELETE, GET, POST } from "@/app/api/auto-bewerb/profile-photo/route";

const USER = { id: "11111111-1111-4111-8111-111111111111", email: "a@example.de" };
const BASE = "http://localhost/api/auto-bewerb/profile-photo";

const TINY_PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const TINY_PNG_URL = `data:image/png;base64,${TINY_PNG_BYTES.toString("base64")}`;

function mockAuth(user: { id: string; email: string } | null) {
  (createClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    auth: { getUser: async () => ({ data: { user } }) },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth(USER);
  (checkRateLimit as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    allowed: true,
    count: 1,
    limit: 30,
    retryAfterSeconds: 0,
  });
});

describe("auth — ownership comes from the session, never the request", () => {
  it("rejects unauthenticated GET / POST / DELETE with 401", async () => {
    mockAuth(null);
    expect((await GET(new Request(BASE))).status).toBe(401);
    expect((await POST(new Request(BASE, { method: "POST" }))).status).toBe(401);
    // DELETE() is request-agnostic: ownership comes from the session only.
    expect((await DELETE()).status).toBe(401);
  });
});

describe("POST — upload", () => {
  async function postFile(bytes: Uint8Array<ArrayBuffer>, name = "foto.png", type = "image/png") {
    const form = new FormData();
    form.append("file", new File([bytes], name, { type }));
    return POST(new Request(BASE, { method: "POST", body: form }));
  }

  it("returns the frozen reference on success", async () => {
    (uploadAutoBewerbProfilePhoto as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      value: { ref: "abphoto:v1:" + "a".repeat(64) + ":png", hash: "a".repeat(64), mime: "image/png", sizeBytes: 100 },
    });
    const res = await postFile(TINY_PNG_BYTES);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body.ref)).toMatch(/^abphoto:v1:[0-9a-f]{64}:png$/);
    // The engine is called with the SESSION user id.
    expect(uploadAutoBewerbProfilePhoto).toHaveBeenCalledWith(USER.id, expect.any(Buffer));
  });

  it("maps engine error codes to honest HTTP statuses", async () => {
    const cases: Array<[string, number]> = [
      ["schema_pending", 503],
      ["invalid_file_type", 415],
      ["file_too_large", 413],
      ["storage_error", 502],
    ];
    for (const [code, status] of cases) {
      vi.clearAllMocks();
      mockAuth(USER);
      (uploadAutoBewerbProfilePhoto as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        code,
        message: "x",
      });
      const res = await postFile(TINY_PNG_BYTES);
      expect(res.status, code).toBe(status);
    }
  });

  it("rejects a request without a file", async () => {
    // No explicit content-type: undici derives the multipart boundary from
    // the FormData body itself (a hand-set boundary would be unparseable).
    const res = await POST(new Request(BASE, { method: "POST", body: new FormData() }));
    expect(res.status).toBe(400);
  });

  it("honors the upload rate limit (429)", async () => {
    (checkRateLimit as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      allowed: false,
      count: 31,
      limit: 30,
      retryAfterSeconds: 30,
    });
    (tooManyRequests as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ status: 429, json: async () => ({}) });
    const res = await postFile(TINY_PNG_BYTES);
    expect(res).toMatchObject({ status: 429 });
    // The limiter is keyed by the session user id + the shared upload scope.
    expect(checkRateLimit).toHaveBeenCalledWith("ai_upload", USER.id);
    expect(uploadAutoBewerbProfilePhoto).not.toHaveBeenCalled();
  });
});

describe("GET — owner-scoped download (current photo or frozen ref)", () => {
  const CURRENT_REF = `abphoto:v1:${"a".repeat(64)}:png`;

  it("CURRENT photo (no ?ref): resolves the session user's DB row to a token, then streams the OWNER's bytes", async () => {
    // THE regression: without this wiring the route resolved a null ref
    // and answered 404 no_photo for every uploaded photo (broken <img> in
    // Step 1).
    (getAutoBewerbProfilePhotoRef as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(CURRENT_REF);
    (resolveAutoBewerbPhotoDataUrl as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(TINY_PNG_URL);
    const res = await GET(new Request(BASE));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await res.arrayBuffer()).equals(TINY_PNG_BYTES)).toBe(true);
    // The row lookup is scoped to the SESSION user id, and the resolver
    // receives the CURRENT token (never a client-supplied one).
    expect(getAutoBewerbProfilePhotoRef).toHaveBeenCalledWith(USER.id);
    expect(resolveAutoBewerbPhotoDataUrl).toHaveBeenCalledWith(USER.id, CURRENT_REF);
  });

  it("returns 404 no_photo when the candidate has no current photo (no ?ref)", async () => {
    (getAutoBewerbProfilePhotoRef as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (resolveAutoBewerbPhotoDataUrl as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await GET(new Request(BASE));
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("no_photo");
    // A missing row degrades to a null ref — never an error.
    expect(resolveAutoBewerbPhotoDataUrl).toHaveBeenCalledWith(USER.id, null);
  });

  it("a storage miss for the current token (object gone) also degrades to 404 no_photo", async () => {
    (getAutoBewerbProfilePhotoRef as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(CURRENT_REF);
    (resolveAutoBewerbPhotoDataUrl as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await GET(new Request(BASE));
    expect(res.status).toBe(404);
    expect((await res.json() as Record<string, unknown>).code).toBe("no_photo");
  });

  it("resolves a FROZEN reference (?ref=) directly — the current row is never consulted (Step 4 preview)", async () => {
    const ref = `abphoto:v1:${"b".repeat(64)}:jpg`;
    (resolveAutoBewerbPhotoDataUrl as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      `data:image/jpeg;base64,${Buffer.from("jpeg-bytes").toString("base64")}`,
    );
    const res = await GET(new Request(`${BASE}?ref=${encodeURIComponent(ref)}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    // Frozen semantics: replaced/removed photos must not leak into saved
    // documents — so the current-photo row lookup is skipped entirely.
    expect(resolveAutoBewerbPhotoDataUrl).toHaveBeenCalledWith(USER.id, ref);
    expect(getAutoBewerbProfilePhotoRef).not.toHaveBeenCalled();
  });

  it("a frozen token whose storage object is gone degrades to 404 (old documents keep working)", async () => {
    const ref = `abphoto:v1:${"c".repeat(64)}:png`;
    (resolveAutoBewerbPhotoDataUrl as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await GET(new Request(`${BASE}?ref=${encodeURIComponent(ref)}`));
    expect(res.status).toBe(404);
    expect((await res.json() as Record<string, unknown>).code).toBe("no_photo");
  });

  it("another user's photo cannot be requested: only the SESSION user id reaches the engine", async () => {
    const otherUser = `abphoto:v1:${"d".repeat(64)}:png`;
    (getAutoBewerbProfilePhotoRef as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(otherUser);
    (resolveAutoBewerbPhotoDataUrl as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(TINY_PNG_URL);
    await GET(new Request(BASE));
    // No user-id parameter exists in this API surface at all — the engine
    // is always called with the session-verified id (ownership + the
    // owner-scoped storage path are enforced inside the resolver).
    expect(getAutoBewerbProfilePhotoRef).toHaveBeenCalledWith(USER.id);
    expect(resolveAutoBewerbPhotoDataUrl).toHaveBeenCalledWith(USER.id, otherUser);
  });

  it("rejects an explicitly empty ref parameter", async () => {
    const res = await GET(new Request(`${BASE}?ref=`));
    expect(res.status).toBe(400);
  });
});

describe("DELETE — remove the current photo", () => {
  it("confirms success and scopes the call to the session user", async () => {
    (deleteAutoBewerbProfilePhoto as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const res = await DELETE();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(deleteAutoBewerbProfilePhoto).toHaveBeenCalledWith(USER.id);
  });

  it("maps schema_pending to 503", async () => {
    (deleteAutoBewerbProfilePhoto as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      code: "schema_pending",
      message: "x",
    });
    const res = await DELETE();
    expect(res.status).toBe(503);
  });
});
