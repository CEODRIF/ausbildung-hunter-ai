import type { Metadata } from "next";
import "./globals.css";

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
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
