// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { LibraryBookData } from "@/components/library-book-grid";
import type { BookDownloadResult } from "@/lib/book-library";

/**
 * Deutsch Bibliothek — quota UX (jsdom, real German dictionary).
 *
 * The server-side contracts are pinned by library-quota.test.ts +
 * library-quota-action.test.ts; this suite pins what the visitor actually
 * sees and can trigger:
 *
 *   1. guest → sign-in CTA (existing auth UX), book content intact, and NO
 *      download action is ever initiated on mount;
 *   2. ready → the live "n of limit left today" counter; a successful
 *      initiation opens the URL in a fresh, unassociated tab AND decrements
 *      the counter in place (no page reload, no remount);
 *   3. exhausted (initial) → the card stays fully visible, the button is
 *      disabled, and the EXACT Arabic message is shown for the free tier —
 *      while Plus/Pro get the localized "daily limit reached" instead;
 *   4. server outcomes: quota_exhausted flips the state live; not_signed_in
 *      falls back to the guest UX; db_error surfaces the translated alert;
 *   5. one in-flight initiation at a time (double-click guard).
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

vi.mock("@/app/bibliothek/actions", () => ({
  initiateBookDownloadAction: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    className,
    children,
  }: {
    href: string;
    className?: string;
    children: React.ReactNode;
  }) => <a href={href} className={className}>{children}</a>,
}));

const { initiateBookDownloadAction } = await import("@/app/bibliothek/actions");
const { LibraryBookGrid } = await import("@/components/library-book-grid");

const BOOK: LibraryBookData = {
  id: "aaaaaaaa-1111-4111-8111-111111111111",
  title: "Mittelstufenwortschatz Band 2",
  category: "wortschatz",
  description: "Übungsbuch für B1",
  coverUrl: "https://proj.supabase.co/storage/v1/object/public/book-covers/covers/c.png",
};

const GUEST = { state: "guest" as const, tier: "none" as const, limit: 0, used: 0, remaining: 0 };
const READY_TRIAL = { state: "ready" as const, tier: "trial" as const, limit: 1, used: 0, remaining: 1 };
const EXHAUSTED_FREE = { state: "exhausted" as const, tier: "none" as const, limit: 0, used: 0, remaining: 0 };
const EXHAUSTED_PLUS = { state: "exhausted" as const, tier: "plus" as const, limit: 10, used: 10, remaining: 0 };

const ARABIC_EXACT = "لقد انتهت حصتك المجانية";

let openSpy: MockInstance<typeof window.open>;

beforeEach(() => {
  vi.clearAllMocks();
  openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
});

afterEach(() => {
  cleanup();
  openSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Guest (the existing auth UX — no grant from the absence of a profile)
// ---------------------------------------------------------------------------

describe("guest state", () => {
  it("shows the sign-in CTA, keeps the card content, and initiates nothing", async () => {
    render(<LibraryBookGrid books={[BOOK]} initialQuota={GUEST} />);

    // Card content fully visible.
    expect(screen.getByText(BOOK.title)).toBeTruthy();
    expect(screen.getByText("Übungsbuch für B1")).toBeTruthy();
    expect(document.querySelector(`img[src="${BOOK.coverUrl}"]`)).toBeTruthy();

    // Sign-in CTA (link to the existing login flow) instead of a download —
    // in the quota bar AND on every card (multiple by design).
    const links = screen.getAllByRole("link", { name: /Anmelden zum Herunterladen/ });
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const link of links) expect(link.getAttribute("href")).toBe("/login");

    // No actionable download button exists for a guest.
    expect(screen.queryByRole("button", { name: /Buch herunterladen/ })).toBeNull();
    // And nothing is sent on mount.
    expect(initiateBookDownloadAction).not.toHaveBeenCalled();
    await waitFor(() => expect(initiateBookDownloadAction).not.toHaveBeenCalled());
  });
});

// ---------------------------------------------------------------------------
// Ready (live counter + no-reload update after a successful initiation)
// ---------------------------------------------------------------------------

describe("ready state", () => {
  it("shows the remaining counter and opens the URL in a fresh, unassociated tab after authorization", async () => {
    vi.mocked(initiateBookDownloadAction).mockResolvedValue({
      ok: true,
      url: "https://example.com/buch.pdf",
      remaining: 0,
      tier: "trial",
      deduplicated: false,
    });
    render(<LibraryBookGrid books={[BOOK]} initialQuota={READY_TRIAL} />);

    // The live counter is visible before any click.
    expect(screen.getByText("1 von 1 Downloads heute noch möglich")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Buch herunterladen/ }));

    await waitFor(() =>
      expect(initiateBookDownloadAction).toHaveBeenCalledTimes(1),
    );
    expect(initiateBookDownloadAction).toHaveBeenCalledWith(BOOK.id);
    // The URL is opened only AFTER the action granted it.
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(
      "https://example.com/buch.pdf",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("updates the remaining counter IN PLACE after success (no reload, flips to exhausted at 0)", async () => {
    vi.mocked(initiateBookDownloadAction).mockResolvedValue({
      ok: true,
      url: "https://example.com/buch.pdf",
      remaining: 0,
      tier: "trial",
      deduplicated: false,
    });
    render(<LibraryBookGrid books={[BOOK]} initialQuota={READY_TRIAL} />);

    fireEvent.click(screen.getByRole("button", { name: /Buch herunterladen/ }));

    // Live state change: the counter is gone, the exhausted message is in,
    // the button is now disabled — same mounted tree (no reload).
    await waitFor(() =>
      expect(screen.getAllByText(ARABIC_EXACT).length).toBeGreaterThanOrEqual(2),
    );
    expect(screen.queryByText("1 von 1 Downloads heute noch möglich")).toBeNull();
    const button = screen.getByRole("button", { name: /Buch herunterladen/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    // The card itself (title/cover/description) is still fully rendered.
    expect(screen.getByText(BOOK.title)).toBeTruthy();
    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  it("a PLUS user keeps the live counter between consumptions (9 left of 10)", async () => {
    vi.mocked(initiateBookDownloadAction).mockResolvedValue({
      ok: true,
      url: "https://example.com/buch.pdf",
      remaining: 8,
      tier: "plus",
      deduplicated: false,
    });
    const quota = { state: "ready" as const, tier: "plus" as const, limit: 10, used: 1, remaining: 9 };
    render(<LibraryBookGrid books={[BOOK]} initialQuota={quota} />);
    expect(screen.getByText("9 von 10 Downloads heute noch möglich")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Buch herunterladen/ }));
    await screen.findByText("8 von 10 Downloads heute noch möglich");
    // Still ready → the button stays enabled.
    expect((screen.getByRole("button", { name: /Buch herunterladen/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("only ONE initiation is in flight (double-click guard)", async () => {
    let resolveAction!: (v: BookDownloadResult) => void;
    vi.mocked(initiateBookDownloadAction).mockReturnValue(
      new Promise<BookDownloadResult>((resolve) => {
        resolveAction = resolve;
      }),
    );
    render(<LibraryBookGrid books={[BOOK]} initialQuota={READY_TRIAL} />);
    const button = screen.getByRole("button", { name: /Buch herunterladen/ });
    fireEvent.click(button);
    fireEvent.click(button); // second click while the first is in flight
    expect(initiateBookDownloadAction).toHaveBeenCalledTimes(1);

    resolveAction({
      ok: true,
      url: "https://example.com/buch.pdf",
      remaining: 0,
      tier: "trial",
      deduplicated: false,
    });
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));
  });
});

// ---------------------------------------------------------------------------
// Exhausted (card visible, button disabled, the right message per tier)
// ---------------------------------------------------------------------------

describe("exhausted state", () => {
  it("free tier: EXACT Arabic message, disabled button, card intact, no action", async () => {
    render(<LibraryBookGrid books={[BOOK]} initialQuota={EXHAUSTED_FREE} />);

    // The exact mandated string — in the quota bar AND under the button.
    expect(screen.getAllByText(ARABIC_EXACT).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(BOOK.title)).toBeTruthy();
    const button = screen.getByRole("button", { name: /Buch herunterladen/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(initiateBookDownloadAction).not.toHaveBeenCalled();
    await waitFor(() => expect(initiateBookDownloadAction).not.toHaveBeenCalled());
  });

  it("plus tier: the localized 'daily limit reached' message (NOT the free-tier string)", async () => {
    render(<LibraryBookGrid books={[BOOK]} initialQuota={EXHAUSTED_PLUS} />);

    expect(
      screen.getAllByText(
        "Das Download-Limit für heute ist erreicht. Morgen kannst du weitermachen.",
      ).length,
    ).toBeGreaterThanOrEqual(2);
    // The Arabic free-tier string must NOT appear for a paid tier.
    expect(screen.queryByText(ARABIC_EXACT)).toBeNull();
    expect((screen.getByRole("button", { name: /Buch herunterladen/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a live quota_exhausted outcome (stale 'ready' state) flips the UI without a reload", async () => {
    vi.mocked(initiateBookDownloadAction).mockResolvedValue({
      ok: false,
      error: "quota_exhausted",
      remaining: 0,
      tier: "trial",
    });
    render(<LibraryBookGrid books={[BOOK]} initialQuota={READY_TRIAL} />);

    fireEvent.click(screen.getByRole("button", { name: /Buch herunterladen/ }));
    await waitFor(() =>
      expect(screen.getAllByText(ARABIC_EXACT).length).toBeGreaterThanOrEqual(2),
    );
    expect(openSpy).not.toHaveBeenCalled();
    expect(
      (screen.getByRole("button", { name: /Buch herunterladen/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Error / session outcomes
// ---------------------------------------------------------------------------

describe("action error outcomes", () => {
  it("not_signed_in (session expired mid-page) → falls back to the guest UX", async () => {
    vi.mocked(initiateBookDownloadAction).mockResolvedValue({
      ok: false,
      error: "not_signed_in",
      remaining: 0,
      tier: "none",
    });
    render(<LibraryBookGrid books={[BOOK]} initialQuota={READY_TRIAL} />);

    fireEvent.click(screen.getByRole("button", { name: /Buch herunterladen/ }));
    await waitFor(() =>
      expect(
        screen.getAllByRole("link", { name: /Anmelden zum Herunterladen/ }).length,
      ).toBeGreaterThanOrEqual(2),
    );
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("db_error → the translated alert (never a raw code), state preserved", async () => {
    vi.mocked(initiateBookDownloadAction).mockResolvedValue({
      ok: false,
      error: "db_error",
      remaining: 1,
      tier: "trial",
    });
    render(<LibraryBookGrid books={[BOOK]} initialQuota={READY_TRIAL} />);

    fireEvent.click(screen.getByRole("button", { name: /Buch herunterladen/ }));
    expect(
      await screen.findByText(
        "Der Download konnte nicht gestartet werden. Bitte erneut versuchen.",
      ),
    ).toBeTruthy();
    // The user can retry: the counter + button are still there.
    expect(screen.getByText("1 von 1 Downloads heute noch möglich")).toBeTruthy();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("quota_unavailable (missing quota schema in the DB) → its OWN translated message, no URL, quota intact", async () => {
    vi.mocked(initiateBookDownloadAction).mockResolvedValue({
      ok: false,
      error: "quota_unavailable",
      remaining: 1,
      tier: "trial",
    });
    render(<LibraryBookGrid books={[BOOK]} initialQuota={READY_TRIAL} />);

    fireEvent.click(screen.getByRole("button", { name: /Buch herunterladen/ }));
    // The dedicated, honest message — NOT the generic "try again" (a
    // deployment gap does not clear itself on retry).
    expect(
      await screen.findByText(
        "Das Download-System ist derzeit nicht verfügbar. Bitte versuche es später erneut.",
      ),
    ).toBeTruthy();
    // The generic db_error message must NOT appear alongside it.
    expect(
      screen.queryByText(
        "Der Download konnte nicht gestartet werden. Bitte erneut versuchen.",
      ),
    ).toBeNull();
    // Nothing was opened and the quota state is untouched (no consume).
    expect(openSpy).not.toHaveBeenCalled();
    expect(screen.getByText("1 von 1 Downloads heute noch möglich")).toBeTruthy();
  });

  it("a thrown action → the db_error alert", async () => {
    vi.mocked(initiateBookDownloadAction).mockRejectedValue(new Error("boom"));
    render(<LibraryBookGrid books={[BOOK]} initialQuota={READY_TRIAL} />);

    fireEvent.click(screen.getByRole("button", { name: /Buch herunterladen/ }));
    expect(
      await screen.findByText(
        "Der Download konnte nicht gestartet werden. Bitte erneut versuchen.",
      ),
    ).toBeTruthy();
  });
});
