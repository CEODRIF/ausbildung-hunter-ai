import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Auth guard contract (production incident: confirmed + active users were
 * bounced to /verify):
 *  - /verify is ONLY for users without a confirmed email;
 *  - confirmed + active without a goal → /onboarding (dashboard layout) or
 *    the onboarding page (onboarding layout);
 *  - confirmed + active with a goal → dashboard renders;
 *  - /verify is state-aware: a confirmed user never sees "check your email".
 */
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));
vi.mock("@/lib/auth", () => ({
  getCurrentUserAndProfile: vi.fn(),
}));

const { redirect } = await import("next/navigation");
const { getCurrentUserAndProfile } = await import("@/lib/auth");
const DashboardLayout = (await import("@/app/dashboard/layout")).default;
const OnboardingLayout = (await import("@/app/onboarding/layout")).default;
const VerifyPage = (await import("@/app/verify/page")).default;

const user = (confirmed: boolean) =>
  (confirmed
    ? {
        id: "u1",
        email: "jane@example.com",
        email_confirmed_at: "2026-01-01T00:00:00Z",
      }
    : {
        id: "u1",
        email: "jane@example.com",
        email_confirmed_at: null,
      }) as never;

const profile = (
  status: "pending" | "active" | "suspended",
  goal: "ausbildung" | "arbeit" | null = null,
) => ({
  id: "u1",
  full_name: "Jane Doe",
  email: "jane@example.com",
  account_status: status,
  selected_goal: goal,
  daily_email_limit: 50,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
});

async function expectRedirect(fn: () => Promise<unknown>, url: string) {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
  expect(redirect).toHaveBeenCalledWith(url);
}

async function expectNoRedirect(fn: () => Promise<unknown>) {
  await expect(fn()).resolves.not.toThrow();
  expect(redirect).not.toHaveBeenCalled();
}

/** Collect the text content of a React element tree (cycle-safe). */
function textOf(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object") {
    const el = node as { props?: { children?: unknown } };
    if (el.props) return textOf(el.props.children);
  }
  return "";
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("dashboard layout guards", () => {
  it("sends anonymous visitors to /login", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
      user: null,
      profile: null,
    });
    await expectRedirect(() => DashboardLayout({ children: null }), "/login");
  });

  it("sends unconfirmed users to /verify", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
      user: user(false),
      profile: profile("active"),
    });
    await expectRedirect(() => DashboardLayout({ children: null }), "/verify");
  });

  it("sends confirmed + active users without a goal to /onboarding", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
      user: user(true),
      profile: profile("active", null),
    });
    await expectRedirect(
      () => DashboardLayout({ children: null }),
      "/onboarding",
    );
  });

  it("renders the dashboard for confirmed + active users with a goal", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
      user: user(true),
      profile: profile("active", "ausbildung"),
    });
    await expectNoRedirect(() => DashboardLayout({ children: null }));
  });

  it("sends suspended users to /login?error=suspended", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
      user: user(true),
      profile: profile("suspended"),
    });
    await expectRedirect(
      () => DashboardLayout({ children: null }),
      "/login?error=suspended",
    );
  });

  it("keeps confirmed users with a missing profile OUT of the unconfirmed flow", async () => {
    // Confirmed + no profile row is a data-inconsistency fallback (still
    // /verify), but the page itself now tells confirmed users the truth.
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
      user: user(true),
      profile: null,
    });
    await expectRedirect(() => DashboardLayout({ children: null }), "/verify");
  });
});

describe("onboarding layout guards", () => {
  it("sends anonymous visitors to /login", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
      user: null,
      profile: null,
    });
    await expectRedirect(() => OnboardingLayout({ children: null }), "/login");
  });

  it("sends unconfirmed users to /verify", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
      user: user(false),
      profile: profile("pending"),
    });
    await expectRedirect(() => OnboardingLayout({ children: null }), "/verify");
  });

  it("renders onboarding for confirmed + active users without a goal", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
      user: user(true),
      profile: profile("active", null),
    });
    await expectNoRedirect(() =>
      OnboardingLayout({ children: "onboarding-page" }),
    );
  });

  it("sends confirmed + active users with a goal to /dashboard", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
      user: user(true),
      profile: profile("active", "arbeit"),
    });
    await expectRedirect(
      () => OnboardingLayout({ children: null }),
      "/dashboard",
    );
  });
});

describe("/verify page is state-aware", () => {
  it("shows check-your-email + resend for unauthenticated/unconfirmed visitors", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
      user: null,
      profile: null,
    });
    const element = await VerifyPage();
    expect(element.props.title).toBe("Check your email");
    expect(textOf(element)).toContain("Click the link in the email");
  });

  it("never tells a confirmed user to check their email", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
      user: user(true),
      profile: profile("active"),
    });
    const element = await VerifyPage();
    expect(element.props.title).toBe(
      "We couldn't finish setting up your account",
    );
    expect(element.props.subtitle).toBe(
      "Your email address is already confirmed.",
    );
    const text = textOf(element);
    expect(text).toContain("account data looks incomplete");
    expect(text).not.toContain("Click the link in the email");
  });
});
