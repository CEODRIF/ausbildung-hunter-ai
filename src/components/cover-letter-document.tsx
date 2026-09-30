import {
  bodyParagraphs,
  formatGermanDate,
  recipientLines,
  senderLines,
  type ClDocument,
} from "@/lib/templates/cover-letter";

/**
 * The Anschreiben — a single, pure presentational renderer of the
 * ClDocument: no state, no network, no editor chrome. Used twice:
 *   1. live preview (right column, scaled to fit)
 *   2. print root (portal on <body>, rendered only in @media print)
 * so the exported PDF is byte-for-byte the same document as the preview.
 *
 * Style: a real German business letter (DIN 5008 layout) — sender block
 * top-right, date below it, recipient left, bold subject, greeting,
 * justified body paragraphs, closing, signature. Monochrome ink on white
 * paper, no colors. The sheet is ALWAYS light and stays LTR even when the
 * application UI is Arabic.
 */

export const CL_SHEET_WIDTH = 794; // 210mm @ 96dpi
export const CL_SHEET_MIN_HEIGHT = 1123; // 297mm @ 96dpi

const INK = "#1c2430";
const MUTED = "#4a5260";

interface Props {
  doc: ClDocument;
}

export function CoverLetterDocument({ doc }: Props) {
  const dateLabel = formatGermanDate(doc.date);
  const { address, contact } = senderLines(doc.sender);
  const hasSender = Boolean(doc.sender.fullName.trim()) || address.length > 0 || contact.length > 0;
  const recipient = recipientLines(doc.recipient);
  const paragraphs = bodyParagraphs(doc);
  const subject = doc.subject.trim();
  const greeting = doc.greeting.trim();
  const closing = doc.closing.trim();
  const signature = doc.signature;

  return (
    <div
      dir="ltr"
      lang="de"
      className="cl-sheet"
      role="document"
      aria-label="Anschreiben"
      style={{
        width: CL_SHEET_WIDTH,
        minHeight: CL_SHEET_MIN_HEIGHT,
        backgroundColor: "#ffffff",
        color: INK,
        padding: "48px 60px 56px",
        fontFamily: "inherit",
        fontSize: 13.5,
        lineHeight: 1.55,
      }}
    >
      {/* Sender — top right (DIN 5008) */}
      {hasSender && (
        <div style={{ textAlign: "right", fontSize: 12.5, lineHeight: 1.5 }}>
          {doc.sender.fullName.trim() && (
            <div style={{ fontSize: 13, fontWeight: 600 }}>{doc.sender.fullName}</div>
          )}
          {address.map((line) => (
            <div key={`addr-${line}`} style={{ color: MUTED }}>
              {line}
            </div>
          ))}
          {contact.map((line) => (
            <div key={`contact-${line}`} style={{ color: MUTED, fontSize: 12 }}>
              {line}
            </div>
          ))}
        </div>
      )}

      {/* Date — right, below the sender */}
      {dateLabel && (
        <div
          style={{
            textAlign: "right",
            marginTop: hasSender ? 12 : 0,
            fontSize: 13,
          }}
        >
          {dateLabel}
        </div>
      )}

      {/* Recipient — left */}
      {recipient.length > 0 && (
        <div style={{ marginTop: 44, fontSize: 13, lineHeight: 1.55 }}>
          {recipient.map((line, index) => (
            <div key={`rec-${line}-${index}`} style={index === 0 ? { fontWeight: 600 } : undefined}>
              {line}
            </div>
          ))}
        </div>
      )}

      {/* Subject — prominent */}
      {subject && (
        <h2
          style={{
            margin: `${recipient.length > 0 ? 40 : hasSender || dateLabel ? 40 : 0}px 0 0`,
            fontSize: 14,
            fontWeight: 700,
            lineHeight: 1.4,
          }}
        >
          {subject}
        </h2>
      )}

      {/* Greeting */}
      {greeting && (
        <p style={{ margin: "30px 0 0", fontSize: 13.5 }}>{greeting}</p>
      )}

      {/* Body — justified paragraphs */}
      {paragraphs.map((paragraph, index) => (
        <p
          key={`p-${index}`}
          style={{
            margin: index === 0 ? "16px 0 0" : "12px 0 0",
            fontSize: 13.5,
            textAlign: "justify",
            overflowWrap: "break-word",
          }}
        >
          {paragraph}
        </p>
      ))}

      {/* Closing */}
      {closing && (
        <p style={{ margin: "28px 0 0", fontSize: 13.5 }}>{closing}</p>
      )}

      {/* Signature — image (if any) above the typed name */}
      {(signature.image || (signature.kind !== "none" && signature.text.trim())) && (
        <div style={{ marginTop: 34 }}>
          {signature.image && (
            // eslint-disable-next-line @next/next/no-img-element -- user-uploaded data URL, bounded size
            <img
              src={signature.image}
              alt="Unterschrift"
              style={{ maxWidth: 220, maxHeight: 96, display: "block" }}
            />
          )}
          {signature.kind !== "none" && signature.text.trim() && (
            <div style={{ fontSize: 13.5, marginTop: signature.image ? 6 : 0 }}>
              {signature.text}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
