import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PKCE contract: the Supabase project runs in PKCE flow type. BOTH clients
 * must be created with flowType: "pkce" — otherwise signUp() sends no code
 * challenge (no code-verifier cookie is persisted) and the /auth/callback
 * code exchange can never succeed, so the email is never confirmed and no
 * session is ever created (production incident 2026-10).
 */
const { createServerClientMock, createBrowserClientMock } = vi.hoisted(() => ({
  createServerClientMock: vi.fn(() => ({})),
  createBrowserClientMock: vi.fn(() => ({})),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: createServerClientMock,
  createBrowserClient: createBrowserClientMock,
}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ getAll: () => [], set: vi.fn() })),
}));

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://test-project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-anon-key");
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("supabase clients (PKCE)", () => {
  it("server client is created with flowType pkce and persistSession", async () => {
    const { createClient } = await import("@/lib/supabase/server");
    await createClient();
    expect(createServerClientMock).toHaveBeenCalledWith(
      "https://test-project.supabase.co",
      "test-anon-key",
      expect.objectContaining({
        auth: {
          flowType: "pkce",
          persistSession: true,
        },
      }),
    );
  });

  it("browser client is created with flowType pkce and URL session detection", async () => {
    const { createClient } = await import("@/lib/supabase/client");
    createClient();
    expect(createBrowserClientMock).toHaveBeenCalledWith(
      "https://test-project.supabase.co",
      "test-anon-key",
      expect.objectContaining({
        auth: {
          flowType: "pkce",
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      }),
    );
  });
});
