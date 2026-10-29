/**
 * AI Bewerbung Studio — ownership, authorization and secure uploads.
 *
 * Every engine entry point re-scopes by user_id (the identity is derived
 * from the authenticated session in the route/action layer — never from
 * client input). These tests pin, against an in-memory database that
 * honors the studio migration's unique constraints:
 *   1. cross-user reads/writes are impossible (not_found, zero side effects)
 *   2. the pre-migration "setup pending" state degrades gracefully
 *   3. uploads validate content (magic bytes), size, category, name
 *      sanitization; ownership is re-checked on rename/delete
 *   4. files only ever land in the PRIVATE application-attachments bucket
 *      under the owner's path prefix; no signed/public URLs exist anywhere
 *      in the feature (static source invariant)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createStudioDb, type StudioDb } from "./helpers-studio";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin";

let db: StudioDb;

function appRow(over: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    user_id: "user-a",
    ad_raw: "x".repeat(40),
    ad_extracted: null,
    ad_analysis: null,
    profile_snapshot: null,
    status: "draft",
    email_account_id: null,
    recipient_email: null,
    idempotency_key: null,
    approved: false,
    approved_at: null,
    scheduled_at: null,
    schedule_timezone: null,
    sent_at: null,
    provider_message_id: null,
    last_failure_code: null,
    created_at: "2026-12-01T00:00:00.000Z",
    updated_at: "2026-12-01T00:00:00.000Z",
    ...over,
  };
}

const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, ...new Array(100).fill(0x20)]);

beforeEach(() => {
  db = createStudioDb({
    studio_applications: [appRow()],
    email_accounts: [
      { id: "acct-1", user_id: "user-a", provider: "gmail", email: "a@gmail.com", is_active: true, requires_reconnect: false },
    ],
  });
  (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
});

function studio() {
  // Fresh module import per test → fresh hasStudioSchema() probe cache.
  vi.resetModules();
  return import("@/lib/studio");
}

describe("application ownership (cross-user isolation)", () => {
  it("user A can read their own application bundle", async () => {
    const { getStudioApplication } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const bundle = await getStudioApplication("user-a", "11111111-1111-4111-8111-111111111111");
    expect(bundle).not.toBeNull();
    expect(bundle?.app.id).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("the lookup always scopes by BOTH id AND user_id", async () => {
    const { getStudioApplication } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    await getStudioApplication("user-b", "11111111-1111-4111-8111-111111111111");
    const lookups = db.calls.filter((c) => c.table === "studio_applications" && c.op === "select");
    expect(lookups.length).toBeGreaterThan(0);
    for (const l of lookups) {
      expect(l.filters["eq:id"]).toBe("11111111-1111-4111-8111-111111111111");
      expect(l.filters["eq:user_id"]).toBe("user-b");
    }
  });

  it("user B cannot update user A's application", async () => {
    const { updateStudioApplication } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const res = await updateStudioApplication("user-b", "11111111-1111-4111-8111-111111111111", {
      recipient_email: "evil@x.de",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("not_found");
    expect(db.tables.studio_applications[0].recipient_email).toBeNull();
  });

  it("user B cannot approve or save documents for user A's application", async () => {
    const { approveApplication, saveStudioDocument } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const approved = await approveApplication("user-b", "11111111-1111-4111-8111-111111111111");
    expect(approved.ok).toBe(false);
    const saved = await saveStudioDocument(
      "user-b",
      "11111111-1111-4111-8111-111111111111",
      "cv",
      { version: 1, templateId: "classic", personal: {}, summary: "" },
    );
    expect(saved.ok).toBe(false);
    expect(db.tables.studio_applications[0].approved).toBe(false);
    expect(db.tables.studio_documents.length).toBe(0);
  });

  it("graceful 'setup pending' state before the migration exists", async () => {
    db.failTables(["studio_applications"]);
    const { hasStudioSchema, listStudioApplications } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    expect(await hasStudioSchema()).toBe(false);
    expect(await listStudioApplications("user-a")).toEqual([]);
  });
});

describe("attachments: upload validation + ownership", () => {
  const APP = "11111111-1111-4111-8111-111111111111";

  it("uploads a real PDF into the PRIVATE bucket under the owner prefix", async () => {
    const { uploadStudioAttachment } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const res = await uploadStudioAttachment("user-a", APP, {
      name: "Zeugnis 2024.pdf",
      buffer: PDF,
      category: "school_certificate",
    });
    expect(res.ok).toBe(true);
    if (res.ok && res.value) {
      expect(res.value.mime_type).toBe("application/pdf");
      expect(res.value.doc_category).toBe("school_certificate");
      expect(res.value.storage_path).toMatch(/^user-a\/studio\//);
    }
    expect(db.uploaded.every((u) => u.bucket === "application-attachments")).toBe(true);
    expect(db.tables.studio_attachments.length).toBe(1);
  });

  it("rejects a file whose CONTENT is not a supported type (spoofed extension)", async () => {
    const { uploadStudioAttachment } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const res = await uploadStudioAttachment("user-a", APP, {
      name: "harmless.pdf",
      buffer: Buffer.from("<html><script>alert(1)</script></html>".repeat(10)),
      category: "other",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("invalid_file_type");
    expect(db.uploaded.length).toBe(0);
    expect(db.tables.studio_attachments.length).toBe(0);
  });

  it("rejects files above the per-user upload cap", async () => {
    const { uploadStudioAttachment } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const big = Buffer.concat([PDF, Buffer.alloc(11 * 1024 * 1024)]);
    const res = await uploadStudioAttachment("user-a", APP, { name: "big.pdf", buffer: big, category: "other" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("file_too_large");
  });

  it("sanitizes display names (no path traversal, length cap)", async () => {
    const { uploadStudioAttachment } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const res = await uploadStudioAttachment("user-a", APP, {
      name: "../../etc/passwd.pdf",
      buffer: PDF,
      category: "other",
    });
    expect(res.ok).toBe(true);
    if (res.ok && res.value) {
      expect(res.value.display_name).not.toContain("..");
      expect(res.value.storage_path).toMatch(/^user-a\/studio\//);
    }
  });

  it("user B cannot rename or delete user A's attachment", async () => {
    const { uploadStudioAttachment, renameStudioAttachment, deleteStudioAttachment } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const up = await uploadStudioAttachment("user-a", APP, { name: "doc.pdf", buffer: PDF, category: "other" });
    if (!up.ok || !up.value) throw new Error("setup upload failed");
    const attId = up.value.id;

    const renamed = await renameStudioAttachment("user-b", attId, "stolen.pdf");
    expect(renamed.ok).toBe(false);
    if (!renamed.ok) expect(renamed.code).toBe("not_found");

    const deleted = await deleteStudioAttachment("user-b", attId);
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.code).toBe("not_found");

    expect(db.tables.studio_attachments.length).toBe(1);
    expect(db.tables.studio_attachments[0].display_name).toBe("doc.pdf");

    // The owner CAN delete — and the private object goes with it.
    const ownerDelete = await deleteStudioAttachment("user-a", attId);
    expect(ownerDelete.ok).toBe(true);
    expect(db.tables.studio_attachments.length).toBe(0);
  });
});

describe("no public document URLs (static source invariant)", () => {
  it("feature code never requests signed or public storage URLs", () => {
    const files = [
      "src/lib/studio.ts",
      "src/app/api/bewerbung-studio/attachments/route.ts",
      "src/app/bewerbung-studio/actions.ts",
    ];
    for (const f of files) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      expect(src, f).not.toMatch(/createSignedUrl|getPublicUrl|storage\.from\([^)]*\)\.public/);
    }
  });
});
