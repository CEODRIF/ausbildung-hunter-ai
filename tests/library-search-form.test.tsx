// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

/**
 * Deutsch Bibliothek — search form behavior (regression suite for the
 * 2026-10 bug: the Search button performed a FULL page reload).
 *
 * Pinned contracts:
 *   1. NO native form navigation — the submit is intercepted
 *      (preventDefault) and translated into a Next.js App-Router soft
 *      navigation (`router.push` on /bibliothek?…);
 *   2. the Search button is a real `type="submit"` inside the form, and
 *      the Enter key (the form's submit event) triggers the SAME path;
 *   3. the typed value is preserved (controlled input), trimmed for the
 *      URL, and the input stays in sync with the server-rendered criteria
 *      (back/forward / clear-search deep links);
 *   4. criteria → URL: title only, category only, combined, cleared;
 *      the page index is NEVER carried over (a changed criteria set
 *      starts on page 1); unknown category values are dropped;
 *   5. duplicate submissions are impossible while a navigation is
 *      pending (button disabled, one push).
 *
 * Mock boundary: next/navigation (the router is the observable seam —
 * the real App-Router navigation is covered by the page's server
 * contract tests). Real React + real German dictionary.
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

const pushSpy = vi.fn<(...args: unknown[]) => Promise<void>>(
  () => Promise.resolve(),
);
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushSpy }),
}));

const { LibrarySearchForm } = await import(
  "@/components/library-search-form"
);

const input = () => screen.getByLabelText("Bücher nach Titel durchsuchen") as HTMLInputElement;
const select = () => screen.getByLabelText("Nach Buchtyp filtern") as HTMLSelectElement;
const button = () => screen.getByRole("button", { name: "Suchen" });

function lastPushUrl(): string | undefined {
  const calls = vi.mocked(pushSpy).mock.calls;
  return calls.length > 0 ? String(calls[calls.length - 1][0]) : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  pushSpy.mockImplementation(() => Promise.resolve());
});

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// 1. No full page reload — soft navigation only
// ---------------------------------------------------------------------------

describe("submit handling (no full page reload)", () => {
  it("clicking Search does NOT submit natively — it pushes the App-Router URL", () => {
    render(<LibrarySearchForm search={null} category={null} />);
    fireEvent.change(input(), { target: { value: "Wortschatz" } });
    fireEvent.click(button());

    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(lastPushUrl()).toBe("/bibliothek?q=Wortschatz");
    // The form has no `action` — a native GET would have reloaded the page;
    // the handler intercepted the submit (the only navigation is router.push).
    expect(document.querySelector("form")?.getAttribute("action")).toBeNull();
  });

  it("the Search button is a real submit button inside the search form", () => {
    render(<LibrarySearchForm search={null} category={null} />);
    const btn = button();
    expect(btn.getAttribute("type")).toBe("submit");
    expect(btn.closest("form")).not.toBeNull();
    expect(document.querySelector('form[role="search"]')).not.toBeNull();
  });

  it("Enter in the input (the form submit event) takes the SAME soft-navigation path", () => {
    render(<LibrarySearchForm search={null} category={null} />);
    fireEvent.change(input(), { target: { value: "Grammatik" } });
    // In a real browser, Enter in a single-line input submits the form —
    // that is exactly the submit event jsdom cannot synthesize, so fire it.
    fireEvent.submit(document.querySelector("form")!);

    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(lastPushUrl()).toBe("/bibliothek?q=Grammatik");
  });

  it("an empty submit pushes the bare /bibliothek URL (clears any previous filters)", () => {
    // Rendered as if the URL carried q+cat (page 2): clearing restores all.
    render(<LibrarySearchForm search="Grammatik" category="lehrbuch" />);
    fireEvent.change(input(), { target: { value: "" } });
    fireEvent.change(select(), { target: { value: "" } });
    fireEvent.click(button());
    expect(lastPushUrl()).toBe("/bibliothek");
  });
});

// ---------------------------------------------------------------------------
// 2. Criteria → URL mapping
// ---------------------------------------------------------------------------

describe("criteria to URL mapping", () => {
  it("title is trimmed before it reaches the URL (mixed case preserved)", () => {
    render(<LibrarySearchForm search={null} category={null} />);
    fireEvent.change(input(), { target: { value: "   Mittelstufenwortschatz   " } });
    fireEvent.click(button());
    expect(lastPushUrl()).toBe("/bibliothek?q=Mittelstufenwortschatz");
  });

  it("category-only filtering works without a title", () => {
    render(<LibrarySearchForm search={null} category={null} />);
    fireEvent.change(select(), { target: { value: "hoeren" } });
    fireEvent.click(button());
    expect(lastPushUrl()).toBe("/bibliothek?cat=hoeren");
  });

  it("title + category are applied TOGETHER (one URL, both params)", () => {
    render(<LibrarySearchForm search={null} category={null} />);
    fireEvent.change(input(), { target: { value: "Band 2" } });
    fireEvent.change(select(), { target: { value: "wortschatz" } });
    fireEvent.click(button());
    const url = new URL(lastPushUrl()!, "http://localhost");
    expect(url.searchParams.get("q")).toBe("Band 2");
    expect(url.searchParams.get("cat")).toBe("wortschatz");
  });

  it("the page index is NEVER carried over (changed criteria start on page 1)", () => {
    // Simulates being on ?q=...&cat=...&page=3 — the component only knows
    // the active criteria; the URL it builds must contain no page param.
    render(<LibrarySearchForm search="Grammatik" category="grammatik" />);
    fireEvent.change(input(), { target: { value: "Wortschatz" } });
    fireEvent.click(button());
    expect(lastPushUrl()).not.toContain("page=");
  });

  it("an unknown category value (tampered DOM) is dropped, not sent", () => {
    render(<LibrarySearchForm search={null} category={null} />);
    fireEvent.change(input(), { target: { value: "x" } });
    fireEvent.change(select(), { target: { value: "not-a-real-slug" } });
    fireEvent.click(button());
    const url = new URL(lastPushUrl()!, "http://localhost");
    expect(url.searchParams.get("cat")).toBeNull();
    expect(url.searchParams.get("q")).toBe("x");
  });
});

// ---------------------------------------------------------------------------
// 3. Value preservation + server-criteria resync
// ---------------------------------------------------------------------------

describe("input value preservation & resync", () => {
  it("the typed value survives the (soft) navigation — no input reset", () => {
    render(<LibrarySearchForm search={null} category={null} />);
    fireEvent.change(input(), { target: { value: "Übungsbuch B1" } });
    fireEvent.click(button());
    // Same mounted tree, same value — nothing was torn down.
    expect(input().value).toBe("Übungsbuch B1");
  });

  it("the input shows the server-rendered (URL) criteria on mount", () => {
    render(<LibrarySearchForm search="Band 2" category="arbeitsbuch" />);
    expect(input().value).toBe("Band 2");
    expect(select().value).toBe("arbeitsbuch");
  });

  it("a navigation that CHANGES the criteria re-syncs the inputs (back/forward, clear link)", () => {
    const { rerender } = render(
      <LibrarySearchForm search="Grammatik" category="grammatik" />,
    );
    expect(input().value).toBe("Grammatik");
    // e.g. the user pressed Back → the URL (and thus the server render)
    // carries no criteria anymore:
    rerender(<LibrarySearchForm search={null} category={null} />);
    expect(input().value).toBe("");
    expect(select().value).toBe("");
  });

  it("typing stays responsive (no debounce, no lost keystrokes)", () => {
    render(<LibrarySearchForm search={null} category={null} />);
    const el = input();
    fireEvent.change(el, { target: { value: "a" } });
    expect(el.value).toBe("a");
    fireEvent.change(el, { target: { value: "ab" } });
    expect(el.value).toBe("ab");
    fireEvent.change(el, { target: { value: "abc" } });
    expect(el.value).toBe("abc");
  });
});

// ---------------------------------------------------------------------------
// 4. Duplicate-submission guard
// ---------------------------------------------------------------------------

describe("duplicate submissions", () => {
  it("a second click while the navigation is pending sends NOTHING (button disabled)", async () => {
    // The navigation never settles — isPending must hold the guard.
    pushSpy.mockImplementation(() => new Promise<void>(() => {}));
    render(<LibrarySearchForm search={null} category={null} />);
    fireEvent.change(input(), { target: { value: "Lesen" } });

    fireEvent.click(button());
    expect(pushSpy).toHaveBeenCalledTimes(1);

    // The button is disabled while pending → a second click is a no-op.
    await waitFor(() =>
      expect((button() as HTMLButtonElement).disabled).toBe(true),
    );
    fireEvent.click(button());
    fireEvent.click(button());
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  it("after the navigation settles, a new search can run again", async () => {
    type ResolveFn = (value: void | PromiseLike<void>) => void;
    let resolvePush: ResolveFn = () => {};
    pushSpy.mockImplementation(
      () => new Promise<void>((resolve) => (resolvePush = resolve)),
    );
    render(<LibrarySearchForm search={null} category={null} />);
    fireEvent.change(input(), { target: { value: "Erste Suche" } });
    fireEvent.click(button());
    expect(pushSpy).toHaveBeenCalledTimes(1);
    // In flight → disabled.
    expect((button() as HTMLButtonElement).disabled).toBe(true);

    // The soft navigation settles → the guard releases.
    await act(async () => {
      resolvePush();
    });
    await waitFor(() =>
      expect((button() as HTMLButtonElement).disabled).toBe(false),
    );

    fireEvent.change(input(), { target: { value: "Zweite Suche" } });
    fireEvent.click(button());
    expect(pushSpy).toHaveBeenCalledTimes(2);
    // Encoding-agnostic (URLSearchParams emits "+"; both decode to a space).
    const url = new URL(lastPushUrl()!, "http://localhost");
    expect(url.searchParams.get("q")).toBe("Zweite Suche");
  });
});
