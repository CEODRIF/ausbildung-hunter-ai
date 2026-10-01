import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 19 — profile settings contract.
 *
 *  - name edits only ever touch first_name / last_name / full_name and are
 *    scoped to the session user id;
 *  - avatars are validated (mime + magic bytes + 2 MB ceiling) and stored
 *    under the caller's own `{user-id}/` folder in the avatars bucket;
 *  - the previous avatar is only ever removed when it belongs to the same
 *    user;
 *  - the migration adds the columns, the bucket and owner-scoped policies.
 */
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const { createAdminClient } = await import("@/lib/supabase/admin");
const {
  AVATAR_BUCKET,
  AVATAR_MAX_BYTES,
  avatarPathFromUrl,
  createAvatarPath,
  linkedProviders,
  looksLikeImage,
  splitFullName,
  updateProfileName,
  uploadProfileAvatar,
  validateAvatar,
  validateProfileName,
} = await import("@/lib/profile-settings");

const root = fileURLToPath(new URL("..", import.meta.url));
const migration = readFileSync(
  `${root}/supabase/migrations/20261013000000_profile_settings.sql`,
  "utf8",
);

afterEach(() => {
  vi.clearAllMocks();
});

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const TEXT = new TextEncoder().encode("this is not an image at all");

describe("profile name validation", () => {
  it("trims and collapses whitespace, then derives full_name", () => {
    const result = validateProfileName({
      firstName: "  Ada  ",
      lastName: "  von   Lovelace ",
    });
    expect(result).toEqual({
      ok: true,
      firstName: "Ada",
      lastName: "von Lovelace",
      fullName: "Ada von Lovelace",
    });
  });

  it("requires both parts", () => {
    expect(validateProfileName({ firstName: "Ada", lastName: "   " })).toEqual({
      ok: false,
      error: "name_required",
    });
    expect(validateProfileName({ firstName: "", lastName: "Lovelace" })).toEqual(
      { ok: false, error: "name_required" },
    );
  });

  it("rejects over-long parts and an over-long combined name", () => {
    expect(
      validateProfileName({ firstName: "a".repeat(61), lastName: "b" }),
    ).toEqual({ ok: false, error: "name_too_long" });
    // Each part fits, the combined full_name would exceed the 120 char column.
    expect(
      validateProfileName({ firstName: "a".repeat(60), lastName: "b".repeat(60) }),
    ).toEqual({ ok: false, error: "name_too_long" });
  });

  it("splits a legacy full_name into editable parts", () => {
    expect(splitFullName("Ada Lovelace")).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
    });
    expect(splitFullName("Ada von Lovelace")).toEqual({
      firstName: "Ada",
      lastName: "von Lovelace",
    });
    expect(splitFullName("Ada")).toEqual({ firstName: "Ada", lastName: "" });
    expect(splitFullName(null)).toEqual({ firstName: "", lastName: "" });
  });
});

describe("avatar validation", () => {
  it("accepts jpeg/png/webp by magic bytes", () => {
    expect(looksLikeImage(PNG)).toBe(true);
    expect(looksLikeImage(JPEG)).toBe(true);
    expect(looksLikeImage(WEBP)).toBe(true);
    expect(looksLikeImage(TEXT)).toBe(false);
    expect(looksLikeImage(new Uint8Array([0xff, 0xd8]))).toBe(false);
  });

  it("maps allowed mime types to an extension", () => {
    expect(
      validateAvatar({ size: 1024, mimeType: "image/png", bytes: PNG }),
    ).toEqual({ ok: true, extension: "png", mimeType: "image/png" });
    expect(
      validateAvatar({ size: 1024, mimeType: "image/jpeg", bytes: JPEG }),
    ).toEqual({ ok: true, extension: "jpg", mimeType: "image/jpeg" });
    expect(
      validateAvatar({ size: 1024, mimeType: "image/webp", bytes: WEBP }),
    ).toEqual({ ok: true, extension: "webp", mimeType: "image/webp" });
  });

  it("rejects non-image types and disguised files", () => {
    expect(
      validateAvatar({ size: 1024, mimeType: "image/gif", bytes: PNG }),
    ).toEqual({ ok: false, error: "avatar_type" });
    expect(
      validateAvatar({ size: 1024, mimeType: "application/pdf", bytes: PNG }),
    ).toEqual({ ok: false, error: "avatar_type" });
    // A valid image mime with non-image bytes (renamed file) is rejected.
    expect(
      validateAvatar({ size: 1024, mimeType: "image/png", bytes: TEXT }),
    ).toEqual({ ok: false, error: "avatar_type" });
  });

  it("enforces the size ceiling", () => {
    expect(
      validateAvatar({ size: 0, mimeType: "image/png", bytes: PNG }),
    ).toEqual({ ok: false, error: "avatar_size" });
    expect(
      validateAvatar({
        size: AVATAR_MAX_BYTES + 1,
        mimeType: "image/png",
        bytes: PNG,
      }),
    ).toEqual({ ok: false, error: "avatar_size" });
    expect(
      validateAvatar({
        size: AVATAR_MAX_BYTES,
        mimeType: "image/png",
        bytes: PNG,
      }).ok,
    ).toBe(true);
  });
});

describe("avatar paths", () => {
  it("always nests the object under the owner's user id", () => {
    const path = createAvatarPath("user-1", "png", 1700000000000);
    expect(path).toBe("user-1/avatar-1700000000000.png");
    expect(path.startsWith("user-1/")).toBe(true);
  });

  it("reads the object path back out of a public URL", () => {
    expect(
      avatarPathFromUrl(
        `https://x.supabase.co/storage/v1/object/public/${AVATAR_BUCKET}/user-1/avatar-1.png`,
      ),
    ).toBe("user-1/avatar-1.png");
    expect(
      avatarPathFromUrl(
        "https://x.supabase.co/storage/v1/object/public/ai-files/user-1/f.pdf",
      ),
    ).toBeNull();
    expect(avatarPathFromUrl(null)).toBeNull();
  });

  it("lists linked providers without duplicates", () => {
    expect(
      linkedProviders([{ provider: "Google" }, { provider: "azure" }, { provider: "google" }]),
    ).toEqual(["azure", "google"]);
    expect(linkedProviders(undefined)).toEqual([]);
  });
});

describe("profile writes", () => {
  it("writes only the name parts and the derived display name for that user", async () => {
    const tables: string[] = [];
    const payloads: Array<Record<string, unknown>> = [];
    const filters: Array<[string, unknown]> = [];
    vi.mocked(createAdminClient).mockReturnValue({
      from: (table: string) => {
        tables.push(table);
        return {
          update: (values: Record<string, unknown>) => {
            payloads.push(values);
            return {
              eq: (column: string, value: unknown) => {
                filters.push([column, value]);
                return Promise.resolve({ error: null });
              },
            };
          },
        };
      },
    } as never);

    const result = await updateProfileName("user-1", {
      firstName: "Ada",
      lastName: "Lovelace",
    });

    expect(tables).toEqual(["profiles"]);
    expect(payloads[0]).toEqual({
      first_name: "Ada",
      last_name: "Lovelace",
      full_name: "Ada Lovelace",
    });
    // No other profile column (email, status, limits) is ever part of the write.
    expect(Object.keys(payloads[0]).sort()).toEqual([
      "first_name",
      "full_name",
      "last_name",
    ]);
    expect(filters).toEqual([["id", "user-1"]]);
    expect(result.fullName).toBe("Ada Lovelace");
  });

  it("uploads into the caller's folder and never deletes a foreign avatar", async () => {
    const uploads: Array<{ bucket: string; path: string }> = [];
    const removed: string[] = [];
    const updates: Array<Record<string, unknown>> = [];
    vi.mocked(createAdminClient).mockReturnValue({
      storage: {
        from: (bucket: string) => ({
          upload: async (path: string) => {
            uploads.push({ bucket, path });
            return { error: null };
          },
          getPublicUrl: (path: string) => ({
            data: {
              publicUrl: `https://x.supabase.co/storage/v1/object/public/${bucket}/${path}`,
            },
          }),
          remove: async (paths: string[]) => {
            removed.push(...paths);
            return { error: null };
          },
        }),
      },
      from: () => ({
        update: (values: Record<string, unknown>) => {
          updates.push(values);
          return { eq: () => Promise.resolve({ error: null }) };
        },
      }),
    } as never);

    const file = new File([PNG], "avatar.png", { type: "image/png" });
    const otherUserUrl =
      "https://x.supabase.co/storage/v1/object/public/avatars/user-2/avatar-1.png";

    const result = await uploadProfileAvatar("user-1", file, otherUserUrl);

    expect(uploads).toHaveLength(1);
    expect(uploads[0].bucket).toBe(AVATAR_BUCKET);
    expect(uploads[0].path.startsWith("user-1/")).toBe(true);
    expect(uploads[0].path.endsWith(".png")).toBe(true);
    expect(updates[0]).toEqual({ avatar_url: result.avatarUrl });
    expect(result.avatarUrl).toContain("/avatars/user-1/");
    // Another user's object is never touched.
    expect(removed).toEqual([]);
  });

  it("cleans up the previous avatar when it belongs to the same user", async () => {
    const removed: string[] = [];
    vi.mocked(createAdminClient).mockReturnValue({
      storage: {
        from: () => ({
          upload: async () => ({ error: null }),
          getPublicUrl: (path: string) => ({
            data: {
              publicUrl: `https://x.supabase.co/storage/v1/object/public/avatars/${path}`,
            },
          }),
          remove: async (paths: string[]) => {
            removed.push(...paths);
            return { error: null };
          },
        }),
      },
      from: () => ({
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      }),
    } as never);

    const file = new File([JPEG], "avatar.jpg", { type: "image/jpeg" });
    await uploadProfileAvatar(
      "user-1",
      file,
      "https://x.supabase.co/storage/v1/object/public/avatars/user-1/avatar-1.jpg",
    );

    expect(removed).toEqual(["user-1/avatar-1.jpg"]);
  });

  it("rejects an invalid file before touching storage", async () => {
    const upload = vi.fn();
    vi.mocked(createAdminClient).mockReturnValue({
      storage: { from: () => ({ upload }) },
    } as never);

    const file = new File([TEXT], "notes.txt", { type: "text/plain" });
    await expect(uploadProfileAvatar("user-1", file, null)).rejects.toThrow(
      "avatar_type",
    );
    expect(upload).not.toHaveBeenCalled();
  });
});

describe("profile settings migration", () => {
  it("adds the editable columns without touching other profile fields", () => {
    expect(migration).toContain("add column if not exists first_name text");
    expect(migration).toContain("add column if not exists last_name text");
    expect(migration).toContain("add column if not exists avatar_url text");
    // The pre-existing display name stays the source of truth for the app.
    expect(migration).not.toContain("drop column full_name");
  });

  it("creates the avatars bucket with the image allow-list and 2 MB ceiling", () => {
    expect(migration).toContain("insert into storage.buckets");
    expect(migration).toContain("'avatars', 'avatars', true, 2097152");
    expect(migration).toContain(
      "array['image/jpeg', 'image/png', 'image/webp']",
    );
    expect(migration).toContain("on conflict (id) do update set");
  });

  it("scopes every avatars policy to the owner's own folder", () => {
    const policies = migration.match(
      /create policy "[^"]+"\s+on storage\.objects[^;]+;/g,
    );
    expect(policies).toHaveLength(3);
    for (const policy of policies ?? []) {
      expect(policy).toContain("bucket_id = 'avatars'");
      expect(policy).toContain("(storage.foldername(name))[1] = auth.uid()::text");
    }
  });
});
