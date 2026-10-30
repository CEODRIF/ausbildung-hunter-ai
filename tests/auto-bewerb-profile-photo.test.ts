/**
 * AUTO BEWERB — Step 1 professional profile photo (Bewerbungsfoto).
 *
 * Covers the complete photo pipeline the workflow depends on:
 *  - magic-byte validation + size/dimension caps (the BYTES decide, never
 *    the browser's MIME hint),
 *  - the pure header dimension readers (PNG IHDR / JPEG SOF / WebP VP8L),
 *  - the frozen reference token contract (abphoto:v1:<sha256>:<ext> — no URL,
 *    no path, no client input) and the owner-scoped storage path,
 *  - sanitizeCvDocument / normalizeCvPhotoValue (client URLs never survive),
 *  - the migration SQL contract (owner-select RLS, write revoke, webp bucket
 *    mime, idempotent DDL) and the untouched 7-table workflow probe,
 *  - engine upload/replace/delete semantics against the in-memory admin
 *    client (owner folder, content-hash dedupe, replaced objects KEPT so
 *    saved CVs never silently change, schema_pending degradation,
 *    owner-scoped reads, ownership-safe photo resolution).
 *
 * The route-level auth/status contract lives in
 * tests/auto-bewerb-profile-photo-route.test.ts (separate mock surface).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStudioDb, type StudioDb } from "./helpers-studio";

// The engine only talks to Postgres/Storage through createAdminClient().
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/email-providers", () => ({ createEmailProvider: vi.fn() }));
// Keep the real resolvePhotoDataUrl (data-URL passthrough + owner fetch);
// stub the native raster step onto its fallback (original validated bytes).
vi.mock("@/lib/auto-bewerb/profile-photo-process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auto-bewerb/profile-photo-process")>();
  return {
    ...actual,
    processProfilePhoto: vi.fn(async () => null),
  };
});

import { createAdminClient } from "@/lib/supabase/admin";
import {
  deleteAutoBewerbProfilePhoto,
  getAutoBewerbProfilePhoto,
  getAutoBewerbProfilePhotoRef,
  resolveAutoBewerbPhotoDataUrl,
  uploadAutoBewerbProfilePhoto,
  type AutoBewerbOpResult,
} from "@/lib/auto-bewerb/engine";
import {
  PROFILE_PHOTO_MAX_BYTES,
  buildPhotoRef,
  detectPhotoType,
  isPhotoRef,
  parsePhotoRef,
  photoExtMime,
  profilePhotoStoragePath,
  readImageDimensions,
  validateProfilePhoto,
} from "@/lib/auto-bewerb/profile-photo";
import { normalizeCvPhotoValue, sanitizeCvDocument, cvEmpty } from "@/lib/templates/cv";
import { AUTO_BEWERB_TABLES } from "@/lib/auto-bewerb/schema";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string) => readFileSync(resolve(root, relative), "utf8");

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "99999999-9999-4999-8999-999999999999";

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

/** Unwrap a successful op result (throws with the error code otherwise). */
function okValue<T>(res: AutoBewerbOpResult<T>): T {
  if (!res.ok) throw new Error(`expected ok, got ${res.code}`);
  return res.value as T;
}

/** Header-valid images with claimed dimensions (the dimension readers and
 *  the validator only parse the header; the stubbed processor keeps the
 *  original bytes, so no real decode is needed). */
function fakePng(width: number, height: number, padTo = 96): Buffer {
  const buf = Buffer.alloc(padTo, 0);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}
function fakeJpeg(width: number, height: number): Buffer {
  const buf = Buffer.alloc(48, 0);
  buf[0] = 0xff;
  buf[1] = 0xd8; // SOI
  buf[2] = 0xff;
  buf[3] = 0xe0; // APP0
  buf.writeUInt16BE(16, 4);
  buf.write("JFIF", 6, "ascii");
  buf[20] = 0xff;
  buf[21] = 0xc0; // SOF0
  buf.writeUInt16BE(17, 22);
  buf[24] = 8;
  buf.writeUInt16BE(height, 25);
  buf.writeUInt16BE(width, 27);
  return buf;
}
function fakeWebp(width: number, height: number): Buffer {
  const buf = Buffer.alloc(48, 0);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(30, 4);
  buf.write("WEBP", 8, "ascii");
  buf.write("VP8L", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf[20] = 0x2f;
  const bits = (((height - 1) & 0x3fff) << 14) | ((width - 1) & 0x3fff);
  buf.writeUInt32LE(bits, 21);
  return buf;
}

const TINY_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// ---------------------------------------------------------------------------
// Validation contract (magic bytes are the source of truth)
// ---------------------------------------------------------------------------

describe("photo validation — magic bytes, size, dimensions", () => {
  it("accepts PNG, JPEG and WEBP by their real header", () => {
    expect(detectPhotoType(fakePng(400, 400))).toBe("png");
    expect(detectPhotoType(fakeJpeg(600, 800))).toBe("jpeg");
    expect(detectPhotoType(fakeWebp(320, 400))).toBe("webp");
    expect(validateProfilePhoto(fakePng(400, 500))).toEqual({ ok: true, type: "png" });
    expect(validateProfilePhoto(fakeJpeg(600, 800))).toEqual({ ok: true, type: "jpeg" });
    expect(validateProfilePhoto(fakeWebp(320, 400))).toEqual({ ok: true, type: "webp" });
  });

  it("rejects non-image bytes (a renamed text file is not a photo)", () => {
    const res = validateProfilePhoto(Buffer.from("definitely not an image at all, just text"));
    expect(res).toEqual({ ok: false, code: "invalid_type" });
  });

  it("rejects empty uploads", () => {
    expect(validateProfilePhoto(Buffer.alloc(0))).toEqual({ ok: false, code: "empty" });
  });

  it("enforces the 5 MB raw-size cap", () => {
    const big = Buffer.alloc(PROFILE_PHOTO_MAX_BYTES + 1, 0);
    big.set(fakePng(400, 400));
    expect(validateProfilePhoto(big)).toEqual({ ok: false, code: "too_large" });
  });

  it("rejects images too small for print (min 300 px per side)", () => {
    expect(validateProfilePhoto(fakePng(1, 1))).toEqual({ ok: false, code: "too_small" });
    expect(validateProfilePhoto(fakePng(299, 900))).toEqual({ ok: false, code: "too_small" });
  });

  it("rejects pathologically high resolutions (decode memory bound)", () => {
    expect(validateProfilePhoto(fakePng(9000, 9000))).toEqual({ ok: false, code: "too_high_resolution" });
  });
});

describe("pure header dimension readers", () => {
  it("reads PNG IHDR dimensions", () => {
    expect(readImageDimensions(fakePng(640, 480), "png")).toEqual({ width: 640, height: 480 });
  });
  it("walks the JPEG marker chain to the SOF header", () => {
    expect(readImageDimensions(fakeJpeg(800, 600), "jpeg")).toEqual({ width: 800, height: 600 });
  });
  it("reads WebP VP8L dimensions", () => {
    expect(readImageDimensions(fakeWebp(400, 300), "webp")).toEqual({ width: 400, height: 300 });
  });
  it("returns null on garbage (the validator then accepts on size alone)", () => {
    expect(readImageDimensions(Buffer.alloc(64, 1), "png")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Frozen reference token + owner-scoped storage path
// ---------------------------------------------------------------------------

describe("frozen photo reference token (abphoto:v1)", () => {
  const hash = "a".repeat(64);

  it("builds + parses round-trips for every stored extension", () => {
    for (const ext of ["jpg", "png", "webp"] as const) {
      const ref = buildPhotoRef(hash, ext);
      expect(isPhotoRef(ref)).toBe(true);
      expect(parsePhotoRef(ref)).toEqual({ hash, ext });
    }
  });

  it("rejects everything that is not a well-formed server token", () => {
    const bad = [
      "https://evil.example/x.png", // client URL
      "https://storage.supabase.co/bucket/uid/photo.jpg", // signed/foreign URL
      "/files/photo.jpg", // path
      "../auto-bewerb/photo/other-user.jpg", // traversal-ish
      `abphoto:v1:${hash.slice(0, 60)}:png`, // truncated hash
      `abphoto:v1:${"g".repeat(64)}:png`, // non-hex hash
      `abphoto:v1:${hash}:gif`, // unsupported stored extension
      `abphoto:v1:${hash.toUpperCase()}:png`, // wrong case
      `abphoto:v2:${hash}:png`, // wrong version
      "abphoto:v1:" + hash + ":png:extra",
      42,
      null,
      undefined,
    ];
    for (const value of bad) {
      expect(parsePhotoRef(value), JSON.stringify(value)).toBeNull();
      expect(isPhotoRef(value), JSON.stringify(value)).toBe(false);
    }
  });

  it("storage path is always under the VERIFIED owner's folder", () => {
    expect(profilePhotoStoragePath(USER_A, hash, "png")).toBe(`${USER_A}/auto-bewerb/photo/${hash}.png`);
    expect(profilePhotoStoragePath(USER_B, hash, "jpg")).toBe(`${USER_B}/auto-bewerb/photo/${hash}.jpg`);
    expect(photoExtMime("jpg")).toBe("image/jpeg");
    expect(photoExtMime("png")).toBe("image/png");
    expect(photoExtMime("webp")).toBe("image/webp");
  });

  it("sanitizeCvDocument keeps only data URLs and server tokens as photo", () => {
    const ref = buildPhotoRef(hash, "png");
    const base = cvEmpty();

    const withRef = { ...base, personal: { ...base.personal, photo: ref } };
    expect(sanitizeCvDocument(withRef)?.personal.photo).toBe(ref);

    const withData = { ...base, personal: { ...base.personal, photo: TINY_DATA_URL } };
    expect(sanitizeCvDocument(withData)?.personal.photo).toBe(TINY_DATA_URL);

    const withUrl = { ...base, personal: { ...base.personal, photo: "https://evil.example/x.png" } };
    expect(sanitizeCvDocument(withUrl)?.personal.photo).toBeNull();

    const withPath = { ...base, personal: { ...base.personal, photo: "/bucket/other-user.jpg" } };
    expect(sanitizeCvDocument(withPath)?.personal.photo).toBeNull();

    expect(normalizeCvPhotoValue("abphoto:v1:" + "g".repeat(64) + ":png")).toBeNull();
    expect(normalizeCvPhotoValue("")).toBeNull();
    expect(normalizeCvPhotoValue({ a: 1 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Migration SQL contract (applied manually — NOT by this change)
// ---------------------------------------------------------------------------

describe("migration 20261216000000_auto_bewerb_profile_photo.sql", () => {
  const sql = read("supabase/migrations/20261216000000_auto_bewerb_profile_photo.sql");

  it("creates the owner-keyed table with the full value contract", () => {
    expect(sql).toContain("create table if not exists public.auto_bewerb_profile_photos");
    expect(sql).toContain("user_id uuid primary key references auth.users(id) on delete cascade");
    expect(sql).toContain("check (photo_mime_type in ('image/png', 'image/jpeg', 'image/webp'))");
    expect(sql).toContain("check (photo_size_bytes between 1 and 5242880)");
    expect(sql).toContain("char_length(photo_hash) = 64");
    expect(sql).toContain("create index if not exists auto_bewerb_profile_photos_user_id_idx");
  });

  it("is RLS-locked to owner SELECT with all client writes revoked", () => {
    expect(sql).toContain("alter table public.auto_bewerb_profile_photos enable row level security");
    expect(sql).toContain('drop policy if exists "auto_bewerb_profile_photos_owner_select"');
    expect(sql).toContain("create policy \"auto_bewerb_profile_photos_owner_select\"");
    expect(sql).toContain("on public.auto_bewerb_profile_photos for select to authenticated");
    expect(sql).toContain("using (auth.uid() = user_id)");
    expect(sql).toContain(
      "revoke insert, update, delete on public.auto_bewerb_profile_photos from anon, authenticated",
    );
  });

  it("adds image/webp to the PRIVATE bucket without dropping existing types", () => {
    expect(sql).toContain("insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)");
    expect(sql).toContain("values ('application-attachments', 'application-attachments', false, 10485760,");
    for (const mime of [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "image/png",
      "image/jpeg",
      "image/webp",
    ]) {
      expect(sql).toContain(`'${mime}'`);
    }
    expect(sql).toContain("on conflict (id) do update");
    expect(sql).toContain("set public = false");
  });

  it("is rerun-safe (drop-guarded trigger + policy) and leaves the 7-table workflow probe untouched", () => {
    expect(sql).toContain("drop trigger if exists auto_bewerb_profile_photos_set_updated_at");
    // The photo feature degrades on its OWN probe — the workflow tables list
    // must NOT gain the photo table (a pre-migration deploy must not break
    // the existing 7-table setup gate).
    expect(AUTO_BEWERB_TABLES).not.toContain("auto_bewerb_profile_photos");
    expect(AUTO_BEWERB_TABLES).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// Engine: upload / replace / delete / ownership (in-memory admin client)
// ---------------------------------------------------------------------------

describe("engine — photo upload, ownership and persistence", () => {
  let db: StudioDb;

  beforeEach(() => {
    db = createStudioDb({
      auto_bewerb_profile_photos: [],
      activity_logs: [],
    });
    (createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
  });

  it("uploads a valid photo to the owner's private folder and persists the row", async () => {
    const buffer = fakePng(400, 500);
    const res = await uploadAutoBewerbProfilePhoto(USER_A, buffer);
    expect(res.ok).toBe(true);
    const hash = sha256(buffer);
    expect(okValue(res).ref).toBe(buildPhotoRef(hash, "png"));
    expect(okValue(res).mime).toBe("image/png");
    // Exactly one object, under the VERIFIED owner prefix (private bucket).
    expect(db.uploaded).toEqual([
      { bucket: "application-attachments", path: `${USER_A}/auto-bewerb/photo/${hash}.png` },
    ]);
    const rows = db.tables.auto_bewerb_profile_photos;
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(USER_A);
    expect(rows[0].photo_hash).toBe(hash);
    expect(rows[0].photo_mime_type).toBe("image/png");
    expect(rows[0].photo_storage_path).toBe(`${USER_A}/auto-bewerb/photo/${hash}.png`);
    expect(rows[0].photo_size_bytes).toBe(buffer.length);
  });

  it("is idempotent per content hash (same photo → same object, one row)", async () => {
    const buffer = fakePng(400, 500);
    const first = await uploadAutoBewerbProfilePhoto(USER_A, buffer);
    const second = await uploadAutoBewerbProfilePhoto(USER_A, buffer);
    expect(first.ok && second.ok).toBe(true);
    expect(okValue(second).ref).toBe(okValue(first).ref);
    expect(db.tables.auto_bewerb_profile_photos).toHaveLength(1);
    // The same path is upserted (upsert: true) — no second object name.
    expect(new Set(db.uploaded.map((u) => u.path))).toHaveLength(1);
  });

  it("replacement stores the NEW object and NEVER deletes the old one (frozen CV references)", async () => {
    const old = await uploadAutoBewerbProfilePhoto(USER_A, fakePng(400, 500));
    const next = await uploadAutoBewerbProfilePhoto(USER_A, fakeJpeg(520, 640));
    expect(old.ok && next.ok).toBe(true);
    expect(okValue(next).ref).not.toBe(okValue(old).ref);
    expect(db.tables.auto_bewerb_profile_photos).toHaveLength(1);
    const hash = sha256(fakeJpeg(520, 640));
    expect(db.tables.auto_bewerb_profile_photos[0].photo_hash).toBe(hash);
    expect(db.tables.auto_bewerb_profile_photos[0].photo_mime_type).toBe("image/jpeg");
    // NO storage.remove call — previously generated CVs keep their frozen
    // hash reference and must never silently change.
    expect(db.calls.filter((c) => c.op === "storage" && "remove" in c.filters)).toHaveLength(0);
  });

  it("rejects non-image bytes BEFORE any storage write", async () => {
    const res = await uploadAutoBewerbProfilePhoto(USER_A, Buffer.from("not an image, just a note"));
    expect(res).toMatchObject({ ok: false, code: "invalid_file_type" });
    expect(db.uploaded).toHaveLength(0);
    expect(db.tables.auto_bewerb_profile_photos).toHaveLength(0);
  });

  it("rejects oversized uploads BEFORE any storage write (5 MB)", async () => {
    const big = Buffer.alloc(PROFILE_PHOTO_MAX_BYTES + 1, 0);
    big.set(fakePng(400, 400));
    const res = await uploadAutoBewerbProfilePhoto(USER_A, big);
    expect(res).toMatchObject({ ok: false, code: "file_too_large" });
    expect(db.uploaded).toHaveLength(0);
    expect(db.tables.auto_bewerb_profile_photos).toHaveLength(0);
  });

  it("deletes the CURRENT photo row but keeps the storage object", async () => {
    await uploadAutoBewerbProfilePhoto(USER_A, fakePng(400, 500));
    const res = await deleteAutoBewerbProfilePhoto(USER_A);
    expect(res.ok).toBe(true);
    expect(db.tables.auto_bewerb_profile_photos).toHaveLength(0);
    // Object kept: saved CVs hold the frozen reference.
    expect(db.calls.filter((c) => c.op === "storage" && "remove" in c.filters)).toHaveLength(0);
  });

  it("reads are owner-scoped (user B never receives user A's photo)", async () => {
    db.tables.auto_bewerb_profile_photos.push(
      {
        user_id: USER_A,
        photo_mime_type: "image/png",
        photo_size_bytes: 100,
        photo_hash: sha256(fakePng(400, 400)),
        photo_storage_path: `${USER_A}/auto-bewerb/photo/a.png`,
        uploaded_at: new Date().toISOString(),
      },
      {
        user_id: USER_B,
        photo_mime_type: "image/jpeg",
        photo_size_bytes: 100,
        photo_hash: sha256(fakeJpeg(400, 400)),
        photo_storage_path: `${USER_B}/auto-bewerb/photo/b.jpg`,
        uploaded_at: new Date().toISOString(),
      },
    );
    const rowA = await getAutoBewerbProfilePhoto(USER_A);
    const rowB = await getAutoBewerbProfilePhoto(USER_B);
    expect(rowA?.user_id).toBe(USER_A);
    expect(rowB?.user_id).toBe(USER_B);
    // JPEG row → .jpg token; PNG row → .png token.
    await (createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    expect(await getAutoBewerbProfilePhotoRef(USER_A)).toBe(`abphoto:v1:${sha256(fakePng(400, 400))}:png`);
    expect(await getAutoBewerbProfilePhotoRef(USER_B)).toBe(`abphoto:v1:${sha256(fakeJpeg(400, 400))}:jpg`);
  });

  it("returns no reference for a missing row or an unknown mime (workflow continues without a photo)", async () => {
    expect(await getAutoBewerbProfilePhotoRef(USER_A)).toBeNull();
    db.tables.auto_bewerb_profile_photos.push({
      user_id: USER_A,
      photo_mime_type: "image/tiff",
      photo_size_bytes: 100,
      photo_hash: "b".repeat(64),
      photo_storage_path: `${USER_A}/auto-bewerb/photo/x.tif`,
      uploaded_at: new Date().toISOString(),
    });
    expect(await getAutoBewerbProfilePhotoRef(USER_A)).toBeNull();
  });

  it("photo resolution is ownership-scoped and degrades to null — never fails", async () => {
    // Legacy inline data URLs pass through (≤ 8 MB cap).
    expect(await resolveAutoBewerbPhotoDataUrl(USER_A, TINY_DATA_URL)).toBe(TINY_DATA_URL);
    expect(await resolveAutoBewerbPhotoDataUrl(USER_A, null)).toBeNull();
    // Oversized data URL is dropped.
    const huge = `data:image/png;base64,${"A".repeat(8 * 1024 * 1024)}`;
    expect(await resolveAutoBewerbPhotoDataUrl(USER_A, huge)).toBeNull();
    // A well-formed token whose storage object is gone (the mock has no
    // download at all) resolves to null instead of throwing.
    const ref = buildPhotoRef(sha256(fakePng(400, 400)), "png");
    await expect(resolveAutoBewerbPhotoDataUrl(USER_A, ref)).resolves.toBeNull();
    // Malformed refs are rejected without a storage access.
    expect(await resolveAutoBewerbPhotoDataUrl(USER_A, "https://x.example/y.png")).toBeNull();
    expect(await resolveAutoBewerbPhotoDataUrl(USER_A, "abphoto:v1:zz")).toBeNull();
  });

  it("resolves a FROZEN token to the stored bytes with the correct MIME (owner-scoped download)", async () => {
    const buffer = fakePng(400, 500);
    await uploadAutoBewerbProfilePhoto(USER_A, buffer);
    const hash = sha256(buffer);
    const dataUrl = await resolveAutoBewerbPhotoDataUrl(USER_A, buildPhotoRef(hash, "png"));
    expect(dataUrl).toBe(`data:image/png;base64,${buffer.toString("base64")}`);
    // The storage path is built from the VERIFIED owner's id + the token's
    // content hash — the token itself carries no path to follow.
    const downloads = db.calls.filter((c) => c.op === "storage" && "download" in c.filters);
    expect(downloads).toHaveLength(1);
    expect(downloads[0].filters.download).toBe(`${USER_A}/auto-bewerb/photo/${hash}.png`);
  });

  it("user B can NOT resolve user A's frozen token (the path follows the SESSION owner)", async () => {
    const buffer = fakePng(400, 500);
    await uploadAutoBewerbProfilePhoto(USER_A, buffer);
    const ref = buildPhotoRef(sha256(buffer), "png");
    // Identical token, different verified owner → B's (empty) folder →
    // null. Cross-user access is impossible by construction.
    expect(await resolveAutoBewerbPhotoDataUrl(USER_B, ref)).toBeNull();
    const downloads = db.calls.filter((c) => c.op === "storage" && "download" in c.filters);
    expect(downloads.at(-1)?.filters.download).toBe(`${USER_B}/auto-bewerb/photo/${sha256(buffer)}.png`);
  });

  it("a document frozen WITHOUT a photo never picks up a later upload (null ref stays null)", async () => {
    await uploadAutoBewerbProfilePhoto(USER_A, fakePng(400, 500));
    // A CV saved before the upload holds photo: null — re-exporting it
    // must still render without a photograph (frozen semantics).
    expect(await resolveAutoBewerbPhotoDataUrl(USER_A, null)).toBeNull();
    // ...while the CURRENT-photo path (DB row → token, what the GET route
    // now uses for Step 1) resolves the new photo.
    const ref = await getAutoBewerbProfilePhotoRef(USER_A);
    expect(ref).not.toBeNull();
    expect(await resolveAutoBewerbPhotoDataUrl(USER_A, ref)).not.toBeNull();
  });

  it("degrades to schema_pending before the migration (own probe — workflow tables stay untouched)", async () => {
    // Fresh module instance (fresh probe caches) + a database where the
    // photo table does not exist yet.
    vi.resetModules();
    const adminMod = await import("@/lib/supabase/admin");
    const db2 = createStudioDb({ auto_bewerb_profile_photos: [] });
    db2.failTables(["auto_bewerb_profile_photos"]);
    (adminMod.createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(db2.admin);
    const engine = await import("@/lib/auto-bewerb/engine");

    const res = await engine.uploadAutoBewerbProfilePhoto(USER_A, fakePng(400, 400));
    expect(res).toMatchObject({ ok: false, code: "schema_pending" });
    expect(db2.uploaded).toHaveLength(0);
    expect(db2.tables.auto_bewerb_profile_photos).toHaveLength(0);

    const del = await engine.deleteAutoBewerbProfilePhoto(USER_A);
    expect(del).toMatchObject({ ok: false, code: "schema_pending" });
  });
});
