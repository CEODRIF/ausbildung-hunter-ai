/** Auth guard + global shell now live in ../layout.tsx — pure pass-through. */
export default function UsageLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}
