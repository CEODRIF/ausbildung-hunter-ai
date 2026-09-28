import Link from "next/link";

export function AuthShell({
  children,
  title,
  subtitle,
}: {
  children: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <main className="grid min-h-screen bg-white lg:grid-cols-[0.95fr_1.05fr]">
      <section className="relative hidden overflow-hidden bg-[#10203b] px-12 py-12 text-white lg:flex lg:flex-col lg:justify-between xl:px-20">
        <div className="absolute -right-32 top-8 h-[500px] w-[500px] rounded-full hero-orb" />
        <div className="relative">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#2f6fed] text-lg font-bold">
              A
            </span>
            <span className="text-sm font-bold">
              Ausbildung Hunter <span className="text-[#7eaeff]">AI</span>
            </span>
          </Link>
        </div>
        <div className="relative max-w-md pb-10">
          <div className="mb-7 flex h-12 w-12 items-center justify-center rounded-2xl bg-white/10 text-[#a9c7ff]">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
            >
              <path d="M4 18V6M4 18h16M7 15l3-4 3 2 4-6" />
            </svg>
          </div>
          <h2 className="text-4xl font-bold leading-[1.08] tracking-[-0.04em]">
            Build a career
            <br />
            you can be proud of.
          </h2>
          <p className="mt-5 max-w-sm text-[15px] leading-7 text-[#b7c4d7]">
            A calm, focused workspace for finding the right Ausbildung and job
            opportunities in Germany.
          </p>
          <div className="mt-10 flex items-center gap-3 text-sm text-[#d8e1ef]">
            <span className="flex -space-x-2">
              <span className="h-7 w-7 rounded-full border-2 border-[#10203b] bg-[#f1c7ab]" />
              <span className="h-7 w-7 rounded-full border-2 border-[#10203b] bg-[#9db8d5]" />
              <span className="h-7 w-7 rounded-full border-2 border-[#10203b] bg-[#d7a6c4]" />
            </span>
            <span>Made for your next chapter</span>
          </div>
        </div>
        <p className="relative text-xs text-[#8d9db4]">
          © 2025 Ausbildung Hunter AI
        </p>
      </section>
      <section className="flex items-center justify-center px-5 py-10 sm:px-8">
        <div className="w-full max-w-[430px]">
          <div className="mb-10 lg:hidden">
            <Link href="/" className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#2f6fed] text-lg font-bold text-white">
                A
              </span>
              <span className="text-sm font-bold text-[#10203b]">
                Ausbildung Hunter <span className="text-[#2f6fed]">AI</span>
              </span>
            </Link>
          </div>
          <div className="mb-8">
            <h1 className="text-3xl font-bold tracking-[-0.035em] text-[#10203b]">
              {title}
            </h1>
            <p className="mt-2 text-sm leading-6 text-[#71819a]">{subtitle}</p>
          </div>
          {children}
        </div>
      </section>
    </main>
  );
}
