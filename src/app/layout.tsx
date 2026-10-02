import type { Metadata, Viewport } from "next";
import { Rubik } from "next/font/google";
import "./globals.css";
import { I18nProvider } from "@/lib/i18n";
import { langPreloadScript } from "@/lib/i18n/core";
import { themePreloadScript } from "@/lib/theme";

/** Single self-hosted family for every supported language: Rubik covers
 *  Latin (DE/EN/FR) and Arabic with one coherent geometric identity —
 *  downloaded and served locally at build time (no runtime network). */
const rubik = Rubik({
  subsets: ["latin", "latin-ext", "arabic"],
  weight: "variable",
  variable: "--font-ui",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Ausbildung Hunter AI",
    template: "%s | Ausbildung Hunter AI",
  },
  description:
    "A focused workspace for finding Ausbildung and jobs in Germany.",
};

/** iOS Safari: `viewport-fit=cover` extends the layout into the safe areas
 *  so `env(safe-area-inset-*)` (used by the chat composer's padding) is
 *  non-zero on notched devices. width/initialScale keep the baseline at
 *  1:1 — the precondition that prevents Safari's focus auto-zoom. */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="de" className={rubik.variable}>
      <head>
        {/* Apply the persisted theme (or OS preference) and language/RTL
            direction BEFORE first paint — prevents flash of wrong theme
            and an LTR frame when Arabic is selected. */}
        <script dangerouslySetInnerHTML={{ __html: themePreloadScript }} />
        <script dangerouslySetInnerHTML={{ __html: langPreloadScript() }} />
      </head>
      <body>
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
