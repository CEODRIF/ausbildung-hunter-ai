import { describe, expect, it } from "vitest";
import {
  GENERATED_FILE_MIME_TYPES,
  generateFileRequestSchema,
  scanRequestBodySchema,
} from "@/lib/bewerbung-schema";
import { RATE_LIMITS, rateLimitKey } from "@/lib/rate-limit";
import { assertPublicTarget } from "@/lib/web-search/fetch-page";

/**
 * API input-validation and SSRF contracts.
 *
 * The payloads below are the ones a hostile client sends: unknown keys that
 * try to smuggle a server-owned field, unbounded strings, wrong types, and
 * URLs that point at the local network. Every one of them must be refused
 * BEFORE any business logic (and any paid AI call) runs.
 */
/** A real RFC-4122 v4 id (version nibble 4, variant nibble 8) — zod v4
 *  rejects "looks like a uuid" values that violate the version/variant bits. */
const UUID = "11111111-2222-4333-8444-555555555555";
const validScanFile = {
  id: UUID,
  filename: "lebenslauf.pdf",
  mime_type: "application/pdf",
};

describe("POST /api/bewerbung-scanner/scan request contract", () => {
  it("accepts a well-formed request", () => {
    const parsed = scanRequestBodySchema.safeParse({
      goal: "ausbildung",
      files: [validScanFile],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown goal", () => {
    for (const goal of ["", "Ausbildung", "job", null, 1]) {
      expect(
        scanRequestBodySchema.safeParse({ goal, files: [validScanFile] }).success,
      ).toBe(false);
    }
  });

  it("bounds the file list (no unbounded arrays)", () => {
    expect(
      scanRequestBodySchema.safeParse({ goal: "arbeit", files: [] }).success,
    ).toBe(false);
    expect(
      scanRequestBodySchema.safeParse({
        goal: "arbeit",
        files: Array.from({ length: 11 }, () => validScanFile),
      }).success,
    ).toBe(false);
    expect(
      scanRequestBodySchema.safeParse({
        goal: "arbeit",
        files: Array.from({ length: 10 }, () => validScanFile),
      }).success,
    ).toBe(true);
  });

  it("rejects non-uuid file ids and unbounded strings", () => {
    expect(
      scanRequestBodySchema.safeParse({
        goal: "arbeit",
        files: [{ ...validScanFile, id: "../../etc/passwd" }],
      }).success,
    ).toBe(false);
    expect(
      scanRequestBodySchema.safeParse({
        goal: "arbeit",
        files: [{ ...validScanFile, filename: "a".repeat(256) }],
      }).success,
    ).toBe(false);
    expect(
      scanRequestBodySchema.safeParse({
        goal: "arbeit",
        files: [{ ...validScanFile, mime_type: "a".repeat(121) }],
      }).success,
    ).toBe(false);
  });

  it("cannot smuggle server-owned fields (storage_path, size_bytes, user_id)", () => {
    for (const extra of [
      { storage_path: "OTHER-USER/secret.pdf" },
      { size_bytes: 1 },
      { user_id: UUID },
    ]) {
      expect(
        scanRequestBodySchema.safeParse({
          goal: "arbeit",
          files: [{ ...validScanFile, ...extra }],
        }).success,
      ).toBe(false);
      expect(
        scanRequestBodySchema.safeParse({
          goal: "arbeit",
          files: [validScanFile],
          ...extra,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects a body that is not an object at all", () => {
    for (const body of [null, [], "x", 42]) {
      expect(scanRequestBodySchema.safeParse(body).success).toBe(false);
    }
  });
});

describe("POST /api/ai/generate-file request contract", () => {
  const valid = {
    conversationId: UUID,
    filename: "anschreiben.txt",
    mimeType: "text/plain",
    prompt: "Schreibe ein Anschreiben.",
  };

  it("accepts a well-formed request", () => {
    expect(generateFileRequestSchema.safeParse(valid).success).toBe(true);
  });

  it("only allows MIME types the ai-files bucket accepts", () => {
    for (const mimeType of [
      "text/html",
      "application/x-msdownload",
      "image/svg+xml",
      "text/plain; charset=utf-8",
      "",
    ]) {
      expect(
        generateFileRequestSchema.safeParse({ ...valid, mimeType }).success,
      ).toBe(false);
    }
    for (const mimeType of GENERATED_FILE_MIME_TYPES) {
      expect(
        generateFileRequestSchema.safeParse({ ...valid, mimeType }).success,
      ).toBe(true);
    }
  });

  it("refuses filenames containing path separators or traversal", () => {
    for (const filename of [
      "../../etc/passwd",
      "..\\..\\win.ini",
      "dir/file.txt",
      "/abs.txt",
      "..",
    ]) {
      expect(
        generateFileRequestSchema.safeParse({ ...valid, filename }).success,
      ).toBe(false);
    }
  });

  it("bounds the prompt (no unbounded AI input)", () => {
    expect(
      generateFileRequestSchema.safeParse({ ...valid, prompt: "" }).success,
    ).toBe(false);
    expect(
      generateFileRequestSchema.safeParse({ ...valid, prompt: "x".repeat(4001) })
        .success,
    ).toBe(false);
    expect(
      generateFileRequestSchema.safeParse({ ...valid, prompt: "x".repeat(4000) })
        .success,
    ).toBe(true);
  });

  it("rejects unknown keys instead of ignoring them", () => {
    for (const extra of [{ user_id: UUID }, { storagePath: "/etc/passwd" }]) {
      expect(
        generateFileRequestSchema.safeParse({ ...valid, ...extra }).success,
      ).toBe(false);
    }
  });
});

describe("rate-limit budgets are per-endpoint and server-side", () => {
  it("every scope has a positive, bounded budget", () => {
    const scopes = Object.entries(RATE_LIMITS);
    expect(scopes.length).toBeGreaterThanOrEqual(15);
    for (const [scope, budget] of scopes) {
      expect(budget.max, scope).toBeGreaterThan(0);
      // Nothing may be effectively unlimited.
      expect(budget.max, scope).toBeLessThanOrEqual(100_000);
      expect(budget.windowSeconds, scope).toBeGreaterThan(0);
      expect(budget.windowSeconds, scope).toBeLessThanOrEqual(24 * 3600);
    }
  });

  it("budgets are not one shared global limit", () => {
    const values = new Set(
      Object.values(RATE_LIMITS).map((b) => `${b.max}/${b.windowSeconds}`),
    );
    expect(values.size).toBeGreaterThan(5);
  });

  it("expensive endpoints are strictly tighter than cheap read endpoints", () => {
    expect(RATE_LIMITS.scanner_scan.max).toBeLessThan(RATE_LIMITS.ai_upload.max);
    expect(RATE_LIMITS.ai_generate_file.max).toBeLessThanOrEqual(
      RATE_LIMITS.ai_upload.max,
    );
    expect(RATE_LIMITS.deckblatt_generate.max).toBeLessThanOrEqual(
      RATE_LIMITS.scanner_scan.max,
    );
    expect(RATE_LIMITS.account_delete.max).toBeLessThanOrEqual(5);
  });

  it("keys are namespaced by scope so budgets cannot collide across endpoints", () => {
    const user = "user-1";
    expect(rateLimitKey("ai_upload", user)).toBe("ai_upload:user-1");
    expect(rateLimitKey("ai_upload", user)).not.toBe(
      rateLimitKey("scanner_scan", user),
    );
  });

  it("the unauthenticated auth scopes exist and are IP-keyed", () => {
    expect(RATE_LIMITS.register).toBeTruthy();
    expect(RATE_LIMITS.login).toBeTruthy();
    expect(RATE_LIMITS.verify_resend).toBeTruthy();
    // Not so aggressive that a shared/NATed office network is blocked.
    expect(RATE_LIMITS.login.max).toBeGreaterThanOrEqual(10);
    expect(RATE_LIMITS.register.max).toBeGreaterThanOrEqual(5);
  });
});

describe("SSRF: outbound fetches refuse non-public targets", () => {
  it("rejects loopback, private, link-local and cloud-metadata addresses", async () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "127.0.0.1.nip.io",
      "10.0.0.1",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "0.0.0.0",
      "::1",
      "::ffff:127.0.0.1",
    ]) {
      await expect(assertPublicTarget(host), host).resolves.toBe(false);
    }
  });

  it("allows a routable public address", async () => {
    // IP literal: resolved without any DNS lookup, so the assertion is
    // deterministic and does not depend on network access.
    await expect(assertPublicTarget("93.184.216.34")).resolves.toBe(true);
  });

  it("fails closed for a hostname that does not resolve", async () => {
    await expect(
      assertPublicTarget("this-host-does-not-exist.invalid"),
    ).resolves.toBe(false);
  });
});
