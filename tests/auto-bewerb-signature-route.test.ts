/**
 * AUTO BEWERB — /api/auto-bewerb/signature route contract.
 *
 * The route is the ONLY way a browser ever touches the signature: same-origin,
 * session-cookie-protected requests. Ownership always comes from the
 * authenticated session (never the body/query), uploads are rate-limited,
 * engine error codes map to honest HTTP statuses, and the GET response streams
 * the OWNER's own bytes with no-store (the private bucket is never exposed —
 * no signed URLs, no public read).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkRateLimit,
  tooManyRequests,
} from "@/lib/rate-limit";
import {
  deleteAutoBewerbSignature,
  getAutoBewerbSignatureImage,
  uploadAutoBewerbSignature,
} from "@/lib/auto-bewerb/engine";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auto-bewerb/engine", () => ({
  uploadAutoBewerbSignature: vi.fn(),
  deleteAutoBewerbSignature: vi.fn(),
  getAutoBewerbSignatureImage: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitHeaders: (r: { limit: number; count: number }) => ({
    "x-ratelimit-limit": String(r.limit),
    "x-ratelimit-remaining": String(r.limit - r.count),
  }),
  tooManyRequests: vi.fn(),
}));

import { DELETE, GET, POST } from "@/app/api/auto-bewerb/signature/route";

const USER = { id: "11111111-1111-4111-8111-111111111111", email: "a@example.de" };
const BASE = "http://localhost/api/auto-bewerb/signature";

const TINY_PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

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
    expect((await GET()).status).toBe(401);
    expect((await POST(new Request(BASE, { method: "POST" }))).status).toBe(401);
    expect((await DELETE()).status).toBe(401);
  });
});

describe("POST — upload", () => {
  async function postFile(bytes: Uint8Array<ArrayBuffer>, name = "unterschrift.png", type = "image/png") {
    const form = new FormData();
    form.append("file", new File([bytes], name, { type }));
    return POST(new Request(BASE, { method: "POST", body: form }));
  }

  it("returns mime + size on success and calls the engine with the SESSION user id", async () => {
    (uploadAutoBewerbSignature as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      value: { mime: "image/png", sizeBytes: TINY_PNG_BYTES.length },
    });
    const res = await postFile(TINY_PNG_BYTES);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.mime).toBe("image/png");
    expect(body.sizeBytes).toBe(TINY_PNG_BYTES.length);
    expect(uploadAutoBewerbSignature).toHaveBeenCalledWith(USER.id, expect.any(Buffer));
  });

  it("maps engine error codes to honest HTTP statuses", async () => {
    const cases: Array<[string, number]> = [
      ["invalid_file_type", 415],
      ["file_too_large", 413],
      ["storage_error", 502],
    ];
    for (const [code, status] of cases) {
      vi.clearAllMocks();
      mockAuth(USER);
      (checkRateLimit as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        allowed: true,
        count: 1,
        limit: 30,
        retryAfterSeconds: 0,
      });
      (uploadAutoBewerbSignature as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        code,
        message: "x",
      });
      const res = await postFile(TINY_PNG_BYTES);
      expect(res.status, code).toBe(status);
    }
  });

  it("rejects a request without a file (400) without calling the engine", async () => {
    const res = await POST(new Request(BASE, { method: "POST", body: new FormData() }));
    expect(res.status).toBe(400);
    expect(uploadAutoBewerbSignature).not.toHaveBeenCalled();
  });

  it("honors the upload rate limit (429) before any write", async () => {
    (checkRateLimit as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      allowed: false,
      count: 31,
      limit: 30,
      retryAfterSeconds: 30,
    });
    (tooManyRequests as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ status: 429, json: async () => ({}) });
    const res = await postFile(TINY_PNG_BYTES);
    expect(res).toMatchObject({ status: 429 });
    expect(checkRateLimit).toHaveBeenCalledWith("ai_upload", USER.id);
    expect(uploadAutoBewerbSignature).not.toHaveBeenCalled();
  });
});

describe("GET — owner-scoped download (current signature or none)", () => {
  it("streams the OWNER's bytes with the image content type + no-store", async () => {
    (getAutoBewerbSignatureImage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      bytes: TINY_PNG_BYTES,
      mime: "image/png",
    });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await res.arrayBuffer()).equals(TINY_PNG_BYTES)).toBe(true);
    // The lookup is scoped to the SESSION user id (no client-supplied id exists).
    expect(getAutoBewerbSignatureImage).toHaveBeenCalledWith(USER.id);
  });

  it("returns 404 no_signature when the candidate has none (missing handled)", async () => {
    (getAutoBewerbSignatureImage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(404);
    expect((await res.json() as Record<string, unknown>).code).toBe("no_signature");
  });
});

describe("DELETE — remove the signature", () => {
  it("confirms success and scopes the call to the session user", async () => {
    (deleteAutoBewerbSignature as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const res = await DELETE();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(deleteAutoBewerbSignature).toHaveBeenCalledWith(USER.id);
  });

  it("maps not_found → 404 and storage_error → 502", async () => {
    for (const [code, status] of [
      ["not_found", 404],
      ["storage_error", 502],
    ] as Array<[string, number]>) {
      vi.clearAllMocks();
      mockAuth(USER);
      (deleteAutoBewerbSignature as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, code, message: "x" });
      const res = await DELETE();
      expect(res.status, code).toBe(status);
    }
  });
});
