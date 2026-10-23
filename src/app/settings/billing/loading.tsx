export default function BillingLoading() {
  return (
    <div className="px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-3xl">
        <div className="shimmer h-32 rounded-2xl border border-line bg-surface" />
        <div className="shimmer mt-5 h-48 rounded-2xl border border-line bg-surface" />
        <div className="mt-5 grid gap-4 lg:grid-cols-3">
          {Array.from({ length: 3 }, (_, index) => (
            <div
              key={index}
              className="shimmer h-72 rounded-2xl border border-line bg-surface"
            />
          ))}
        </div>
        <div className="shimmer mt-6 h-80 rounded-2xl border border-line bg-surface" />
      </div>
    </div>
  );
}
