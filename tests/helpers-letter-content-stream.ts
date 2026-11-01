/**
 * Shared raw PDF content-stream parser for the Anschreiben test suites.
 *
 * Extracted verbatim from tests/bew-letter-signature-pdf.test.ts so the
 * PREVIEW suite (tests/auto-bewerb-pdf-preview.test.ts) can assert the exact
 * signature geometry from the SAME raw drawing operators (text items with
 * their Tm position, image paint ops with their composite CTM → exact
 * x/y/width/height in points) — never a "/Subtype /Image" string check.
 */
import zlib from "node:zlib";
import { PDFArray, PDFDocument, PDFName, PDFRawStream, PDFRef } from "pdf-lib";

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** CTM' = M × CTM (the PDF `cm` operator post-multiplies the CTM). */
export function mulMatrix(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

export function decodePdfString(token: string): string {
  if (token.startsWith("<") && token.endsWith(">")) {
    // pdf-lib writes WinAnsi text as hex strings — 1 byte/char, latin1-safe.
    return new TextDecoder("latin1").decode(Buffer.from(token.slice(1, -1), "hex"));
  }
  if (token.startsWith("(") && token.endsWith(")")) {
    return token.slice(1, -1).replace(/\\([()\\])/g, "$1");
  }
  return "";
}

/** Minimal content-stream tokenizer (operators, numbers, names, strings, [] ). */
export function tokenizeStream(stream: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = stream.length;
  while (i < n) {
    const ch = stream[i];
    if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t" || ch === "\f" || ch === "\0" || ch === "\b") {
      i++;
      continue;
    }
    if (ch === "%") {
      while (i < n && stream[i] !== "\n") i++;
      continue;
    }
    if (ch === "(") {
      let depth = 1;
      let j = i + 1;
      let out = "";
      while (j < n && depth > 0) {
        const c = stream[j];
        if (c === "\\") {
          out += c + (stream[j + 1] ?? "");
          j += 2;
          continue;
        }
        if (c === "(") depth++;
        else if (c === ")") {
          depth--;
          if (depth === 0) {
            j++;
            break;
          }
        }
        out += c;
        j++;
      }
      tokens.push(`(${out})`);
      i = j;
      continue;
    }
    if (ch === "<") {
      if (stream[i + 1] === "<") {
        i += 2; // dictionary start — never used inside content streams
        continue;
      }
      const end = stream.indexOf(">", i + 1);
      tokens.push(stream.slice(i, end + 1));
      i = end + 1;
      continue;
    }
    if (ch === ">") {
      i++;
      continue;
    }
    if (ch === "[" || ch === "]") {
      tokens.push(ch);
      i++;
      continue;
    }
    let out = "";
    while (i < n && !/[\s()<>%\[\]]/.test(stream[i])) {
      out += stream[i];
      i++;
    }
    tokens.push(out);
  }
  return tokens;
}

export interface StreamTextItem {
  kind: "text";
  text: string;
  /** baseline x / y in PDF points (bottom-left origin). */
  x: number;
  y: number;
  /** position among all drawn items — the PDF's drawing order. */
  order: number;
}
export interface StreamImageItem {
  kind: "image";
  name: string;
  /** placement rect in PDF points (from the composite CTM at `Do`). */
  x: number;
  y: number;
  width: number;
  height: number;
  order: number;
}
export type StreamItem = StreamTextItem | StreamImageItem;

/** Parse a content stream into its drawn items, in drawing order. */
export function parseContentStream(stream: string): StreamItem[] {
  const tokens = tokenizeStream(stream);
  const items: StreamItem[] = [];
  const ctmStack: Matrix[] = [IDENTITY];
  let ctm: Matrix = IDENTITY;
  let tm: Matrix = IDENTITY;
  let inText = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "q") {
      ctmStack.push(ctm);
      ctm = IDENTITY;
      continue;
    }
    if (t === "Q") {
      ctm = ctmStack.pop() ?? IDENTITY;
      continue;
    }
    if (t === "cm" && i >= 6) {
      ctm = mulMatrix(tokens.slice(i - 6, i).map(Number) as Matrix, ctm);
      continue;
    }
    if (t === "BT") {
      inText = true;
      tm = IDENTITY;
      continue;
    }
    if (t === "ET") {
      inText = false;
      continue;
    }
    if (t === "Tm" && i >= 6) {
      tm = tokens.slice(i - 6, i).map(Number) as Matrix;
      continue;
    }
    if (inText && (t === "Tj" || t === "'")) {
      items.push({ kind: "text", text: decodePdfString(tokens[i - 1] ?? ""), x: tm[4], y: tm[5], order: items.length });
      continue;
    }
    if (inText && t === "TJ") {
      let j = i - 1;
      while (j >= 0 && tokens[j] !== "[") j--;
      const parts: string[] = [];
      for (let k = j + 1; k < i; k++) {
        const tok = tokens[k];
        if (tok.startsWith("<") || tok.startsWith("(")) parts.push(decodePdfString(tok));
      }
      items.push({ kind: "text", text: parts.join(""), x: tm[4], y: tm[5], order: items.length });
      continue;
    }
    if (t === "Do") {
      items.push({
        kind: "image",
        name: tokens[i - 1] ?? "",
        x: ctm[4],
        y: ctm[5],
        width: Math.abs(ctm[0]),
        height: Math.abs(ctm[3]),
        order: items.length,
      });
      continue;
    }
  }
  return items;
}

/** The (decompressed) raw content stream of one page. */
export async function contentStreamOf(bytes: Uint8Array, pageIndex = 0): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const contents = doc.getPage(pageIndex).node.get(PDFName.of("Contents"));
  const refs: PDFRef[] = contents instanceof PDFArray ? (contents.asArray() as PDFRef[]) : [contents as PDFRef];
  let out = "";
  for (const ref of refs) {
    const obj = doc.context.lookup(ref);
    if (!(obj instanceof PDFRawStream)) continue;
    let data: Uint8Array = obj.contents;
    const filter = obj.dict.get(PDFName.of("Filter"));
    if (filter && String(filter).includes("Flate")) data = new Uint8Array(zlib.inflateSync(Buffer.from(data)));
    out += new TextDecoder("latin1").decode(data) + "\n";
  }
  return out;
}

export async function streamItems(bytes: Uint8Array, pageIndex = 0): Promise<StreamItem[]> {
  return parseContentStream(await contentStreamOf(bytes, pageIndex));
}
