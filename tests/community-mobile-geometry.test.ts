/**
 * Community chat — MOBILE GEOMETRY regression (real browser measurement).
 *
 * The iPhone defect this pins down: the composer vanished from the bottom of
 * the chat (the bottom nav appeared directly under the messages). Root cause:
 * the chat root was sized with `h-full` (height:100%) against the flex-1
 * <main>; iOS Safari did not resolve that percentage against a
 * flex-grow-sized box, so the column grew to its content height and the
 * overflow-hidden main clipped the composer below the fold.
 *
 * The architecture under test (mirrored 1:1 in the HTML replica below — the
 * class-string contracts are pinned separately in community-mobile-layout):
 *
 *   column:  height:100dvh, flex-col, overflow-hidden        (AppShell fill)
 *   topbar:  64px, shrink-0
 *   main:    position:relative, flex-1, min-height:0,        (AppShell fill)
 *            overflow:hidden — NO padding
 *   spacer:  112px (h-28), shrink-0 — bottom-nav reservation
 *   chat:    position:absolute; inset:0, flex-col            (CommunityChat)
 *   thead:   46px, shrink-0
 *   msgs:    flex-1, min-height:0, overflow-y-auto  ← ONLY scroller
 *   comp:    shrink-0 (typing row + input row)
 *   nav:     position:fixed; bottom:12px; height:89px; z:30 (floating glass)
 *
 * Headless Chrome is used as the measurement engine (the repo's standard
 * pattern, cf. deckblatt-composition.test.ts).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CHROME = "google-chrome";

/** Build the replica HTML (same box model as production, phone geometry). */
function buildReplicaHtml(): string {
  const messages = Array.from(
    { length: 40 },
    (_, i) => `<div class="msg">message ${i + 1}</div>`,
  ).join("");
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui, sans-serif; }
.column { display: flex; flex-direction: column; height: 100dvh; overflow: hidden; position: relative; }
.topbar { height: 64px; flex-shrink: 0; background: #e8e8ec; }
.main { position: relative; flex: 1 1 0%; min-height: 0; overflow: hidden; }
.spacer { height: 112px; flex-shrink: 0; }
.chat { position: absolute; inset: 0; display: flex; flex-direction: column; min-height: 0; }
.thead { height: 46px; flex-shrink: 0; background: #f4f4f6; border-bottom: 1px solid #ddd; }
.msgwrap { position: relative; flex: 1 1 0%; min-height: 0; }
.msgs { height: 100%; min-height: 0; overflow-y: auto; }
.msgs .inner { padding: 16px; }
.msg { height: 60px; margin-bottom: 12px; background: #cfe3f7; border-radius: 12px; }
.comp { flex-shrink: 0; border-top: 1px solid #ddd; background: #fafafa; padding: 6px 12px 12px; }
.typing { height: 20px; }
.inputrow { display: flex; align-items: flex-end; gap: 6px; border: 1px solid #ccc; border-radius: 16px; padding: 6px; background: #fff; }
.inputrow .icon { width: 36px; height: 36px; flex-shrink: 0; }
.inputrow .ta { flex: 1; height: 36px; }
.inputrow .send { width: 36px; height: 36px; flex-shrink: 0; background: #2563eb; border-radius: 12px; }
.nav { position: fixed; left: 12px; right: 12px; bottom: 12px; height: 89px; background: #1f2937; border-radius: 24px; z-index: 30; }
</style></head><body>
<div class="column" id="col">
  <div class="topbar" id="tb"></div>
  <main class="main" id="main">
    <div class="chat" id="chat">
      <div class="thead" id="thead"></div>
      <div class="msgwrap"><div class="msgs" id="msgs"><div class="inner">${messages}</div></div></div>
      <div class="comp" id="comp"><div class="typing"></div><div class="inputrow"><span class="icon"></span><span class="ta"></span><span class="send"></span></div></div>
    </div>
  </main>
  <div class="spacer" aria-hidden="true"></div>
</div>
<div class="nav" id="nav"></div>
<script>
function rect(id) {
  const b = document.getElementById(id).getBoundingClientRect();
  return { top: b.top, bottom: b.bottom, h: b.height };
}
const msgs = document.getElementById('msgs');
const out = {
  vh: window.innerHeight,
  col: rect('col'), tb: rect('tb'), main: rect('main'), chat: rect('chat'),
  thead: rect('thead'), msgs: { ...rect('msgs'), scrollH: msgs.scrollHeight, clientH: msgs.clientHeight },
  comp: rect('comp'), nav: rect('nav'),
  pageScrollH: document.documentElement.scrollHeight,
};
document.body.insertAdjacentHTML('beforeend', '<pre id="geo" data-done="1">' + JSON.stringify(out) + '</pre>');
</script></body></html>`;
}

/** Run the replica in headless Chrome and parse the injected measurement. */
function measure(): Record<string, unknown> {
  const dir = mkdtempSync(join(tmpdir(), "community-geo-"));
  const htmlPath = join(dir, "repro.html");
  writeFileSync(htmlPath, buildReplicaHtml(), "utf8");
  const dom = execFileSync(
    CHROME,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--hide-scrollbars",
      "--dump-dom",
      "--window-size=390,844",
      "--virtual-time-budget=4000",
      `file://${htmlPath}`,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 90_000 },
  );
  // The prefix also occurs inside the inlined <script> source — require the
  // JSON object ({...}) directly after it so only the INJECTED pre matches.
  const m = dom.match(/<pre id="geo" data-done="1">(\{[\s\S]*?\})<\/pre>/);
  if (!m) throw new Error("measurement block missing from rendered DOM");
  return JSON.parse(m[1]) as Record<string, unknown>;
}

type Rect = { top: number; bottom: number; h: number };

describe("community mobile geometry (measured in headless Chrome, phone viewport)", () => {
  const g = measure();
  const col = g.col as Rect;
  const main = g.main as Rect;
  const chat = g.chat as Rect;
  const msgs = g.msgs as Rect & { scrollH: number; clientH: number };
  const comp = g.comp as Rect;
  const nav = g.nav as Rect;

  it("the shell column is exactly the viewport and never taller (no page scroll)", () => {
    expect(Math.abs(col.bottom - (g.vh as number))).toBeLessThanOrEqual(1);
    expect(g.pageScrollH as number).toBeLessThanOrEqual((g.vh as number) + 1);
  });

  it("main (the chat box) is a definite height: viewport − top bar − nav reservation", () => {
    const vh = g.vh as number;
    expect(Math.abs(main.h - (vh - 64 - 112))).toBeLessThanOrEqual(1);
    expect(main.h).toBeGreaterThan(0);
  });

  it("the chat root fills main EXACTLY (absolute inset-0, no clipping, no gap)", () => {
    expect(Math.abs(chat.top - main.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(chat.bottom - main.bottom)).toBeLessThanOrEqual(1);
  });

  it("the composer is VISIBLE inside the viewport (the reported bug)", () => {
    const vh = g.vh as number;
    expect(comp.top).toBeGreaterThanOrEqual(64); // below the top bar
    expect(comp.bottom).toBeLessThanOrEqual(vh); // inside the viewport
    expect(comp.h).toBeGreaterThan(50); // not collapsed
  });

  it("the bottom nav does NOT cover the composer (layering: messages → typing → composer → nav)", () => {
    // The nav floats at the very bottom; the composer must end above it.
    expect(comp.bottom).toBeLessThanOrEqual(nav.top);
    // …and the nav must start below the chat box's bottom edge (the spacer
    // reserved its room), so it can never overlap chat content at all.
    expect(nav.top).toBeGreaterThanOrEqual(main.bottom - 1);
  });

  it("the message list is the ONLY scroller and it actually scrolls", () => {
    expect(msgs.clientH).toBeGreaterThan(0);
    expect(msgs.scrollH).toBeGreaterThan(msgs.clientH);
    // The chat column itself does not scroll: content fits the definite box.
    expect(chat.h).toBeLessThanOrEqual(main.h + 1);
  });
});
