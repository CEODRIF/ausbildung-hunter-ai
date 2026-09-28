"use client";

import { useState } from "react";
import Link from "next/link";
import { SaveOpportunityButton } from "@/components/opportunity-save-button";
import type {
  Opportunity,
  OpportunitySearchResponse,
} from "@/lib/opportunities/types";

interface OpportunitySearchProps {
  defaultGoal: "ausbildung" | "arbeit";
}

const FRESHNESS_OPTIONS = [
  { value: "any", label: "Any time" },
  { value: "today", label: "Published today" },
  { value: "14d", label: "Last 14 days" },
  { value: "30d", label: "Last 30 days" },
] as const;

function formatDay(iso: string | null): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? null
    : parsed.toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });
}

export function OpportunitySearch({ defaultGoal }: OpportunitySearchProps) {
  const [goal, setGoal] = useState<"ausbildung" | "arbeit">(defaultGoal);
  const [keyword, setKeyword] = useState("");
  const [role, setRole] = useState("");
  const [location, setLocation] = useState("");
  const [radius, setRadius] = useState("");
  const [company, setCompany] = useState("");
  const [freshness, setFreshness] =
    useState<(typeof FRESHNESS_OPTIONS)[number]["value"]>("any");
  const [matchOn, setMatchOn] = useState(true);
  const [results, setResults] = useState<Opportunity[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [scanTruncated, setScanTruncated] = useState(false);
  const [matchAvailable, setMatchAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function runSearch(event?: { preventDefault(): void }) {
    event?.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({
        goal,
        keyword: keyword.trim(),
        role: role.trim(),
        company: company.trim(),
        location: location.trim(),
        freshness,
        match: matchOn ? "true" : "false",
      });
      const radiusValue = Number(radius);
      if (
        radius &&
        Number.isInteger(radiusValue) &&
        radiusValue >= 5 &&
        radiusValue <= 100
      )
        query.set("radius", String(radiusValue));
      const response = await fetch(
        `/api/opportunities/search?${query.toString()}`,
      );
      const data = (await response.json()) as OpportunitySearchResponse & {
        error?: string;
      };
      if (!response.ok) throw new Error(data.error || "Search failed.");
      setResults(data.results);
      setTotal(data.total);
      setScanTruncated(data.scan_truncated);
      setMatchAvailable(data.match_available);
    } catch (searchError) {
      setResults(null);
      setTotal(null);
      setScanTruncated(false);
      setError(
        searchError instanceof Error
          ? searchError.message
          : "The opportunity search failed.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <form
        onSubmit={runSearch}
        className="rounded-2xl border border-[#e7ecf3] bg-white p-5 sm:p-6"
      >
        <div className="flex flex-wrap items-center gap-2">
          {(["ausbildung", "arbeit"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setGoal(value)}
              className={
                goal === value
                  ? "rounded-lg bg-[#10203b] px-4 py-2 text-xs font-bold text-white"
                  : "rounded-lg bg-[#f2f4f8] px-4 py-2 text-xs font-semibold text-[#71819a]"
              }
            >
              {value === "ausbildung" ? "Ausbildung" : "Arbeit"}
            </button>
          ))}
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <input
            className="rounded-xl border border-[#e7ecf3] px-4 py-3 text-sm text-[#10203b] outline-none focus:border-[#2f6fed]"
            placeholder="Keyword (e.g. mechatronics)"
            value={keyword}
            maxLength={120}
            onChange={(event) => setKeyword(event.target.value)}
          />
          <input
            className="rounded-xl border border-[#e7ecf3] px-4 py-3 text-sm text-[#10203b] outline-none focus:border-[#2f6fed]"
            placeholder="Role / occupation (e.g. Kaufmann)"
            value={role}
            maxLength={120}
            onChange={(event) => setRole(event.target.value)}
          />
          <input
            className="rounded-xl border border-[#e7ecf3] px-4 py-3 text-sm text-[#10203b] outline-none focus:border-[#2f6fed]"
            placeholder="City, PLZ or Bundesland"
            value={location}
            maxLength={120}
            onChange={(event) => setLocation(event.target.value)}
          />
          <input
            className="rounded-xl border border-[#e7ecf3] px-4 py-3 text-sm text-[#10203b] outline-none focus:border-[#2f6fed]"
            placeholder="Radius km (optional, 5–100)"
            inputMode="numeric"
            value={radius}
            onChange={(event) =>
              setRadius(event.target.value.replace(/[^0-9]/g, ""))
            }
          />
          <input
            className="rounded-xl border border-[#e7ecf3] px-4 py-3 text-sm text-[#10203b] outline-none focus:border-[#2f6fed]"
            placeholder="Company (optional)"
            value={company}
            maxLength={160}
            onChange={(event) => setCompany(event.target.value)}
          />
          <select
            className="rounded-xl border border-[#e7ecf3] bg-white px-4 py-3 text-sm text-[#10203b] outline-none focus:border-[#2f6fed]"
            value={freshness}
            onChange={(event) =>
              setFreshness(event.target.value as typeof freshness)
            }
            aria-label="Publication date"
          >
            {FRESHNESS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm font-medium text-[#546783]">
          <input
            type="checkbox"
            checked={matchOn}
            onChange={(event) => setMatchOn(event.target.checked)}
            className="h-4 w-4 accent-[#2f6fed]"
          />
          Show my match score
        </label>
        <button
          type="submit"
          disabled={loading}
          className="mt-5 w-full rounded-xl bg-[#2f6fed] px-5 py-3.5 text-sm font-semibold text-white transition hover:bg-[#2456c4] disabled:opacity-60"
        >
          {loading ? "Searching…" : "Search opportunities"}
        </button>
        {error && (
          <p className="mt-4 rounded-xl bg-[#fdeee8] p-3 text-sm font-medium text-[#b4543c]">
            {error}
          </p>
        )}
      </form>

      {results !== null && (
        <div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-semibold text-[#546783]">
              {total !== null ? `${total} result${total === 1 ? "" : "s"}` : ""}
              {scanTruncated &&
                " (server-side filter — first part of the source scanned)"}
            </p>
            {matchOn && !matchAvailable && (
              <Link
                href="/bewerbung-scanner"
                className="rounded-xl bg-[#fff4e5] px-3 py-2 text-xs font-bold text-[#a3611c]"
              >
                Match not available yet — run the Bewerbung Scanner to enable
                matching
              </Link>
            )}
          </div>
          <div className="mt-4 space-y-4">
            {results.length === 0 && (
              <div className="rounded-2xl border border-dashed border-[#dfe6f0] bg-white p-10 text-center text-sm text-[#8290a4]">
                No opportunities matched these filters.
              </div>
            )}
            {results.map((opportunity) => (
              <article
                key={opportunity.id}
                className="rounded-2xl border border-[#e7ecf3] bg-white p-5"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-lg bg-[#edf3ff] px-2 py-1 text-[10px] font-bold uppercase text-[#2f6fed]">
                        {opportunity.goal === "ausbildung"
                          ? "Ausbildung"
                          : "Arbeit"}
                      </span>
                      {opportunity.training_type && (
                        <span className="rounded-lg bg-[#f0e9fb] px-2 py-1 text-[10px] font-bold uppercase text-[#6b46c1]">
                          {opportunity.training_type
                            .toLowerCase()
                            .replaceAll("_", " ")}
                        </span>
                      )}
                      {opportunity.salary?.label && (
                        <span className="rounded-lg bg-[#e8f5ee] px-2 py-1 text-[10px] font-bold text-[#177a55]">
                          {opportunity.salary.label}
                        </span>
                      )}
                      {opportunity.home_office === true && (
                        <span className="rounded-lg bg-[#f2f4f8] px-2 py-1 text-[10px] font-bold text-[#546783]">
                          Home office
                        </span>
                      )}
                    </div>
                    <h2 className="mt-3 text-lg font-bold leading-6 text-[#1d3458]">
                      {opportunity.title}
                    </h2>
                    <p className="mt-1 text-sm text-[#71819a]">
                      {opportunity.company_name || "Company not listed"} ·{" "}
                      {opportunity.location || "Location not listed"}
                      {opportunity.distance_km !== null &&
                        ` · ${opportunity.distance_km} km`}
                    </p>
                    <p className="mt-1 text-xs text-[#8290a4]">
                      {[
                        opportunity.profession,
                        formatDay(opportunity.posted_at)
                          ? `Posted ${formatDay(opportunity.posted_at)}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    {opportunity.match && (
                      <div className="mt-3 rounded-xl bg-[#f7faff] p-3">
                        <p className="text-xs font-bold text-[#2f6fed]">
                          Match: {opportunity.match.match_score}%
                        </p>
                        <ul className="mt-1 space-y-0.5 text-xs text-[#546783]">
                          {opportunity.match.explanation
                            .slice(0, 3)
                            .map((line, index) => (
                              <li key={index}>{line}</li>
                            ))}
                        </ul>
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-3">
                    <Link
                      href={`/opportunities/${encodeURIComponent(opportunity.id)}`}
                      className="rounded-xl bg-[#10203b] px-4 py-2 text-xs font-semibold text-white"
                    >
                      View details
                    </Link>
                    <a
                      href={
                        opportunity.application_url ?? opportunity.source_url
                      }
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs font-bold text-[#2f6fed]"
                    >
                      Apply →
                    </a>
                    <SaveOpportunityButton
                      opportunityKey={opportunity.id}
                      initialSaved={false}
                    />
                  </div>
                </div>
              </article>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
