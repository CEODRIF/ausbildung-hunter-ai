"use client";

/**
 * The Deckblatt A4 sheet as HTML/CSS — used by BOTH the on-screen preview
 * (scaled via useScaledSheet) and the print portal (PDF export).
 *
 * Geometry comes from the same layout constants and pure helpers as the
 * canvas PNG renderer (src/lib/deckblatt/render.ts), so the preview, the
 * PDF and the PNG stay visually identical:
 *  - name/profession/divider: heroBaselines() + nameLineSizes()/professionFontSize()
 *  - contact:    contactDisplayLines() + contactFontSize()
 *
 * The composition is a "designed page": a full-bleed AI background over
 * the style's neutral base gradient, a MAJOR portrait element (the
 * style's PORTRAIT_ZONE) and a deliberate, high-contrast contact card.
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
  heroBaselines,
  nameDisplayLines,
  nameLineSizes,
  professionFontSize,
  type DeckblattData,
} from "@/lib/deckblatt/render";

/** Canvas textBaseline "alphabetic" ≈ baseline; the line box top sits one
 *  ascent (~0.8 em) above it. Shared by name + profession + contact. */
const ASCENT = 0.8;

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
  const hero = heroBaselines(style, data);
  // Convert each name baseline to a CSS top (the line box top sits one
  // ascent above the baseline).
  const namePositions = nameLines.map((line, i) => ({
    key: String(i),
    line,
    size: nameSizes[i],
    top: hero.name[i] - nameSizes[i] * ASCENT,
  }));

  const professionSize = professionFontSize(data, style);
  const contactLines = contactDisplayLines(data);
  const contactSize = contactFontSize(data, style);

  const card = L.contactCard;
  const cardStyle: CSSProperties = {
    position: "absolute",
    left: card.x,
    top: card.y,
    width: card.w,
    height: card.h,
    background: card.background,
    border: `${card.borderWidth}px solid ${card.border}`,
    borderRadius: card.radius,
    overflow: "hidden",
  };

  const photoStyle: CSSProperties = {
    position: "absolute",
    left: L.photo.x,
    top: L.photo.y,
    width: L.photo.w,
    height: L.photo.h,
    objectFit: "cover",
    borderRadius: L.photo.shape === "circle" ? "50%" : L.photo.radius,
    boxShadow: `0 ${L.photoShadow.offsetY}px ${L.photoShadow.blur}px ${L.photoShadow.color}, 0 0 0 ${L.ring.width}px ${L.ring.color}`,
  };

  return (
    <div
      className="deckblatt-sheet relative overflow-hidden"
      dir="ltr"
      style={{
        width: DECKBLATT_WIDTH,
        height: DECKBLATT_HEIGHT,
        // Neutral base under the AI background (the sheet never shows raw
        // white if the design image fails to load).
        background: `linear-gradient(180deg, ${L.base.top} 0%, ${L.base.bottom} 100%)`,
      }}
    >
      <div className="deckblatt-sheet-content absolute inset-0">
        {/* AI design background — full-bleed, edge to edge. */}
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
        {/* Divider (a full-width rule passes behind the portrait). */}
        <div
          style={{
            position: "absolute",
            left: L.divider.x,
            top: hero.divider,
            width: L.divider.w,
            height: L.divider.h,
            background: L.divider.color,
          }}
        />
        {/* Contact card — the deliberate, high-contrast footer block. */}
        <div style={cardStyle}>
          {card.strip && (
            <div
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                bottom: 0,
                width: card.strip.w,
                background: card.strip.color,
              }}
            />
          )}
        </div>
        {/* Portrait photo — a major element in the style's PORTRAIT_ZONE. */}
        {/* eslint-disable-next-line @next/next/no-img-element -- user-uploaded photo, fixed frame */}
        <img src={photoUrl} alt="" draggable={false} style={photoStyle} />
        {/* Name (explicit lines — identical breaks and baselines as the PNG). */}
        {namePositions.map((block) => (
          <div
            key={block.key}
            style={{
              position: "absolute",
              left: L.name.x,
              top: block.top,
              maxWidth: L.name.w,
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
            top: hero.profession - professionSize * ASCENT,
            maxWidth: L.profession.w,
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
        {/* Contact block — inside the card. */}
        {contactLines.map((line, i) => (
          <div
            key={`${line}-${i}`}
            style={{
              position: "absolute",
              left: L.contact.x,
              top: L.contact.y + i * L.contact.lineGap - contactSize * ASCENT,
              maxWidth: L.contact.w,
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
