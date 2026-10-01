/** Route-level loading boundary for /opportunities/[id] — a real skeleton
 *  that appears instantly on navigation, so "View Details" never shows a
 *  blank frozen page while the server resolves the opportunity. */
export default function OpportunityDetailsLoading() {
  return (
    <div className="px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-4xl">
        <div className="shimmer h-5 w-44 rounded-lg" />
        <div className="mt-8 rounded-2xl border border-line bg-surface p-6 sm:p-8">
          <div className="flex flex-wrap gap-2">
            <div className="shimmer h-6 w-24 rounded-lg" />
            <div className="shimmer h-6 w-28 rounded-lg" />
            <div className="shimmer h-6 w-32 rounded-lg" />
          </div>
          <div className="shimmer mt-5 h-10 w-4/5 max-w-xl rounded-xl" />
          <div className="shimmer mt-3 h-4 w-3/5 max-w-md rounded-full" />
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            {Array.from({ length: 6 }, (_, index) => (
              <div
                key={index}
                className="shimmer h-16 rounded-xl border border-line"
              />
            ))}
          </div>
          <div className="shimmer mt-8 h-44 rounded-2xl border border-line" />
          <div className="shimmer mt-4 h-24 rounded-2xl" />
          <div className="mt-6 flex gap-3">
            <div className="shimmer h-11 w-44 rounded-xl" />
            <div className="shimmer h-11 w-48 rounded-xl" />
          </div>
        </div>
      </div>
    </div>
  );
}
