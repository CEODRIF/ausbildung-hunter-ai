import Link from "next/link";
import { Button } from "@/components/ui";
import { LogoMark } from "@/components/logo-mark";

const benefits = [
  {
    number: "01",
    title: "Find with clarity",
    text: "Bring the right opportunities into focus with a workspace made for your goals.",
  },
  {
    number: "02",
    title: "Move with confidence",
    text: "Keep your search organized so every next step feels simple and intentional.",
  },
  {
    number: "03",
    title: "Start your next chapter",
    text: "Build a path toward Ausbildung and jobs that match the future you want.",
  },
];

export default function Home() {
  return (
    <main className="min-h-screen overflow-hidden bg-white text-[#10203b]">
      <header className="relative z-10 mx-auto flex max-w-7xl items-center justify-between px-5 py-5 sm:px-8 lg:px-10">
        <Link href="/" className="flex items-center gap-2.5">
          <LogoMark size={38} />
          <span className="text-sm font-bold tracking-[-0.02em]">
            Ausbildung Hunter <span className="text-[#2f6fed]">AI</span>
          </span>
        </Link>
        <nav className="hidden items-center gap-8 text-sm font-semibold text-[#6d7d96] md:flex">
          <a href="#how-it-works" className="hover:text-[#2f6fed]">
            How it works
          </a>
          <a href="#why-us" className="hover:text-[#2f6fed]">
            Why us
          </a>
          <Link href="/login" className="text-[#1d3458] hover:text-[#2f6fed]">
            Log in
          </Link>
          <Link href="/register">
            <Button size="sm">
              Get started <span>→</span>
            </Button>
          </Link>
        </nav>
        <Link
          href="/login"
          className="text-sm font-semibold text-[#2f6fed] md:hidden"
        >
          Log in
        </Link>
      </header>
      <section className="relative mx-auto max-w-7xl px-5 pb-20 pt-16 sm:px-8 sm:pt-24 lg:px-10 lg:pb-28">
        <div className="pointer-events-none absolute -right-20 -top-20 h-[550px] w-[550px] rounded-full hero-orb" />
        <div className="grid-fade pointer-events-none absolute inset-x-0 bottom-0 h-72 opacity-50 [mask-image:linear-gradient(to_bottom,transparent,black)]" />
        <div className="relative max-w-3xl">
          <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-[#dce8ff] bg-[#f3f7ff] px-3.5 py-2 text-xs font-bold text-[#2f6fed]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#2f6fed]" />
            Your next opportunity starts here
          </div>
          <h1 className="max-w-3xl text-5xl font-bold leading-[1.04] tracking-[-0.055em] text-[#10203b] sm:text-7xl">
            Find the path that&apos;s{" "}
            <span className="text-[#2f6fed]">right for you.</span>
          </h1>
          <p className="mt-7 max-w-xl text-base leading-7 text-[#6d7d96] sm:text-lg">
            A focused workspace to discover Ausbildung and jobs in Germany, stay
            organized, and move forward with confidence.
          </p>
          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <Link href="/register">
              <Button size="lg">
                Create your workspace <span>→</span>
              </Button>
            </Link>
            <Link href="/dashboard">
              <Button size="lg" variant="secondary">
                Explore the dashboard
              </Button>
            </Link>
          </div>
        </div>
        <div
          className="relative mt-20 grid gap-4 border-t border-[#e8edf3] pt-8 sm:grid-cols-3 sm:gap-8"
          id="why-us"
        >
          {benefits.map((benefit) => (
            <div key={benefit.number}>
              <span className="text-xs font-bold tracking-[0.12em] text-[#2f6fed]">
                {benefit.number}
              </span>
              <h2 className="mt-3 text-lg font-bold text-[#1d3458]">
                {benefit.title}
              </h2>
              <p className="mt-2 max-w-xs text-sm leading-6 text-[#7a899f]">
                {benefit.text}
              </p>
            </div>
          ))}
        </div>
      </section>
      <section
        className="border-y border-[#edf1f5] bg-[#f8faff]"
        id="how-it-works"
      >
        <div className="mx-auto grid max-w-7xl gap-10 px-5 py-16 sm:px-8 lg:grid-cols-[0.8fr_1.2fr] lg:px-10 lg:py-20">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#2f6fed]">
              A better starting point
            </p>
            <h2 className="mt-4 max-w-md text-3xl font-bold leading-tight tracking-[-0.04em] text-[#10203b] sm:text-4xl">
              Less noise. More direction.
            </h2>
            <p className="mt-4 max-w-md text-sm leading-6 text-[#6d7d96]">
              Your search deserves a place that feels clear from the first
              click. Ausbildung Hunter AI is designed to help you focus on what
              matters.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-[#e5ebf4] bg-white p-5 card-shadow">
              <span className="text-2xl font-bold text-[#2f6fed]">↗</span>
              <h3 className="mt-8 font-bold text-[#1d3458]">
                One calm workspace
              </h3>
              <p className="mt-2 text-sm leading-6 text-[#7a899f]">
                Keep your opportunities and next steps in one focused place.
              </p>
            </div>
            <div className="rounded-2xl border border-[#e5ebf4] bg-white p-5 card-shadow sm:translate-y-6">
              <span className="text-2xl font-bold text-[#1b9b70]">✓</span>
              <h3 className="mt-8 font-bold text-[#1d3458]">
                Built for momentum
              </h3>
              <p className="mt-2 text-sm leading-6 text-[#7a899f]">
                Move from exploring to taking action without losing your way.
              </p>
            </div>
          </div>
        </div>
      </section>
      <footer className="mx-auto flex max-w-7xl flex-col gap-3 px-5 py-8 text-xs text-[#8b9ab0] sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-10">
        <span>© 2025 Ausbildung Hunter AI</span>
        <span>Built for your next chapter in Germany.</span>
      </footer>
    </main>
  );
}
