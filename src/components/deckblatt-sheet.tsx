"use client";

/**
 * The Deckblatt A4 sheet as HTML/CSS — used by BOTH the on-screen preview
 * (scaled via useScaledSheet) and the print portal (PDF export).
 *
 * Geometry comes from the same layout constants and pure helpers as the
 * canvas PNG renderer (src/lib/deckblatt/render.ts), so the preview, the
 * PDF and the PNG stay visually identical:
 *  - name lines: nameDisplayLines() + nameLineSizes()
 *  - contact:    contactDisplayLines() + contactFontSize()
 *
 * `dir="ltr"` is FORCED: the sheet is a German Bewerbung document and must
 * stay left-to-right even when the app UI is Arabic (RTL).
 */
import type { CSSProperties } from "react";
import {
  DECKBLATT_HEIGHT,
  DECKBLATT_WIDTH,
  type DeckblattStyle,
} from "@/lib/deckblatt/styles";
import {
  contactDisplayLines,
  contactFontSize,
  fitFontSize,
  nameDisplayLines,
  nameLineSizes,
  type DeckblattData,
} from "@/lib/deckblatt/render";

/** Canvas textBaseline "alphabetic" ≈ baseline; the line box top sits one
 *  ascent (~0.8 em) above it. Shared by name + profession + contact. */
const ASCENT = 0.8;
const LINE_STRIDE = 1.12; // matches the canvas advance (size * 1.12)

export function DeckblattSheet({
  style,
  data,
  backgroundImage,
  photoUrl,
}: {
  style: DeckblattStyle;
  data: DeckblattData;
  backgroundImage: string;
  photoUrl: string;
}) {
  const L = style.layout;

  const nameLines = nameDisplayLines(data);
  const nameSizes = nameLineSizes(data, style);
  // Precompute each name line's baseline BEFORE the JSX (mirrors the canvas
  // advance: baseline_i = L.name.y + Σ_{j<i} size_j * LINE_STRIDE).
  const namePositions = nameLines.map((line, i) => {
    const size = nameSizes[i];
    const strideBefore = nameSizes
      .slice(0, i)
      .reduce((sum, s) => sum + s * LINE_STRIDE, 0);
    return {
      key: String(i),
      line,
      size,
      top: L.name.y + strideBefore - size * ASCENT,
    };
  });

  // Same fit clamp as the canvas renderer (render.ts): shrink the
  // profession to the name zone width, never below 28 design px.
  const professionSize = Math.max(
    28,
    fitFontSize(data.profession, 640, L.profession.size, false),
  );

  const contactLines = contactDisplayLines(data);
  const contactSize = contactFontSize(data, style);

  const photoStyle: CSSProperties = {
    position: "absolute",
    left: L.photo.x,
    top: L.photo.y,
    width: L.photo.w,
    height: L.photo.h,
    objectFit: "cover",
    borderRadius: L.photo.shape === "circle" ? "50%" : L.photo.radius,
    boxShadow: "0 0 0 6px rgba(255,255,255,0.55)",
  };

  return (
    <div
      className="deckblatt-sheet relative overflow-hidden bg-white"
      dir="ltr"
      style={{ width: DECKBLATT_WIDTH, height: DECKBLATT_HEIGHT }}
    >
      <div className="deckblatt-sheet-content absolute inset-0">
        {/* AI design background (cover-fit — the provider size may vary). */}
        {/* eslint-disable-next-line @next/next/no-img-element -- generated data URL, fixed A4 frame */}
        <img
          src={backgroundImage}
          alt=""
          draggable={false}
          className="absolute inset-0 h-full w-full object-cover"
        />
        {/* Accent band (under all text). */}
        {L.band && (
          <div
            style={{
              position: "absolute",
              left: L.band.x,
              top: L.band.y,
              width: L.band.w,
              height: L.band.h,
              background: L.band.color,
            }}
          />
        )}
        {/* Divider. */}
        <div
          style={{
            position: "absolute",
            left: L.divider.x,
            top: L.divider.y,
            width: L.divider.w,
            height: L.divider.h,
            background: L.divider.color,
          }}
        />
        {/* Portrait photo. */}
        {/* eslint-disable-next-line @next/next/no-img-element -- user-uploaded photo, fixed frame */}
        <img src={photoUrl} alt="" draggable={false} style={photoStyle} />
        {/* Name (explicit lines — identical breaks as the PNG). */}
        {namePositions.map((block) => (
          <div
            key={block.key}
            style={{
              position: "absolute",
              left: L.name.x,
              top: block.top,
              maxWidth: DECKBLATT_WIDTH - L.name.x * 2,
              fontSize: block.size,
              fontWeight: L.name.weight,
              fontFamily: L.nameFont,
              lineHeight: 1,
              color: L.name.color,
              whiteSpace: "nowrap",
            }}
          >
            {block.line}
          </div>
        ))}
        {/* Profession. */}
        <div
          style={{
            position: "absolute",
            left: L.profession.x,
            top: L.profession.y - professionSize * ASCENT,
            maxWidth: DECKBLATT_WIDTH - L.profession.x * 2,
            fontSize: professionSize,
            fontWeight: L.profession.weight,
            fontFamily: L.bodyFont,
            lineHeight: 1,
            color: L.profession.color,
            whiteSpace: "nowrap",
          }}
        >
          {data.profession}
        </div>
        {/* Contact block. */}
        {contactLines.map((line, i) => (
          <div
            key={`${line}-${i}`}
            style={{
              position: "absolute",
              left: L.contact.x,
              top: L.contact.y + i * L.contact.lineGap - contactSize * ASCENT,
              maxWidth: DECKBLATT_WIDTH - L.contact.x * 2,
              fontSize: contactSize,
              fontWeight: 400,
              fontFamily: L.bodyFont,
              lineHeight: 1,
              color: L.contact.color,
              whiteSpace: "nowrap",
            }}
          >
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}
