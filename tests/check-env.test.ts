import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { validateEnv } from "../scripts/check-env.mjs";

const execFileAsync = promisify(execFile);

const JWT_A = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.aaaa1111bbbb";
const JWT_B = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoicm9sZSJ9.cccc2222dddd";

/** A fully valid production environment (fake values, correct formats). */
const GOOD_ENV: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: "https://my-project.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: JWT_A,
  SUPABASE_SERVICE_ROLE_KEY: JWT_B,
  APP_URL: "https://my-app.example.com",
  EMAIL_TOKEN_ENCRYPTION_KEY: "a-very-long-random-encryption-secret-123",
  EMAIL_WORKER_SECRET: "a-very-long-random-worker-secret-123",
  ARBEITSAGENTUR_API_KEY: "jobboerse-jobsuche", // documented public default
};

const CLI = fileURLToPath(new URL("../scripts/check-env.mjs", import.meta.url));

async function runCli(
  env: Record<string, string | undefined>,
): Promise<{ code: number; out: string }> {
  const childEnv = { PATH: process.env.PATH ?? "", ...env };
  try {
    const { stdout } = await execFileAsync(process.execPath, [CLI], {
      env: childEnv as unknown as NodeJS.ProcessEnv,
    });
    return { code: 0, out: stdout };
  } catch (error) {
    const err = error as { code?: unknown; stdout?: unknown };
    return {
      code: typeof err.code === "number" ? err.code : 1,
      out: typeof err.stdout === "string" ? err.stdout : "",
    };
  }
}

describe("validateEnv", () => {
  it("passes a fully configured production environment", () => {
    const result = validateEnv(GOOD_ENV);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("fails on a missing required variable (named)", () => {
    const env = { ...GOOD_ENV };
    delete env.SUPABASE_SERVICE_ROLE_KEY;
    const result = validateEnv(env);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("fails when APP_URL (email-confirmation redirect) is missing", () => {
    const env = { ...GOOD_ENV };
    delete env.APP_URL;
    const result = validateEnv(env);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("APP_URL");
  });

  it("fails on a malformed APP_URL", () => {
    const result = validateEnv({ ...GOOD_ENV, APP_URL: "not-a-url" });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("APP_URL");
  });

  it("fails when a required key still holds its .env.example placeholder", () => {
    const result = validateEnv({
      ...GOOD_ENV,
      SUPABASE_SERVICE_ROLE_KEY: "your-service-role-key",
      NEXT_PUBLIC_SUPABASE_URL: "https://your-project.supabase.co",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("placeholder");
    expect(result.errors.join(" ")).toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("fails on a scheme-prefixed placeholder URL (https://your-project...)", () => {
    const result = validateEnv({
      ...GOOD_ENV,
      NEXT_PUBLIC_SUPABASE_URL: "https://your-project.supabase.co",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("NEXT_PUBLIC_SUPABASE_URL");
    expect(result.errors.join(" ")).toContain("placeholder");
  });

  it("fails on a malformed (non-JWT) Supabase key", () => {
    const result = validateEnv({
      ...GOOD_ENV,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "not-a-jwt",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  });

  it("ignores optional variables that are not set", () => {
    const result = validateEnv({ ...GOOD_ENV });
    expect(result.ok).toBe(true);
    const ai = result.results.find((r) => r.name === "AI_API_KEY");
    expect(ai).toEqual(
      expect.objectContaining({
        status: "pass",
        message: "not set (optional)",
      }),
    );
  });

  it("only warns (does not fail) on a short secret", () => {
    const result = validateEnv({
      ...GOOD_ENV,
      EMAIL_WORKER_SECRET: "short",
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toContain("EMAIL_WORKER_SECRET");
  });

  it("only warns on a localhost OAuth redirect URI", () => {
    const result = validateEnv({
      ...GOOD_ENV,
      GOOGLE_CLIENT_ID: "google-id",
      GOOGLE_CLIENT_SECRET: "a-google-client-secret-value-123",
      GOOGLE_REDIRECT_URI: "http://localhost:3000/api/email/callback/gmail",
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toContain("localhost");
  });

  it("only warns on a non-https Supabase URL", () => {
    const result = validateEnv({
      ...GOOD_ENV,
      NEXT_PUBLIC_SUPABASE_URL: "http://my-project.supabase.co",
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toContain("NEXT_PUBLIC_SUPABASE_URL");
  });

  it("does not treat the documented ARBEITSAGENTUR public default as a placeholder", () => {
    const result = validateEnv(GOOD_ENV);
    const ba = result.results.find((r) => r.name === "ARBEITSAGENTUR_API_KEY");
    expect(ba).toEqual(expect.objectContaining({ status: "pass" }));
  });

  it("reports external integration seams by readiness without affecting ok", () => {
    const result = validateEnv(GOOD_ENV);
    // GOOD_ENV sets the worker secret but no AI key / no OAuth app.
    const byName = Object.fromEntries(
      result.seams.map((s) => [s.name, s.status]),
    );
    expect(byName["ai-assistant"]).toBe("pending");
    expect(byName["email-oauth"]).toBe("pending");
    expect(byName["email-worker-poller"]).toBe("configured");
    // The two code-level seams are always pending until configured in code.
    expect(byName["payment-provider"]).toBe("pending");
    expect(byName["vacancy-providers"]).toBe("pending");
    // Seams are informational only — they must never flip readiness.
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("marks AI and OAuth seams configured when their credentials are present", () => {
    const env = {
      ...GOOD_ENV,
      AI_API_KEY: "sk-a-very-long-provider-key-12345",
      GOOGLE_CLIENT_ID: "google-app-id",
      GOOGLE_CLIENT_SECRET: "a-google-client-secret-value-123",
    };
    const byName = Object.fromEntries(
      validateEnv(env).seams.map((s) => [s.name, s.status]),
    );
    expect(byName["ai-assistant"]).toBe("configured");
    expect(byName["email-oauth"]).toBe("configured");
  });

  it("treats a placeholder credential as NOT configured for a seam", () => {
    const byName = Object.fromEntries(
      validateEnv({ ...GOOD_ENV, AI_API_KEY: "your-ai-api-key" }).seams.map(
        (s) => [s.name, s.status],
      ),
    );
    expect(byName["ai-assistant"]).toBe("pending");
  });
});

describe("check:env CLI", () => {
  it("exits 0 and reports readiness for a valid environment", async () => {
    const { code, out } = await runCli(GOOD_ENV);
    expect(code).toBe(0);
    expect(out).toContain("ready for deployment");
  });

  it("exits 1 and names the failing variables for a bad environment", async () => {
    const { code, out } = await runCli({
      NEXT_PUBLIC_SUPABASE_URL: "https://your-project.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "broken",
    });
    expect(code).toBe(1);
    expect(out).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(out).toContain("EMAIL_WORKER_SECRET");
    expect(out).toMatch(/\d+ problem\(s\) must be fixed/);
  });

  it("never prints secret values (names and statuses only)", async () => {
    const { out } = await runCli(GOOD_ENV);
    expect(out).not.toContain(JWT_A);
    expect(out).not.toContain(JWT_B);
    expect(out).not.toContain(GOOD_ENV.EMAIL_TOKEN_ENCRYPTION_KEY);
    expect(out).not.toContain(GOOD_ENV.EMAIL_WORKER_SECRET);
  });

  it("prints the external integration seams section (names/notes only, no values)", async () => {
    const { out } = await runCli(GOOD_ENV);
    expect(out).toContain("External integration seams");
    expect(out).toContain("[READY] email-worker-poller");
    expect(out).toContain("[PENDING] payment-provider");
    expect(out).toContain("[PENDING] ai-assistant");
    // The seams section must not leak any credential value.
    expect(out).not.toContain(GOOD_ENV.EMAIL_WORKER_SECRET);
    expect(out).not.toContain(GOOD_ENV.SUPABASE_SERVICE_ROLE_KEY);
  });
});
