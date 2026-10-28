import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Deutsch Bibliothek — the download-initiation server action.
 *
 * The action is the boundary between the browser and the quota logic:
 *   - the ACTOR is always the session user (getCurrentUserAndProfile);
 *   - the action accepts ONLY the book id — no user id, plan, trial flag,
 *     or remaining count can be supplied (source invariant below);
 *   - a missing session is a clean `not_signed_in` (the UI falls back to
 *     the guest UX) — never a grant, never an entitlement lookup for a
 *     fabricated identity;
 *   - an unexpected failure is a stable `db_error`, not a stack trace.
 */

vi.mock("@/lib/auth", () => ({ getCurrentUserAndProfile: vi.fn() }));
vi.mock("@/lib/book-library", () => ({
  initiateBookDownload: vi.fn(),
}));

import { getCurrentUserAndProfile } from "@/lib/auth";
import { initiateBookDownload } from "@/lib/book-library";
import { initiateBookDownloadAction } from "@/app/bibliothek/actions";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const BOOK_ID = "aaaaaaaa-1111-4111-8111-111111111111";

afterEach(() => vi.clearAllMocks());

describe("initiateBookDownloadAction", () => {
  it("guest → not_signed_in, and the quota layer is NEVER reached", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
      user: null,
      profile: null,
    });
    const result = await initiateBookDownloadAction(BOOK_ID);
    expect(result).toEqual({
      ok: false,
      error: "not_signed_in",
      remaining: 0,
      tier: "none",
    });
    expect(initiateBookDownload).not.toHaveBeenCalled();
  });

  it("session user → the lib is called with the SESSION id (and only the book id from the client)", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
      user: { id: USER_ID } as never,
      profile: null,
    });
    vi.mocked(initiateBookDownload).mockResolvedValue({
      ok: true,
      url: "https://example.com/buch.pdf",
      remaining: 0,
      tier: "trial",
      deduplicated: false,
    });
    const result = await initiateBookDownloadAction(BOOK_ID);
    expect(initiateBookDownload).toHaveBeenCalledTimes(1);
    expect(initiateBookDownload).toHaveBeenCalledWith(USER_ID, BOOK_ID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url).toBe("https://example.com/buch.pdf");
  });

  it("an unexpected throw becomes the stable db_error code", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
      user: { id: USER_ID } as never,
      profile: null,
    });
    vi.mocked(initiateBookDownload).mockRejectedValue(new Error("boom"));
    const result = await initiateBookDownloadAction(BOOK_ID);
    expect(result).toEqual({
      ok: false,
      error: "db_error",
      remaining: 0,
      tier: "none",
    });
  });
});

describe("source invariants (no client-trusted identity/plan inputs)", () => {
  const ROOT = join(__dirname, "..");
  const actions = readFileSync(join(ROOT, "src/app/bibliothek/actions.ts"), "utf8");

  it("is a server action gated on the session", () => {
    expect(actions).toContain('"use server"');
    expect(actions).toContain("getCurrentUserAndProfile()");
  });

  it("accepts ONLY the book id — no user/plan/quota parameter or form field", () => {
    // The exported action signature has a single parameter.
    expect(actions).toMatch(
      /export async function initiateBookDownloadAction\(\s*bookId: string,?\s*\)/,
    );
    expect(actions).not.toMatch(/formData/);
    expect(actions).not.toMatch(/\b(planId|plan|trial|remaining|quota|userId|user_id)\s*[:=]\s*(request|body|params|formData)/);
    // The lib call uses the SESSION id, nothing else.
    expect(actions).toContain("initiateBookDownload(user.id, bookId)");
  });
});
