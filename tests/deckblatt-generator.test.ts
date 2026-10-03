import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { dirForLang, translate } from "@/lib/i18n/core";
import { dictionaries, SUPPORTED_LANGUAGES, type Dict } from "@/lib/i18n/dictionaries";
import {
  DECKBLATT_STYLES,
  buildDeckblattPrompt,
  selectDeckblattStyle,
} from "@/lib/deckblatt/styles";
import {
  DECKBLATT_FIELD_LIMITS,
  parseDeckblattForm,
  validateDeckblattForm,
  validateDeckblattPhotoDataUrl,
  validateDeckblattPhotoDimensions,
  validateDeckblattPhotoFile,
  type DeckblattForm,
} from "@/lib/deckblatt/validate";
import {
  coverFit,
  fitFontSize,
  nameDisplayLines,
} from "@/lib/deckblatt/render";

/**
 * AI Deckblatt Generator — feature guard suite (21 required scenarios +
 * invariants).
 *
 * Style of the project's other suites: pure-function tests for the logic
 * (validation, style selection, prompt building, layout math) and
 * source-contract tests for the wiring that only holds together as a
 * system (auth redirect, quota RPC flow, server-only key, print/PNG
 * exports, responsive layout, i18n parity, no sensitive logging).
 */
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (relative: string) => readFileSync(resolve(root, relative), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** All leaf key paths of a nested object (dictionary namespace parity). */
function keyPaths(node: unknown, prefix = ""): string[] {
  if (typeof node === "string") return [prefix];
  if (node && typeof node === "object") {
    return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
      keyPaths(value, prefix ? `${prefix}.${key}` : key),
    );
  }
  return [];
}

// ---------------------------------------------------------------------------
// 1. Auth — logged-in active users only, redirect to the EXISTING login
// ---------------------------------------------------------------------------

describe("auth", () => {
  const layout = read("src/app/deckblatt/layout.tsx");

  it("guards /deckblatt server-side and redirects to /login", () => {
    expect(layout).toContain('import { redirect } from "next/navigation"');
    expect(layout).toContain("getCurrentUserAndProfile()");
    // No user, no profile, or not active → the existing login page.
    expect(layout).toContain('!user || !profile || profile.account_status !== "active"');
    expect(layout).toContain('redirect("/login")');
  });

  it("reuses the global AppShell (no new header/nav system)", () => {
    expect(layout).toContain("<AppShell profile={profile} isPlatformOwner={isPlatformOwner}>");
    expect(layout).toContain('export const dynamic = "force-dynamic"');
  });
});

// ---------------------------------------------------------------------------
// 2. Form validation — client + server share ONE pure implementation
// ---------------------------------------------------------------------------

describe("form validation", () => {
  const valid: DeckblattForm = {
    firstName: "Max",
    lastName: "Mustermann",
    profession: "Kaufmann im E-Commerce",
    email: "max.mustermann@mail.de",
    phone: "+49 171 2345678",
    address: "Musterstraße 12, 50667 Köln",
  };

  it("accepts a complete, well-formed form", () => {
    expect(validateDeckblattForm(valid)).toEqual({});
  });

  it("flags every empty field as required", () => {
    const empty = validateDeckblattForm({
      firstName: "",
      lastName: "",
      profession: "",
      email: "",
      phone: "",
      address: "",
    });
    for (const key of Object.keys(DECKBLATT_FIELD_LIMITS)) {
      expect(empty[key as keyof DeckblattForm]).toBe("required");
    }
  });

  it("rejects invalid email and phone formats (but not required)", () => {
    const errors = validateDeckblattForm({ ...valid, email: "not-an-email", phone: "abc" });
    expect(errors.email).toBe("invalidEmail");
    expect(errors.phone).toBe("invalidPhone");
    expect(errors.firstName).toBeUndefined();
  });

  it("clamps input lengths server-side via parseDeckblattForm", () => {
    const parsed = parseDeckblattForm({
      ...valid,
      firstName: "x".repeat(DECKBLATT_FIELD_LIMITS.firstName + 50),
      email: "a".repeat(DECKBLATT_FIELD_LIMITS.email + 5) + "@b.de",
    });
    expect(parsed.firstName).toHaveLength(DECKBLATT_FIELD_LIMITS.firstName);
    expect(parsed.email).toHaveLength(DECKBLATT_FIELD_LIMITS.email);
    // Malformed bodies never throw.
    expect(parseDeckblattForm(null).firstName).toBe("");
    expect(parseDeckblattForm(42).firstName).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 3. Photo validation — MIME, size, dimensions
// ---------------------------------------------------------------------------

describe("photo validation", () => {
  it("accepts png/jpeg/webp within the size and dimension bands", () => {
    expect(validateDeckblattPhotoFile({ type: "image/png", size: 100 })).toBeNull();
    expect(validateDeckblattPhotoFile({ type: "image/jpeg", size: 100 })).toBeNull();
    expect(validateDeckblattPhotoFile({ type: "image/webp", size: 100 })).toBeNull();
    expect(validateDeckblattPhotoDimensions(1200, 1600)).toBeNull();
  });

  it("rejects other MIME types and oversized files", () => {
    expect(validateDeckblattPhotoFile({ type: "image/gif", size: 100 })).toBe("invalidType");
    expect(validateDeckblattPhotoFile({ type: "text/plain", size: 100 })).toBe("invalidType");
    expect(validateDeckblattPhotoFile({ type: "image/png", size: 10 * 1024 * 1024 + 1 })).toBe(
      "tooLarge",
    );
  });

  it("rejects photos below the print legibility minimum or above the max edge", () => {
    expect(validateDeckblattPhotoDimensions(299, 400)).toBe("tooSmall");
    expect(validateDeckblattPhotoDimensions(300, 400)).toBeNull();
    expect(validateDeckblattPhotoDimensions(100, 4001)).toBe("tooLarge");
    expect(validateDeckblattPhotoDimensions(0, 0)).toBe("readError");
    expect(validateDeckblattPhotoDimensions(NaN, 400)).toBe("readError");
  });
});

// ---------------------------------------------------------------------------
// 4. Pollinations route — server-side only, quota-gated, real states
// ---------------------------------------------------------------------------

describe("pollinations integration (route + provider)", () => {
  const route = read("src/app/api/deckblatt/generate/route.ts");
  const provider = read("src/lib/deckblatt/pollinations.ts");
  const generator = read("src/components/deckblatt-generator.tsx");

  it("the browser only talks to /api/deckblatt/generate — never to pollinations.ai", () => {
    expect(route).toContain('export async function POST(request: Request)');
    expect(generator).toContain('fetch("/api/deckblatt/generate"');
    expect(generator.toLowerCase()).not.toContain("pollinations.ai");
  });

  it("the provider call happens server-side with openai/gpt-image-2 (edits endpoint)", () => {
    // GPT Image 2 via the OpenAI-compatible /v1/images/edits endpoint —
    // flux is NOT the production model anywhere in the deckblatt path.
    expect(provider).toContain("https://gen.pollinations.ai/v1/images/edits");
    expect(provider).toContain('const POLLINATIONS_MODEL = "openai/gpt-image-2"');
    expect(provider).not.toContain('"flux"');
    expect(route).toContain("generateDeckblattDesign(prompt, photo)");
    // OpenAI-compatible request/response contract.
    expect(provider).toContain('method: "POST"');
    expect(provider).toContain('response_format: "b64_json"');
    expect(provider).toContain('size: POLLINATIONS_SIZE');
    expect(provider).toContain('quality: POLLINATIONS_QUALITY');
  });

  it("the flow is auth → rate limit → validate (form + photo) → reserve → provider → complete/release", () => {
    // Order of the main flow in the route source.
    const order = [
      "getCurrentUserAndProfile()",
      'checkRateLimit("deckblatt_generate", user.id)',
      "validateDeckblattForm(form)",
      "validateDeckblattPhotoDataUrl(photo)",
      "reserveDeckblattGeneration(runId)",
      "generateDeckblattDesign(prompt, photo)",
      "completeDeckblattGeneration(runId)",
      "releaseDeckblattGeneration(runId)",
    ];
    let last = -1;
    for (const marker of order) {
      const idx = route.indexOf(marker);
      expect(idx, `missing or out of order: ${marker}`).toBeGreaterThan(last);
      last = idx;
    }
  });

  it("returns the design as a data URL plus the fresh quota state", () => {
    expect(route).toContain("data:image/png;base64,${designBase64}");
    expect(route).toContain("usage: { used: reservation.used, remaining: reservation.remaining }");
  });

  it("the provider classifies errors and only retries transient ones", () => {
    expect(provider).toContain("provider_unauthorized");
    expect(provider).toContain("provider_rate_limited");
    expect(provider).toContain("provider_unavailable");
    expect(provider).toContain("provider_bad_request");
    expect(provider).toContain("provider_content_blocked");
    expect(provider).toContain("provider_invalid_image");
    // 401/403, 400 and malformed 200s are NEVER retried; only 429/5xx/
    // timeout are retried once.
    expect(provider).toContain("if (!isTransient(error.code) || attempt === 2) break;");
    expect(provider).toContain("for (let attempt = 1; attempt <= 2; attempt++)");
    expect(provider).toContain("return code === \"provider_rate_limited\" || code === \"provider_unavailable\";");
  });

  it("a safety-blocked photo surfaces a specific error (and the quota is refunded)", () => {
    expect(route).toContain('error.code === "provider_content_blocked"');
    expect(route).toContain('"provider_content_blocked"');
    // Every failed generation — including 400-class — releases the quota.
    const catchIdx = route.indexOf("} catch (error) {");
    expect(catchIdx).toBeGreaterThan(-1);
    expect(route.slice(catchIdx)).toContain("releaseDeckblattGeneration(runId)");
  });
});

// ---------------------------------------------------------------------------
// 4b. Photo as AI image input — GPT Image 2 portrait integration
// ---------------------------------------------------------------------------

describe("photo as AI image input", () => {
  const route = read("src/app/api/deckblatt/generate/route.ts");
  const provider = read("src/lib/deckblatt/pollinations.ts");
  const generator = read("src/components/deckblatt-generator.tsx");

  it("the portrait travels to the model as image_url (data URI) in the edits body", () => {
    expect(provider).toContain("image: [{ image_url: portraitDataUrl }]");
    expect(route).toContain("generateDeckblattDesign(prompt, photo)");
    // The client encodes the prepared photo into a data URL for the request.
    expect(generator).toContain("photoUrlToDataUrl(photo.url)");
    expect(generator).toContain("photo: photoDataUrl");
  });

  it("the server validates the photo payload (strict data-URL shape + byte cap)", () => {
    expect(route).toContain("validateDeckblattPhotoDataUrl(photo)");
    expect(route).toContain('code: "validation", photo: photoError');
    expect(validateDeckblattPhotoDataUrl(`data:image/jpeg;base64,${"A".repeat(1000)}`)).toBeNull();
    expect(validateDeckblattPhotoDataUrl(`data:image/png;base64,${"A".repeat(1000)}`)).toBeNull();
    expect(validateDeckblattPhotoDataUrl("data:image/gif;base64,AAA=")).toBe("invalidFormat");
    expect(validateDeckblattPhotoDataUrl("data:text/plain;base64,AAA=")).toBe("invalidFormat");
    expect(validateDeckblattPhotoDataUrl("not-a-data-url")).toBe("invalidFormat");
    expect(validateDeckblattPhotoDataUrl("")).toBe("invalidFormat");
    expect(validateDeckblattPhotoDataUrl(42 as unknown as string)).toBe("invalidFormat");
    // Above the 4 MiB DECODED cap → tooLarge (base64 chars ≈ decoded × 4/3,
    // so 6 MiB of chars ≈ 4.5 MiB decoded).
    expect(
      validateDeckblattPhotoDataUrl(`data:image/png;base64,${"A".repeat(6 * 1024 * 1024)}`),
    ).toBe("tooLarge");
  });

  it("the prompt binds the model to the SAME person, identity-preserving", () => {
    const provider2 = provider;
    expect(provider2).toContain("portraitDataUrl");
    const prompt = buildDeckblattPrompt(DECKBLATT_STYLES.modern, "Kaufmann im E-Commerce");
    expect(prompt).toContain("SAME person");
    expect(prompt).toContain("Do not transform the person's identity.");
    expect(prompt).toContain("Do not create a different person.");
    expect(prompt).toContain("Do not add unrelated people.");
    expect(prompt).toContain("recognizable and natural");
  });
});

// ---------------------------------------------------------------------------
// 5. API key — server-only, never in the browser bundle, never logged
// ---------------------------------------------------------------------------

describe("api key is server-only", () => {
  it("POLLINATIONS_API_KEY appears ONLY in the server-side provider module", () => {
    const offenders: string[] = [];
    for (const file of walk(resolve(root, "src"))) {
      const text = readFileSync(file, "utf8");
      if (text.includes("POLLINATIONS_API_KEY") && !file.includes("deckblatt/pollinations.ts")) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no NEXT_PUBLIC_ prefixed key and the provider imports server-only", () => {
    for (const file of walk(resolve(root, "src"))) {
      expect(readFileSync(file, "utf8")).not.toContain("NEXT_PUBLIC_POLLINATIONS");
    }
    expect(read("src/lib/deckblatt/pollinations.ts")).toContain('import "server-only";');
    expect(read("src/lib/deckblatt/usage.ts")).toContain('import "server-only";');
    expect(read("src/app/api/deckblatt/generate/route.ts")).toContain('import "server-only";');
  });

  it("the key is used only in the Bearer header — never in URL, body or query", () => {
    const provider = read("src/lib/deckblatt/pollinations.ts");
    expect(provider).toContain("Authorization: `Bearer ${apiKey}`");
    // The request body is built from prompt + portrait only; the key must
    // not appear anywhere near the body construction.
    const bodyIdx = provider.indexOf("const body: ImageEditBody = {");
    expect(bodyIdx).toBeGreaterThan(-1);
    const bodyBlock = provider.slice(bodyIdx, provider.indexOf("};", bodyIdx) + 2);
    expect(bodyBlock).not.toContain("apiKey");
    // The endpoint URL is a static constant without any key interpolation.
    const urlLine = provider.split("\n").find((l) => l.includes("POLLINATIONS_EDITS_URL ="));
    expect(urlLine).toBeDefined();
    expect(urlLine).not.toContain("apiKey");
    // No query-string key fallback (?key=...) either.
    expect(provider).not.toContain("?key=");
  });
});

// ---------------------------------------------------------------------------
// 6-11. Daily quota (2/day) — atomic, idempotent, refunding, date-keyed
// ---------------------------------------------------------------------------

describe("daily quota (2 per UTC day, server-enforced)", () => {
  const migration = read("supabase/migrations/20261020000000_deckblatt_usage.sql");
  const route = read("src/app/api/deckblatt/generate/route.ts");

  it("1st generation → used=1 (fresh row with generations_used 1)", () => {
    expect(migration).toContain("insert into public.ai_deckblatt_usage (user_id, usage_date, generations_used)");
    expect(migration).toContain("values (target_user_id, today, 1)");
    expect(migration).toContain("select 'reserved'::text, new_used, 2 - new_used");
  });

  it("2nd generation → used=2 (conditional increment on the existing row)", () => {
    expect(migration).toContain("on conflict (user_id, usage_date) do update");
    expect(migration).toContain("set generations_used = ai_deckblatt_usage.generations_used + 1");
  });

  it("3rd generation → rejected with quota_exhausted and NOTHING charged", () => {
    // The conditional upsert is the gate: at the limit it updates no row.
    expect(migration).toContain("where ai_deckblatt_usage.generations_used < 2");
    // …and the no-op path deletes the ledger row + reports exhaustion.
    expect(migration).toContain("delete from public.ai_deckblatt_runs where run_id = p_run_id;");
    expect(migration).toContain("select 'quota_exhausted'::text, 2, 0;");
    // The route surfaces that to the client as an explicit error code.
    expect(route).toContain('code: "quota_exhausted"');
    expect(route).toContain("{ status: 403 }");
  });

  it("a FAILED generation restores the quota (release, idempotent)", () => {
    // Route: the catch block releases the reservation.
    const catchIdx = route.indexOf("} catch (error) {");
    expect(catchIdx).toBeGreaterThan(-1);
    expect(route.slice(catchIdx)).toContain("releaseDeckblattGeneration(runId)");
    // Migration: only runs still 'reserved' are refunded — successes and
    // unknown runs are no-ops (a double release cannot refund twice).
    expect(migration).toContain("if run_row is null or run_row.status <> 'reserved' then");
    expect(migration).toContain("select 'no_op'::text, cur_used, 2 - cur_used;");
    expect(migration).toContain("set generations_used = greatest(u.generations_used - 1, 0)");
    expect(migration).toContain("set status = 'failed'");
  });

  it("concurrent requests cannot exceed the limit (lock + conditional upsert)", () => {
    // Row lock serializes racing reserves (FOR UPDATE on today's row).
    expect(migration).toContain("for update");
    // Exactly one of N racing upserts can pass the WHERE < 2 guard.
    expect(migration).toContain("where ai_deckblatt_usage.generations_used < 2");
    // Idempotency: the same run_id can never be reserved twice.
    expect(migration).toContain("select 'already_reserved'::text, new_used, 2 - new_used;");
    expect(route).toContain('code: "already_running"');
    // RLS: direct INSERT/UPDATE from the client are impossible (no write
    // policy exists — only SELECT own rows).
    expect(migration).toContain("alter table public.ai_deckblatt_usage enable row level security;");
    expect(migration).toContain("on public.ai_deckblatt_usage for select");
    expect(migration).not.toContain("on public.ai_deckblatt_usage for insert");
    expect(migration).not.toContain("on public.ai_deckblatt_usage for update");
  });

  it("a new UTC day resets naturally (date-keyed rows, no delete needed)", () => {
    // Usage is keyed per calendar day (UTC) — a new day is a new row.
    expect(migration).toContain("constraint ai_deckblatt_usage_user_date_unique");
    expect(migration).toContain("unique (user_id, usage_date)");
    expect(migration).toContain("today date := (now() at time zone 'utc')::date;");
    // Status reads only TODAY's row (yesterday's rows are untouched).
    expect(migration).toContain("and u.usage_date = (now() at time zone 'utc')::date");
  });
});

// ---------------------------------------------------------------------------
// 12-15. i18n — all four dictionaries complete, no hardcoded strings
// ---------------------------------------------------------------------------

describe("i18n dictionaries (de/en/fr/ar)", () => {
  const deBlock = (dictionaries.de as unknown as { deckblatt: unknown }).deckblatt;
  const dePaths = keyPaths(deBlock);

  it("has a non-trivial deckblatt namespace in German", () => {
    expect(dePaths.length).toBeGreaterThanOrEqual(50);
  });

  for (const lang of SUPPORTED_LANGUAGES) {
    it(`${lang}: every key exists with the same structure as de`, () => {
      const dict = dictionaries[lang] as unknown as { deckblatt: unknown };
      const langPaths = new Set(keyPaths(dict.deckblatt));
      expect(langPaths.size).toBe(new Set(dePaths).size);
      for (const path of dePaths) expect(langPaths.has(path), `missing deckblatt.${path} in ${lang}`).toBe(true);
      // Every German leaf resolves to a non-empty, non-raw-key string.
      for (const path of dePaths) {
        const value = translate(lang, `deckblatt.${path}`);
        expect(value.length > 0, `empty translation deckblatt.${path} (${lang})`).toBe(true);
        expect(value).not.toBe(`deckblatt.${path}`);
      }
    });
  }

  it("de: the brief's exact user-facing strings", () => {
    expect(translate("de", "deckblatt.previewPlaceholderTitle")).toBe("Dein Deckblatt erscheint hier");
    expect(translate("de", "deckblatt.errorQuota")).toBe(
      "Du hast deine 2 kostenlosen Designs für heute verwendet.",
    );
    expect(translate("de", "deckblatt.generate")).toBe("Deckblatt erstellen");
    expect(translate("de", "deckblatt.usageAvailable", { n: 2 })).toBe("2 von 2 Designs heute verfügbar");
    expect(translate("de", "deckblatt.usageAvailable", { n: 1 })).toBe("1 von 2 Designs heute verfügbar");
    expect(translate("de", "deckblatt.usageAvailable", { n: 0 })).toBe("0 von 2 Designs heute verfügbar");
  });

  it("de: the four real generation states (no fake progress copy)", () => {
    expect(translate("de", "deckblatt.statePreparing")).toBe("Profil wird vorbereitet");
    expect(translate("de", "deckblatt.stateGenerating")).toBe("Design wird generiert");
    expect(translate("de", "deckblatt.stateFinalizing")).toBe("Deckblatt wird finalisiert");
    expect(translate("de", "deckblatt.stateWorking")).toContain("wird erstellt");
  });

  it("nav + page heading keys exist in all four languages", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(translate(lang, "nav.deckblatt").length).toBeGreaterThan(0);
      expect(translate(lang, "pages.deckblatt.title").length).toBeGreaterThan(0);
      expect(translate(lang, "pages.deckblatt.subtitle").length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 16. RTL — Arabic flips the app, the German document stays LTR
// ---------------------------------------------------------------------------

describe("rtl (arabic)", () => {
  it("ar resolves to rtl and the i18n provider applies <html dir>", () => {
    expect(dirForLang("ar")).toBe("rtl");
    expect(dirForLang("de")).toBe("ltr");
    const provider = read("src/lib/i18n/index.tsx");
    expect(provider).toContain("document.documentElement.dir = dir;");
  });

  it("the Deckblatt sheet is always LTR (a German document in an RTL app)", () => {
    const sheet = read("src/components/deckblatt-sheet.tsx");
    expect(sheet).toContain('dir="ltr"');
  });

  it("no raw deckblatt text is hardcoded in the component (all via t())", () => {
    const generator = read("src/components/deckblatt-generator.tsx");
    // The only German allowed in the component is placeholder PROSE that
    // ships translated; assert the key strings never appear as literals.
    expect(generator).not.toContain("Dein Deckblatt erscheint hier");
    expect(generator).not.toContain("Deckblatt erstellen");
    expect(generator).not.toContain("PDF herunterladen");
    // And the t() calls actually reference the namespace.
    expect(generator).toContain('t("deckblatt.title")');
    expect(generator).toContain('t("deckblatt.generate")');
  });
});

// ---------------------------------------------------------------------------
// 17. PDF export — print portal, A4, app shell suppressed
// ---------------------------------------------------------------------------

describe("pdf export (print portal)", () => {
  const generator = read("src/components/deckblatt-generator.tsx");
  const globals = read("src/app/globals.css");

  it("the printable sheet is portaled onto <body> outside the shell", () => {
    expect(generator).toContain('import { createPortal } from "react-dom"');
    expect(generator).toContain('<div className="deckblatt-print-root" aria-hidden="true">');
    expect(generator).toContain("document.body");
  });

  it("the print scope is active only while the generator is mounted", () => {
    expect(generator).toContain('document.body.classList.add("deckblatt-print-active")');
    expect(generator).toContain('document.body.classList.remove("deckblatt-print-active")');
  });

  it("window.print() is the trigger and globals.css scopes the A4 page", () => {
    expect(generator).toContain("window.print()");
    expect(globals).toContain(".deckblatt-print-root {\n  display: none;\n}");
    const printBlock = globals.slice(globals.indexOf(".deckblatt-print-root {"));
    expect(printBlock).toContain("size: A4;");
    expect(printBlock).toContain("body.deckblatt-print-active .app-shell-root {\n    display: none !important;\n  }");
    expect(printBlock).toContain("body.deckblatt-print-active .deckblatt-print-root {\n    display: block !important;\n  }");
    // 1240px design width → 210mm print width (scale ≈ 0.64).
    expect(printBlock).toContain(".deckblatt-print-root .deckblatt-sheet {\n    width: 210mm !important;\n    height: 297mm !important;");
    expect(printBlock).toContain("transform: scale(0.64) !important;");
    // The AI background colors must survive the browser's print filters.
    expect(printBlock).toContain("print-color-adjust: exact !important;");
  });
});

// ---------------------------------------------------------------------------
// 18. PNG export — local canvas renderer at A4 design resolution
// ---------------------------------------------------------------------------

describe("png export (canvas renderer)", () => {
  const renderer = read("src/lib/deckblatt/render.ts");
  const generator = read("src/components/deckblatt-generator.tsx");

  it("renders at the A4 design resolution and encodes a real PNG", () => {
    expect(renderer).toContain("canvas.width = DECKBLATT_WIDTH;");
    expect(renderer).toContain("canvas.height = DECKBLATT_HEIGHT;");
    expect(renderer).toContain('canvas.toDataURL("image/png")');
  });

  it("composites the EXACT user data (name, contact, photo) onto the design", () => {
    // Drawing order: background → band → divider → photo → name →
    // profession → contact.
    // Markers chosen to occur only in the FUNCTION BODY (the import list
    // would shadow the first occurrence of the bare function names).
    const order = [
      "ctx.drawImage(background",
      "if (L.band) {",
      "ctx.fillRect(L.divider.x",
      "ctx.drawImage(\n    photo",
      "const nameLines = nameDisplayLines(data)",
      "contactDisplayLines(data).forEach",
    ];
    let last = -1;
    for (const marker of order) {
      const idx = renderer.indexOf(marker);
      expect(idx, `missing draw step: ${marker}`).toBeGreaterThan(last);
      last = idx;
    }
  });

  it("the generator downloads the PNG with a name-based filename", () => {
    expect(generator).toContain("renderDeckblattPng({");
    expect(generator).toContain("deckblatt-${safeName}.png");
  });

  it("the layout math is deterministic (cover fit, name breaks, font fit)", () => {
    // 4:3 source into a 2:3 (portrait) frame → the FULL source height is
    // kept, the width is cropped symmetrically (centered).
    const fit = coverFit(400, 300, 1240, 1754);
    expect(fit.sh).toBeCloseTo(300, 5);
    expect(fit.sy).toBeCloseTo(0, 5);
    expect(fit.sw).toBeCloseTo(1240 / (1754 / 300), 5);
    expect(fit.sx).toBeGreaterThan(0);
    // 4:3 photo into the 224×296 photo frame → full height kept, centered
    // horizontal crop.
    const fit2 = coverFit(1200, 900, 224, 296);
    expect(fit2.sh).toBeCloseTo(900, 5);
    expect(fit2.sy).toBeCloseTo(0, 5);
    expect(fit2.sx).toBeGreaterThan(0);
    // Name breaks are character-count based (same in canvas + HTML).
    expect(nameDisplayLines({ ...dataFixture(), firstName: "Max", lastName: "Mustermann" })).toEqual(["Max Mustermann"]);
    expect(
      nameDisplayLines({ ...dataFixture(), firstName: "Maximilian-Alexander", lastName: "Mustermann-von-Berg" }),
    ).toHaveLength(2);
    // fitFontSize shrinks long lines and never grows short ones.
    expect(fitFontSize("Kaufmann", 640, 92, true)).toBe(92);
    expect(fitFontSize("K".repeat(60), 640, 92, true)).toBeLessThan(92);
  });
});

function dataFixture() {
  return {
    firstName: "Max",
    lastName: "Mustermann",
    profession: "Kaufmann im E-Commerce",
    email: "max@beispiel.de",
    phone: "+49 171 2345678",
    address: "Musterstraße 12, 50667 Köln",
  };
}

// ---------------------------------------------------------------------------
// 19. No sensitive logging / no data leak into the prompt
// ---------------------------------------------------------------------------

describe("security: no sensitive logging, no personal data in the prompt", () => {
  const route = read("src/app/api/deckblatt/generate/route.ts");
  const provider = read("src/lib/deckblatt/pollinations.ts");
  const usage = read("src/lib/deckblatt/usage.ts");

  it("server log lines never contain personal fields or the api key", () => {
    const sensitive = ["email", "phone", "address", "firstName", "lastName", "POLLINATIONS_API_KEY", "apiKey", "Bearer"];
    for (const file of [route, provider, usage]) {
      for (const line of file.split("\n")) {
        if (!line.includes("console.")) continue;
        for (const token of sensitive) {
          expect(line, `sensitive token "${token}" in log line: ${line}`).not.toContain(token);
        }
      }
    }
  });

  it("the image prompt contains no personal data and enforces the GPT Image 2 contract", () => {
    const style = DECKBLATT_STYLES.modern;
    const prompt = buildDeckblattPrompt(style, "Kaufmann im E-Commerce");
    // The distinctive fixtures never enter the prompt.
    for (const token of ["Max", "Mustermann", "max@beispiel.de", "+49", "Musterstraße"]) {
      expect(prompt).not.toContain(token);
    }
    // The profession enters as context; the exact applicant text is
    // explicitly carved out to the local renderer.
    expect(prompt).toContain("Profession:");
    expect(prompt).toContain("Kaufmann im E-Commerce");
    expect(prompt).toContain("The exact applicant text will be rendered separately by the application.");
    // Hard "no invented / no readable text" constraints are always present.
    expect(prompt).toContain("CRITICAL:");
    expect(prompt).toContain("Do not invent contact information.");
    expect(prompt).toContain("Do not invent phone numbers.");
    expect(prompt).toContain("Do not invent email addresses.");
    expect(prompt).toContain("Do not render any readable text, letters, words, numbers or contact details anywhere in the image.");
    // Identity preservation (the portrait is the model's image input).
    expect(prompt).toContain("SAME person");
    expect(prompt).toContain("Do not transform the person's identity.");
    // A4 + printing context.
    expect(prompt).toContain("A4 portrait composition");
    expect(prompt).toContain("suitable for printing");
    // The profession sanitizer still strips special characters (parens,
    // dots) but keeps letters, digits, & and '-.
    const sanitized = buildDeckblattPrompt(style, "Entwickler (IT) & Co.");
    expect(sanitized).not.toContain("(IT)");
    expect(sanitized.replace(/\s+/g, " ")).toContain("Entwickler IT & Co");
  });

  it("all six style prompts are text-free composition directions (portrait + A4)", () => {
    for (const style of Object.values(DECKBLATT_STYLES)) {
      expect(style.designPrompt.toLowerCase()).toContain("a4 portrait");
      expect(style.designPrompt.toLowerCase()).toContain("portrait");
      // The style direction is embedded verbatim into the final prompt.
      expect(buildDeckblattPrompt(style, "Auszubildender")).toContain(style.designPrompt);
    }
  });
});

// ---------------------------------------------------------------------------
// 20-21. Responsive layout — mobile single column, desktop two columns
// ---------------------------------------------------------------------------

describe("responsive layout", () => {
  const generator = read("src/components/deckblatt-generator.tsx");

  it("mobile: single column in the brief's order (form → photo → style → generate → preview)", () => {
    // No grid below lg (single stacked column by default).
    expect(generator).toContain('className="grid gap-8 lg:grid-cols-[minmax(0,460px)_minmax(0,1fr)] lg:items-start"');
    // Document order: form card, photo card, style card, generate button,
    // then the preview column (preview shows the generation states on mobile).
    const formIdx = generator.indexOf('t("deckblatt.formTitle")');
    const photoIdx = generator.indexOf('t("deckblatt.photoTitle")');
    const styleIdx = generator.indexOf('t("deckblatt.styleTitle")');
    const genIdx = generator.indexOf('t("deckblatt.generate")');
    const previewIdx = generator.indexOf("Preview column");
    expect(formIdx).toBeLessThan(photoIdx);
    expect(photoIdx).toBeLessThan(styleIdx);
    expect(styleIdx).toBeLessThan(genIdx);
    expect(genIdx).toBeLessThan(previewIdx);
  });

  it("mobile: nothing overflows 320px (min-w-0 columns, scaled preview, hidden overflow)", () => {
    expect(generator).toContain("mx-auto w-full max-w-6xl");
    expect(generator).toContain('className="min-w-0 space-y-6"');
    expect(generator).toContain('className="min-w-0" dir="ltr"');
    // The A4 preview scales to fit the available width (never overflows).
    expect(generator).toContain("useScaledSheet(previewOuterRef, previewSheetRef");
    expect(generator).toContain("sheetWidth: DECKBLATT_WIDTH");
    expect(generator).toContain("transform: `scale(${preview.scale})`");
    // The placeholder keeps the A4 ratio on any width.
    expect(generator).toContain("aspect-[210/297]");
  });

  it("desktop: two columns (form | preview) beside the existing sidebar", () => {
    expect(generator).toContain("lg:grid-cols-[minmax(0,460px)_minmax(0,1fr)]");
    // The shell is untouched: the nav item joins the existing model.
    const shell = read("src/components/app-shell.tsx");
    expect(shell).toContain('{ labelKey: "nav.deckblatt", href: "/deckblatt", icon: "image" }');
    expect(shell).toContain('titleKey: "pages.deckblatt.title", subtitleKey: "pages.deckblatt.subtitle"');
  });
});

// ---------------------------------------------------------------------------
// Invariants: style selection, nav item, generation states, no fake progress
// ---------------------------------------------------------------------------

describe("feature invariants", () => {
  it("exactly six design variations exist, deterministically selectable", () => {
    expect(Object.keys(DECKBLATT_STYLES)).toHaveLength(6);
    // E-Commerce is an IT-domain profession → digital design direction.
    expect(selectDeckblattStyle("Kaufmann im E-Commerce").id).toBe("digital");
    expect(selectDeckblattStyle("Fachinformatiker für Anwendungsentwicklung").id).toBe("digital");
    expect(selectDeckblattStyle("Mechatroniker").id).toBe("technical");
    // German compounds must be matched without strict left boundaries.
    expect(selectDeckblattStyle("Kaufmann für Büromanagement").id).toBe("corporate");
    expect(selectDeckblattStyle("Steuerfachangestellte").id).toBe("classic");
    expect(selectDeckblattStyle("Grafik-Designer").id).toBe("minimal");
    // Unknown professions fall back to modern (stable, no randomness).
    expect(selectDeckblattStyle("Ausbildungsplatz unbekannt 123").id).toBe("modern");
  });

  it("the nav item exists with a lucide icon and an i18n label", () => {
    const shell = read("src/components/app-shell.tsx");
    expect(shell).toContain('icon: "image"');
    const generator = read("src/components/deckblatt-generator.tsx");
    // Real states only — the UI cycles preparing → generating → finalizing.
    expect(generator).toContain('"preparing" | "generating" | "finalizing"');
    expect(generator).toContain('setPhase("preparing")');
    expect(generator).toContain('setPhase("generating")');
    expect(generator).toContain('setPhase("finalizing")');
    // No fake progress: no percentage, no progress bar element.
    expect(generator).not.toContain("percent");
    expect(generator).not.toContain("ProgressBar");
    expect(generator).not.toContain("w-[50%]");
  });

  it("every i18n namespace added by the feature is flat-string leaves only", () => {
    // Guard against the old "nested under nav" bug class: the deckblatt
    // namespace leaves are all strings (the style sub-block excepted).
    const deDict = dictionaries.de as Dict & { deckblatt: Record<string, unknown> };
    for (const [key, value] of Object.entries(deDict.deckblatt)) {
      if (key === "style") {
        expect(typeof value).toBe("object");
        for (const sub of Object.values(value as Record<string, unknown>)) {
          expect(typeof sub).toBe("string");
        }
      } else {
        expect(typeof value, `deckblatt.${key} must be a string`).toBe("string");
      }
    }
  });
});
