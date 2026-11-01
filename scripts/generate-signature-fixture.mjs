// One-off fixture generator (not part of the app bundle).
// Renders a signature-like SVG stroke to real PNG (transparent) + JPEG (white)
// files used by tests/bew-letter-signature-pdf.test.ts.
// Run: node scripts/generate-signature-fixture.mjs
import { mkdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const W = 480;
const H = 140;
const W2 = 320; // second fixture: a less wide ratio (exercises the height cap)
const W3 = 200; // third fixture: 1:1 square (height cap binds)
const W4 = 140; // fourth fixture: portrait 0.44 ratio (height cap binds)
const H4 = 320;

// Cursive, hand-drawn looking signature strokes (viewBox 0 0 480 140).
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <g fill="none" stroke="#1a1a1a" stroke-width="5" stroke-linecap="round">
    <path d="M 40 95 C 45 55, 70 35, 82 42 C 96 50, 84 92, 62 100 C 45 106, 42 84, 78 70 C 118 55, 138 58, 148 72 C 154 80, 166 78, 172 66 C 178 55, 186 58, 184 72 C 182 88, 196 84, 204 70 C 210 59, 220 60, 220 74 C 220 88, 232 86, 238 74 C 244 62, 254 64, 252 78 C 250 92, 262 88, 270 74"/>
    <path d="M 292 78 C 290 58, 306 48, 314 58 C 320 66, 310 76, 300 74 C 288 72, 292 92, 306 96 C 322 100, 334 82, 340 70 C 345 60, 354 62, 352 76 C 350 90, 362 88, 370 74 C 376 63, 386 66, 384 80 C 382 94, 394 90, 402 76"/>
    <path d="M 418 96 C 414 76, 430 58, 442 64 C 452 69, 446 88, 434 94 C 424 99, 418 90, 424 82"/>
    <path d="M 34 108 C 120 118, 300 112, 452 100" stroke-width="3"/>
  </g>
</svg>`;

const outDir = path.join("tests", "fixtures");
mkdirSync(outDir, { recursive: true });

const render = (w, h = H) => sharp(Buffer.from(svg), { density: 150 }).resize(w, h, { fit: "fill" });
await Promise.all([
  render(W).png().toFile(path.join(outDir, "signature-wide.png")),
  render(W)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality: 92 })
    .toFile(path.join(outDir, "signature-wide.jpg")),
  render(W2).png().toFile(path.join(outDir, "signature-medium.png")),
  render(W3, W3).png().toFile(path.join(outDir, "signature-square.png")),
  render(W4, H4).png().toFile(path.join(outDir, "signature-tall.png")),
]);
const meta = await Promise.all(
  ["signature-wide.png", "signature-wide.jpg", "signature-medium.png", "signature-square.png", "signature-tall.png"].map(
    (f) => sharp(path.join(outDir, f)).metadata(),
  ),
);
for (const m of meta) console.log(`${m.format}:`, m.width, "x", m.height);
