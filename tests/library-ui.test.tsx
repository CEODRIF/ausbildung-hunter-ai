// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Deutsch Bibliothek — UI behavior (jsdom, real German dictionary).
 *
 * The server-side contract (authz, validation, write path) is covered by
 * library-admin-actions.test.ts + library-public-reads.test.ts; this suite
 * pins what the user actually sees and can trigger:
 *
 *   1. Delete is TWO-STEP: the first click opens an inline confirmation
 *      naming the book; cancel sends nothing; confirming sends EXACTLY ONE
 *      delete call with the right book id (busy guard blocks repeats).
 *   2. Publish/unpublish fires the right (id, published) pair.
 *   3. The form's client validation blocks submissions with a missing
 *      cover or a non-http(s) URL (no round-trip), and a valid submit
 *      carries the documented fields (incl. the cover File).
 *   4. Server error codes render as translated messages (never raw keys).
 *   5. Source invariants: the external download URL never reaches the
 *      client payload (quota-gated action result only, opened in a fresh,
 *      unassociated tab), the page never imports the admin surface; the
 *      nav integration exists.
 */

const { dictionaries } = await import("@/lib/i18n/dictionaries");

const makeT = () => (key: string, params?: Record<string, unknown>) => {
  let cur: unknown = dictionaries.de;
  for (const part of key.split(".")) {
    cur = (cur as Record<string, unknown> | undefined)?.[part];
  }
  let s = typeof cur === "string" ? cur : key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
};

vi.mock("@/lib/i18n", () => ({
  useI18n: () => ({ t: makeT(), lang: "de" }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/app/admin/books/actions", () => ({
  createBookAction: vi.fn(),
  updateBookAction: vi.fn(),
  setBookPublishedAction: vi.fn(async () => ({ ok: true })),
  deleteBookAction: vi.fn(async () => ({ ok: true })),
}));

// Captured before any stubbing: the jsdom URL subclass below extends this.
const NativeURL = URL;

const { AdminBookManager } = await import("@/components/admin-book-manager");
const { AdminBookForm } = await import("@/components/admin-book-form");
const {
  createBookAction,
  setBookPublishedAction,
  deleteBookAction,
} = await import("@/app/admin/books/actions");

const BOOK_A = {
  id: "aaaaaaaa-1111-4111-8111-111111111111",
  title: "Mittelstufenwortschatz Band 2",
  category: "wortschatz",
  description: "",
  coverUrl: null,
  downloadUrl: "https://example.com/wortschatz-b2.pdf",
  published: true,
  createdAt: "01.12.2026",
};
const BOOK_B = {
  ...BOOK_A,
  id: "bbbbbbbb-2222-4222-8222-222222222222",
  title: "Deutsch für den Beruf",
  category: "arbeitsbuch",
  published: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(setBookPublishedAction).mockResolvedValue({ ok: true });
  vi.mocked(deleteBookAction).mockResolvedValue({ ok: true });
  vi.mocked(createBookAction).mockResolvedValue({ success: "created" });
  // jsdom has no Object URLs (the preview is a browser feature); a stable
  // mock URL keeps the preview effect testable without real blobs.
  vi.stubGlobal(
    "URL",
    class extends NativeURL {
      static createObjectURL(): string {
        return "blob:mock-preview";
      }
      static revokeObjectURL(): void {}
    },
  );
});

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// Admin manager: two-step delete + publish
// ---------------------------------------------------------------------------

describe("admin book manager (behavioral)", () => {
  it("delete is two-step: first click confirms inline, only the second click fires the request", async () => {
    render(<AdminBookManager books={[BOOK_A]} />);

    const deleteButton = screen.getByLabelText("Löschen");
    fireEvent.click(deleteButton);

    // Step 1: confirmation naming the exact book — NO request yet.
    expect(await screen.findByText(/„Mittelstufenwortschatz Band 2“ endgültig löschen\?/)).toBeTruthy();
    expect(deleteBookAction).not.toHaveBeenCalled();

    // Step 2: confirm → EXACTLY ONE call with the right id, then a refresh.
    fireEvent.click(screen.getByRole("button", { name: "Ja, löschen" }));
    await waitFor(() => expect(deleteBookAction).toHaveBeenCalledTimes(1));
    expect(deleteBookAction).toHaveBeenCalledWith(BOOK_A.id);
  });

  it("canceling the delete confirmation sends nothing", async () => {
    render(<AdminBookManager books={[BOOK_A]} />);
    fireEvent.click(screen.getByLabelText("Löschen"));
    expect(await screen.findByText(/endgültig löschen\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    await waitFor(() =>
      expect(screen.queryByText(/endgültig löschen\?/)).toBeNull(),
    );
    expect(deleteBookAction).not.toHaveBeenCalled();
  });

  it("a failed delete surfaces the translated error and the row stays", async () => {
    vi.mocked(deleteBookAction).mockResolvedValueOnce({
      ok: false,
      error: "book_not_found",
    });
    render(<AdminBookManager books={[BOOK_A]} />);
    fireEvent.click(screen.getByLabelText("Löschen"));
    fireEvent.click(await screen.findByRole("button", { name: "Ja, löschen" }));
    expect(
      await screen.findByText("Das Buch existiert nicht (mehr)."),
    ).toBeTruthy();
    expect(screen.getByText(BOOK_A.title)).toBeTruthy();
  });

  it("publish/unpublish fires (bookId, published) for the right row", async () => {
    render(<AdminBookManager books={[BOOK_A, BOOK_B]} />);
    // BOOK_B is a draft → the row offers "Veröffentlichen".
    const buttons = screen.getAllByRole("button");
    const publishB = buttons.find((b) => b.textContent === "Veröffentlichen");
    const unpublishA = buttons.find((b) => b.textContent === "Zurückziehen");
    expect(publishB).toBeTruthy();
    expect(unpublishA).toBeTruthy();

    fireEvent.click(publishB!);
    fireEvent.click(unpublishA!);
    await waitFor(() =>
      expect(setBookPublishedAction).toHaveBeenCalledTimes(2),
    );
    expect(setBookPublishedAction).toHaveBeenCalledWith(BOOK_B.id, true);
    expect(setBookPublishedAction).toHaveBeenCalledWith(BOOK_A.id, false);
  });

  it("edit switches the manager into the prefilled form", async () => {
    render(<AdminBookManager books={[BOOK_A]} />);
    fireEvent.click(screen.getByRole("button", { name: "Bearbeiten" }));
    // The form is prefilled from the row.
    expect(
      (screen.getByLabelText(/Buchtitel/) as HTMLInputElement).value,
    ).toBe(BOOK_A.title);
  });
});

// ---------------------------------------------------------------------------
// Admin form: client validation + submit contract
// ---------------------------------------------------------------------------

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 0x00),
]);

function fillForm() {
  fireEvent.change(screen.getByLabelText(/Buchtitel/), {
    target: { value: "Neues Buch" },
  });
  fireEvent.change(screen.getByLabelText(/Buchtyp/), {
    target: { value: "grammatik" },
  });
  fireEvent.change(screen.getByLabelText(/Externe Download-URL/), {
    target: { value: "https://example.com/grundlagen.pdf" },
  });
  const coverInput = document.querySelector(
    'input[type="file"][name="cover"]',
  ) as HTMLInputElement;
  Object.defineProperty(coverInput, "files", {
    value: [new File([new Uint8Array(PNG)], "cover.png", { type: "image/png" })],
  });
  fireEvent.change(coverInput);
}

describe("admin book form (behavioral)", () => {
  it("blocks a submit with a missing cover (no server round-trip)", async () => {
    render(<AdminBookForm book={null} onDone={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Buchtitel/), {
      target: { value: "Neues Buch" },
    });
    fireEvent.change(screen.getByLabelText(/Buchtyp/), {
      target: { value: "grammatik" },
    });
    fireEvent.change(screen.getByLabelText(/Externe Download-URL/), {
      target: { value: "https://example.com/x.pdf" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Buch hinzufügen/ }));
    expect(await screen.findByText("Bitte ein Cover auswählen (erforderlich).")).toBeTruthy();
    expect(createBookAction).not.toHaveBeenCalled();
  });

  it("blocks a submit with a javascript: URL (no server round-trip)", async () => {
    render(<AdminBookForm book={null} onDone={vi.fn()} />);
    fillForm();
    fireEvent.change(screen.getByLabelText(/Externe Download-URL/), {
      target: { value: "javascript:alert(1)" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Buch hinzufügen/ }));
    expect(await screen.findByText("Bitte eine gültige http(s)-Adresse eingeben.")).toBeTruthy();
    expect(createBookAction).not.toHaveBeenCalled();
  });

  it("a valid submit carries the documented fields (incl. cover + publish flag)", async () => {
    render(<AdminBookForm book={null} onDone={vi.fn()} />);
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: /Buch hinzufügen/ }));
    await waitFor(() => expect(createBookAction).toHaveBeenCalledTimes(1));
    const [, formData] = vi.mocked(createBookAction).mock.calls[0] as [
      unknown,
      FormData,
    ];
    expect(formData.get("title")).toBe("Neues Buch");
    expect(formData.get("category")).toBe("grammatik");
    expect(formData.get("downloadUrl")).toBe("https://example.com/grundlagen.pdf");
    expect(formData.get("published")).toBe("on");
    expect(formData.get("cover")).toBeInstanceOf(File);
    // The form never sends an actor/user id.
    expect(formData.get("actorId")).toBeNull();
    expect(formData.get("userId")).toBeNull();
    expect(formData.get("created_by")).toBeNull();
  });

  it("unchecking 'publish' omits the flag (saved as draft)", async () => {
    render(<AdminBookForm book={null} onDone={vi.fn()} />);
    fillForm();
    fireEvent.click(screen.getByLabelText(/Sofort veröffentlichen/));
    fireEvent.click(screen.getByRole("button", { name: /Buch hinzufügen/ }));
    await waitFor(() => expect(createBookAction).toHaveBeenCalledTimes(1));
    const [, formData] = vi.mocked(createBookAction).mock.calls[0] as [
      unknown,
      FormData,
    ];
    expect(formData.get("published")).toBeNull();
  });

  it("a server error code renders the translated message (never a raw key)", async () => {
    vi.mocked(createBookAction).mockResolvedValueOnce({
      error: "invalid_url",
    });
    render(<AdminBookForm book={null} onDone={vi.fn()} />);
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: /Buch hinzufügen/ }));
    expect(
      await screen.findByText(
        "Die Download-URL ist ungültig — nur http(s)-Adressen sind erlaubt.",
      ),
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Source invariants (public page + navigation integration)
// ---------------------------------------------------------------------------

describe("source invariants", () => {
  const ROOT = join(__dirname, "..");
  const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

  it("the external URL never reaches the client payload; it opens in a fresh, unassociated tab only after server authorization", () => {
    const page = read("src/app/bibliothek/page.tsx");
    const grid = read("src/components/library-book-grid.tsx");
    // The book serialization (page) and the grid props (client) carry NO
    // download URL — the URL is delivered by the action result, AFTER the
    // server authorized + recorded the initiation (quota gate).
    expect(page).not.toContain("download_url");
    expect(grid).not.toContain("download_url");
    // Same safe external-link behavior as the plain-anchor implementation:
    // a fresh, unassociated tab. The platform never fetches the file.
    expect(grid).toContain(
      'window.open(result.url, "_blank", "noopener,noreferrer")',
    );
    expect(grid).not.toMatch(/fetch\(/);
    expect(page).not.toMatch(/fetch\([\s\S]*download_url/);
  });

  it("the public page is gated by the RLS-bound data layer only (no privileged imports)", () => {
    const page = read("src/app/bibliothek/page.tsx");
    expect(page).not.toContain('from "@/app/admin');
    expect(page).not.toContain('from "@/lib/billing/admin"');
    expect(page).not.toContain("createAdminClient");
    expect(page).not.toMatch(/service.?role/i);
    expect(page).toContain("listPublishedBooks");
    // Quota state comes from the SAME data layer (server-resolved; the
    // privileged calls inside are service-role, invisible to this page).
    expect(page).toContain("getBookQuotaState");
    expect(page).toContain("getCurrentUserAndProfile");
    expect(page).toContain('export const dynamic = "force-dynamic"');
  });

  it("the admin page is server-gated like every other /admin surface", () => {
    const page = read("src/app/admin/books/page.tsx");
    expect(page).toContain("requireAdmin()");
    expect(page).toContain('export const dynamic = "force-dynamic"');
  });

  it("every admin mutation action re-gates server-side (no client trust)", () => {
    const actions = read("src/app/admin/books/actions.ts");
    expect(actions).toContain('"use server"');
    expect(actions).toContain("diagnoseAdminAccess()");
    expect(actions).toContain("checkRateLimit(");
    // The actor id only ever comes from the verified gate.
    expect(actions).not.toMatch(/formData\.get\(["'](actorId|userId|created_by|adminId)["']\)/);
  });

  it("the library is integrated into the platform navigation (shell + landing + admin)", () => {
    const shell = read("src/components/app-shell.tsx");
    expect(shell).toContain('href: "/bibliothek"');
    expect(shell).toContain('icon: "book"');
    expect(shell).toContain('match: (p) => p === "/bibliothek"');
    const landing = read("src/app/page.tsx");
    expect(landing).toContain('href="/bibliothek"');
    const adminNav = read("src/components/admin-nav.tsx");
    expect(adminNav).toContain('href: "/admin/books"');
  });
});
