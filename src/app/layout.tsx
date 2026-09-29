import type { Metadata } from "next";
import "./globals.css";
import { I18nProvider } from "@/lib/i18n";
import { langPreloadScript } from "@/lib/i18n/core";
import { themePreloadScript } from "@/lib/theme";

export const metadata: Metadata = {
  title: {
    default: "Ausbildung Hunter AI",
    template: "%s | Ausbildung Hunter AI",
  },
  description:
    "A focused workspace for finding Ausbildung and jobs in Germany.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="de">
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
