"use client";

import { useEffect } from "react";

/** Root error boundary. Must be self-contained (it replaces the root
 *  layout, so it renders its own <html>/<body>). Phase 11 — the last
 *  missing error boundary in the app. */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    const stack = error?.stack;
    if (Array.isArray(stack)) stack.forEach((line) => console.error(line));
    else if (stack) console.error(stack);
  }, [error]);

  return (
    <html lang="en">
      <body className="bg-[#f6f8fb]">
        <main className="flex min-h-screen items-center justify-center p-5">
          <div className="w-full max-w-md rounded-2xl border border-[#edf0f4] bg-white p-8 text-center">
            <h1 className="text-xl font-bold text-[#10203b]">
              Something went wrong
            </h1>
            <p className="mt-2 text-sm leading-6 text-[#71819a]">
              An unexpected error interrupted the app. Your data is safe — try
              loading the page again.
            </p>
            <button
              onClick={reset}
              className="mt-6 h-10 rounded-xl bg-[#2f6fed] px-5 text-sm font-semibold text-white hover:bg-[#255dcc]"
              type="button"
            >
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
