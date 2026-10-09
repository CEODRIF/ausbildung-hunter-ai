import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearRobotsCache,
  parseRobotsTxt,
  robotsVerdictForUrl,
  ROBOT_AGENT,
} from "@/lib/housing/web-search/robots";
import { FETCH_USER_AGENT, LIMITS } from "@/lib/housing/web-search/config";

const T0 = 1_760_000_000_000;

function robotsFetchMock(impl: (url: string) => Response | Promise<Response>) {
  const fetchImpl = vi.fn(impl);
  return fetchImpl;
}

beforeEach(() => {
  clearRobotsCache();
  vi.clearAllMocks();
});

describe("parseRobotsTxt", () => {
  it("pins the agent token to the first token of the fetch User-Agent", () => {
    // A rename of either side would silently disable agent-specific groups.
    expect(ROBOT_AGENT).toBe(FETCH_USER_AGENT.split("/")[0].toLowerCase());
  });

  it("collects the * group and our agent group separately", () => {
    const groups = parseRobotsTxt(
      [
        "User-agent: *",
        "Disallow: /private",
        "",
        "User-agent: AusbildungsWegBot",
        "Allow: /",
      ].join("\n"),
    );
    expect(groups.star.disallow).toContain("/private");
    expect(groups.agent.allow).toContain("/");
  });

  it("ignores rules for other agents, strips comments, tolerates garbage lines", () => {
    const groups = parseRobotsTxt(
      ["# a comment", "User-agent: Googlebot", "Disallow: /", "garbage line", "User-agent: *", "Disallow: /only-star"].join(
        "\n",
      ),
    );
    expect(groups.star.disallow).toEqual(["/only-star"]);
    expect(groups.agent.disallow).toEqual([]);
  });

  it("treats empty Disallow as a no-op", () => {
    const groups = parseRobotsTxt("User-agent: *\nDisallow:\n");
    expect(groups.star.disallow).toEqual([]);
  });
});

describe("robotsVerdictForUrl", () => {
  const url = (path: string) => new URL(`https://open.nrw${path}`);

  it("disallows paths the * group disallows", async () => {
    const fetchImpl = robotsFetchMock(
      () => new Response("User-agent: *\nDisallow: /dataset", { status: 200 }),
    );
    await expect(robotsVerdictForUrl(url("/dataset/abc"), { fetchImpl: fetchImpl as never, now: () => T0 })).resolves.toBe("disallowed");
    await expect(robotsVerdictForUrl(url("/search"), { fetchImpl: fetchImpl as never, now: () => T0 })).resolves.toBe("allowed");
    expect(fetchImpl).toHaveBeenCalledTimes(1); // second path served from the host cache
  });

  it("Allow beats Disallow within the applicable group", async () => {
    const fetchImpl = robotsFetchMock(
      () =>
        new Response(
          "User-agent: *\nAllow: /dataset/api\nDisallow: /dataset",
          { status: 200 },
        ),
    );
    await expect(
      robotsVerdictForUrl(url("/dataset/api/items"), { fetchImpl: fetchImpl as never, now: () => T0 }),
    ).resolves.toBe("allowed");
    await expect(
      robotsVerdictForUrl(url("/dataset/items"), { fetchImpl: fetchImpl as never, now: () => T0 }),
    ).resolves.toBe("disallowed");
  });

  it("uses the our-agent group when present (it may be more permissive)", async () => {
    const fetchImpl = robotsFetchMock(
      () =>
        new Response(
          "User-agent: *\nDisallow: /\n\nUser-agent: AusbildungsWegBot\nAllow: /dataset",
          { status: 200 },
        ),
    );
    await expect(
      robotsVerdictForUrl(url("/dataset/abc"), { fetchImpl: fetchImpl as never, now: () => T0 }),
    ).resolves.toBe("allowed");
  });

  it("supports exact-match ($) patterns", async () => {
    const fetchImpl = robotsFetchMock(
      () => new Response("User-agent: *\nDisallow: /export$", { status: 200 }),
    );
    await expect(
      robotsVerdictForUrl(url("/export"), { fetchImpl: fetchImpl as never, now: () => T0 }),
    ).resolves.toBe("disallowed");
    await expect(
      robotsVerdictForUrl(url("/export2"), { fetchImpl: fetchImpl as never, now: () => T0 }),
    ).resolves.toBe("allowed");
  });

  it("404 (no robots.txt) means no published restrictions → allowed", async () => {
    const fetchImpl = robotsFetchMock(() => new Response("not found", { status: 404 }));
    await expect(robotsVerdictForUrl(url("/dataset/abc"), { fetchImpl: fetchImpl as never, now: () => T0 })).resolves.toBe("allowed");
  });

  it("405 → allowed as well", async () => {
    const fetchImpl = robotsFetchMock(() => new Response("nope", { status: 405 }));
    await expect(robotsVerdictForUrl(url("/x"), { fetchImpl: fetchImpl as never, now: () => T0 })).resolves.toBe("allowed");
  });

  it("FAILS CLOSED: server error → unknown (treated as disallowed)", async () => {
    const fetchImpl = robotsFetchMock(() => new Response("boom", { status: 500 }));
    await expect(robotsVerdictForUrl(url("/x"), { fetchImpl: fetchImpl as never, now: () => T0 })).resolves.toBe("unknown");
  });

  it("FAILS CLOSED: network error → unknown", async () => {
    const fetchImpl = robotsFetchMock(() => {
      throw new Error("network down");
    });
    await expect(robotsVerdictForUrl(url("/x"), { fetchImpl: fetchImpl as never, now: () => T0 })).resolves.toBe("unknown");
  });

  it("FAILS CLOSED: undecodable body → unknown", async () => {
    const fetchImpl = robotsFetchMock(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("stream broken"));
            },
          }),
          { status: 200 },
        ),
    );
    await expect(robotsVerdictForUrl(url("/x"), { fetchImpl: fetchImpl as never, now: () => T0 })).resolves.toBe("unknown");
  });

  it("honors the robots cache TTL (refetches after expiry)", async () => {
    let clock = T0;
    const fetchImpl = robotsFetchMock(
      () => new Response("User-agent: *\nAllow: /", { status: 200 }),
    );
    await robotsVerdictForUrl(url("/a"), { fetchImpl: fetchImpl as never, now: () => clock });
    clock = T0 + LIMITS.robotsCacheTtlMs; // still cached
    await robotsVerdictForUrl(url("/b"), { fetchImpl: fetchImpl as never, now: () => clock });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock = T0 + LIMITS.robotsCacheTtlMs + 1; // expired
    await robotsVerdictForUrl(url("/c"), { fetchImpl: fetchImpl as never, now: () => clock });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
