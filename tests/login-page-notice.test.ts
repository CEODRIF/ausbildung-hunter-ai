import { describe, expect, it } from "vitest";

/**
 * `?error=suspended` is the bounce target the protected layouts (dashboard /
 * onboarding) send a suspended account to. The query flag used to be ignored
 * completely — the user landed on a bare sign-in form with no explanation of
 * why they had been thrown out, which reads as a broken app. The page now
 * forwards it to the form's initial error state.
 */
const LoginPage = (await import("@/app/login/page")).default;

/** Depth-first search for a node whose props satisfy the predicate. */
function findByProp(
  node: unknown,
  predicate: (props: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  if (node == null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByProp(child, predicate);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as { props?: Record<string, unknown> };
  if (el.props && predicate(el.props)) return el.props;
  if (el.props) return findByProp(el.props.children, predicate);
  return null;
}

describe("login page notices", () => {
  it("surfaces the suspended-account reason instead of dropping it", async () => {
    const element = await LoginPage({
      searchParams: Promise.resolve({ error: "suspended" }),
    });
    const props = findByProp(element, (p) => "initialError" in p);
    expect(props).not.toBeNull();
    expect(String(props?.initialError)).toContain("suspended");
  });

  it("accepts the flag as a repeated query parameter (?error=a&error=b)", async () => {
    const element = await LoginPage({
      searchParams: Promise.resolve({ error: ["suspended"] }),
    });
    const props = findByProp(element, (p) => "initialError" in p);
    expect(String(props?.initialError)).toContain("suspended");
  });

  it("renders no notice without a known code", async () => {
    const element = await LoginPage({ searchParams: Promise.resolve({}) });
    const props = findByProp(element, (p) => "initialError" in p);
    expect(props?.initialError).toBeUndefined();
  });

  it("ignores unknown error codes rather than echoing them to the user", async () => {
    const element = await LoginPage({
      searchParams: Promise.resolve({ error: "<script>alert(1)</script>" }),
    });
    const props = findByProp(element, (p) => "initialError" in p);
    expect(props?.initialError).toBeUndefined();
  });
});
