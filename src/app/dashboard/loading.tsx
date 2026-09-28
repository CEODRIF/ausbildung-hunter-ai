export default function DashboardLoading() {
  return (
    <div className="mx-auto max-w-7xl px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <div className="shimmer h-4 w-36 rounded-full" />
      <div className="shimmer mt-4 h-10 w-80 max-w-full rounded-xl" />
      <div className="shimmer mt-3 h-4 w-64 rounded-full" />
      <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div
            key={index}
            className="shimmer h-36 rounded-2xl border border-[#e7ecf3] bg-white"
          />
        ))}
      </div>
      <div className="mt-8 grid gap-5 xl:grid-cols-[1.3fr_0.7fr]">
        <div className="shimmer h-72 rounded-2xl border border-[#e7ecf3] bg-white" />
        <div className="shimmer h-72 rounded-2xl border border-[#e7ecf3] bg-white" />
      </div>
    </div>
  );
}
