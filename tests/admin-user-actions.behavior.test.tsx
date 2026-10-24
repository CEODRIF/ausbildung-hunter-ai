// @vitest-environment jsdom
/**
 * BEHAVIORAL tests for the admin two-step confirmation (renders the real
 * component in jsdom, mocks only `fetch` and the i18n hook).
 *
 * Proves, by interaction — not by string matching:
 *   1. the FIRST click on any access-changing action sends NO request and
 *      opens the inline confirmation;
 *   2. the confirmation names the correct target user (e-mail) and the
 *      action label;
 *   3. canceling sends no request and clears the pending state;
 *   4. confirming sends EXACTLY ONE request with the right URL + body;
 *   5. repeated clicks cannot trigger duplicate mutations;
 *   6. a failed request renders the error, stays recoverable, and the
 *      server (not the client) remains the authority — the client only
 *      ever POSTs {action, ...documented params}.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

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

// The component refreshes the server data after a successful mutation.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const { AdminUserActions } = await import("@/components/admin-user-actions");

const ROW_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_EMAIL = "correct-target@example.com";
const ACTOR_ID = "11111111-1111-4111-8111-411111111111";

const activeRow = {
  id: ROW_ID,
  email: TARGET_EMAIL,
  is_admin: false,
  subscription: {
    plan: "pro",
    status: "active",
    provider: "manual",
    current_period_start: "2026-10-01T00:00:00.000Z",
    current_period_end: "2026-10-31T00:00:00.000Z",
    canceled_at: null,
    trial_activated_at: null,
  },
};

function okResponse(body: Record<string, unknown> = { message: "ok" }) {
  return () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => body,
    });
}

describe("admin confirmation — behavioral (render + interaction)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(okResponse());
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("first click sends NO request and opens a confirmation naming target + action", async () => {
    render(<AdminUserActions actorId={ACTOR_ID} row={activeRow} />);
    const button = screen.getByRole("button", { name: /Pro/i });
    fireEvent.click(button);
    expect(fetchMock).not.toHaveBeenCalled();
    const confirmText = await screen.findByText(/correct-target@example\.com/);
    expect(confirmText.textContent).toContain("Pro · 30 Tage");
    expect(
      screen.getByRole("button", { name: "Bestätigen" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Abbrechen" }),
    ).toBeInTheDocument();
  });

  it("canceling the confirmation sends no request and clears the pending state", async () => {
    render(<AdminUserActions actorId={ACTOR_ID} row={activeRow} />);
    fireEvent.click(screen.getByRole("button", { name: /Kündigen/i }));
    await screen.findByText(/correct-target@example\.com/);
    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      screen.queryByText(/correct-target@example\.com/),
    ).not.toBeInTheDocument();
    // The action button is available again (state fully cleared).
    expect(screen.getByRole("button", { name: /Kündigen/i })).toBeEnabled();
  });

  it("confirming sends EXACTLY ONE request with the right URL and body", async () => {
    render(<AdminUserActions actorId={ACTOR_ID} row={activeRow} />);
    fireEvent.click(screen.getByRole("button", { name: /Kündigen/i }));
    await screen.findByText(/correct-target@example\.com/);
    fireEvent.click(screen.getByRole("button", { name: "Bestätigen" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/admin/users/${ROW_ID}`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      action: "cancel_subscription",
    });
    // The confirmation is gone after the request fired.
    await waitFor(() =>
      expect(
        screen.queryByText(/correct-target@example\.com/),
      ).not.toBeInTheDocument(),
    );
  });

  it("repeated clicks on the confirm button cannot duplicate the mutation", async () => {
    render(<AdminUserActions actorId={ACTOR_ID} row={activeRow} />);
    fireEvent.click(screen.getByRole("button", { name: /Pro/i }));
    const confirm = await screen.findByRole("button", {
      name: "Bestätigen",
    });
    fireEvent.click(confirm);
    fireEvent.click(confirm); // second click lands while/after the first
    fireEvent.click(confirm); // and a third, for good measure
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // give any stray async continuation a beat to (wrongly) fire
    await new Promise((r) => setTimeout(r, 25));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body).toEqual({ action: "set_plan", plan: "pro", periodDays: 30 });
  });

  it("a failed request renders an error, clears the confirmation, and the user can retry", async () => {
    fetchMock.mockReturnValueOnce(
      Promise.resolve({
        ok: false,
        status: 429,
        json: async () => ({ error: "rate_limited" }),
      }),
    );
    render(<AdminUserActions actorId={ACTOR_ID} row={activeRow} />);
    fireEvent.click(screen.getByRole("button", { name: /Kündigen/i }));
    await screen.findByText(/correct-target@example\.com/);
    fireEvent.click(screen.getByRole("button", { name: "Bestätigen" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // error surfaced (de dictionary: actionFailed with {error})
    expect(await screen.findByText(/rate_limited/)).toBeInTheDocument();
    // confirmation cleared, action available again
    expect(
      screen.queryByText(/correct-target@example\.com/),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Kündigen/i })).toBeEnabled();
  });

  it("only action + documented params travel — never an actor identity", async () => {
    render(<AdminUserActions actorId={ACTOR_ID} row={activeRow} />);
    fireEvent.click(screen.getByRole("button", { name: /Plus/i }));
    await screen.findByText(/correct-target@example\.com/);
    fireEvent.click(screen.getByRole("button", { name: "Bestätigen" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(Object.keys(body).sort()).toEqual(["action", "periodDays", "plan"]);
    expect(body).not.toHaveProperty("actorId");
    expect(body).not.toHaveProperty("actor_id");
  });
});
