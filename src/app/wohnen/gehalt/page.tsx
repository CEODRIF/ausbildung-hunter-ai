import { SalaryCalculator } from "@/components/guides/salary-calculator";

/**
 * Brutto → Netto Rechner (Berechnungsjahr 2026, gesetzliche Werte).
 * The calculator is fully client-side (no API calls, no storage beyond the
 * form state); the page only provides the layout container.
 */
export default function GehaltPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 lg:px-10">
      <SalaryCalculator />
    </div>
  );
}
