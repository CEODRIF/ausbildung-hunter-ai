"use client";

import { useState } from "react";
import Link from "next/link";
import type { Opportunity } from "@/lib/opportunities/types";

export function OpportunitySearch({
  initialGoal,
}: {
  initialGoal: "ausbildung" | "arbeit";
}) {
  const [goal, setGoal] = useState(initialGoal);
  const [keyword, setKeyword] = useState("");
  const [city, setCity] = useState("");
  const [profession, setProfession] = useState("");
  const [match, setMatch] = useState(false);
  const [freshnessDays, setFreshnessDays] = useState(30);
  const [remoteType, setRemoteType] = useState("");
  const [radius, setRadius] = useState(25);
  const [results, setResults] = useState<Opportunity[]>([]);
  const [warning, setWarning] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const search = async () => {
    setLoading(true);
    setError("");
    setWarning("");
    const query = new URLSearchParams({
      goal,
      keyword,
      profession,
      city,
      match: String(match),
      freshnessDays: String(freshnessDays),
      radius: String(radius),
      ...(remoteType ? { remoteType } : {}),
      page: "1",
      pageSize: "20",
    });
    try {
      const response = await fetch(`/api/opportunities/search?${query}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Search failed.");
      setResults(data.results);
      if (data.warnings?.length) setWarning(data.warnings.join(" "));
    } catch (searchError) {
      setError(
        searchError instanceof Error ? searchError.message : "Search failed.",
      );
    } finally {
      setLoading(false);
    }
  };
  const save = async (opportunity: Opportunity) => {
    const isSaved = saved.has(opportunity.id);
    await fetch("/api/opportunities/save", {
      method: isSaved ? "DELETE" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        isSaved ? { opportunityKey: opportunity.id } : { opportunity },
      ),
    });
    setSaved((items) => {
      const next = new Set(items);
      if (isSaved) next.delete(opportunity.id);
      else next.add(opportunity.id);
      return next;
    });
  };
  return (
    <div>
      <section className="rounded-2xl border border-[#e7ecf3] bg-white p-5 sm:p-6">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setGoal("ausbildung")}
            className={`rounded-xl px-4 py-2 text-xs font-bold ${goal === "ausbildung" ? "bg-[#edf3ff] text-[#2f6fed]" : "bg-[#f4f7fc] text-[#71819a]"}`}
          >
            Ausbildung
          </button>
          <button
            type="button"
            onClick={() => setGoal("arbeit")}
            className={`rounded-xl px-4 py-2 text-xs font-bold ${goal === "arbeit" ? "bg-[#edf3ff] text-[#2f6fed]" : "bg-[#f4f7fc] text-[#71819a]"}`}
          >
            Arbeit
          </button>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <input
            className="h-11 rounded-xl border border-[#dfe6f0] px-3 text-sm"
            placeholder="Keyword"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
          />
          <input
            className="h-11 rounded-xl border border-[#dfe6f0] px-3 text-sm"
            placeholder="Profession / role"
            value={profession}
            onChange={(event) => setProfession(event.target.value)}
          />
          <input
            className="h-11 rounded-xl border border-[#dfe6f0] px-3 text-sm"
            placeholder="City or Bundesland"
            value={city}
            onChange={(event) => setCity(event.target.value)}
          />
          <input
            className="h-11 rounded-xl border border-[#dfe6f0] px-3 text-sm"
            placeholder="Radius (km)"
            type="number"
            min="0"
            max="200"
            value={radius}
            onChange={(event) => setRadius(Number(event.target.value) || 0)}
          />
          <select
            className="h-11 rounded-xl border border-[#dfe6f0] px-3 text-sm"
            value={remoteType}
            onChange={(event) => setRemoteType(event.target.value)}
          >
            <option value="">Remote type</option>
            <option value="remote">Remote</option>
            <option value="onsite">On-site</option>
            <option value="hybrid">Hybrid</option>
          </select>
          <input
            className="h-11 rounded-xl border border-[#dfe6f0] px-3 text-sm"
            placeholder="Freshness (days)"
            type="number"
            min="0"
            max="100"
            value={freshnessDays}
            onChange={(event) =>
              setFreshnessDays(Number(event.target.value) || 0)
            }
          />
          <button
            type="button"
            onClick={() => void search()}
            disabled={loading}
            className="h-11 rounded-xl bg-[#2f6fed] text-sm font-semibold text-white disabled:opacity-50"
          >
            {loading ? "Searching..." : "Search"}
          </button>
        </div>
        <label className="mt-4 flex items-center gap-2 text-xs font-semibold text-[#546783]">
          <input
            type="checkbox"
            checked={match}
            onChange={(event) => setMatch(event.target.checked)}
          />
          Match against my Bewerbung
        </label>
      </section>
      {warning && (
        <p className="mt-4 rounded-xl border border-[#f5e3bd] bg-[#fffaf0] px-4 py-3 text-sm text-[#9b6b1d]">
          {warning}
        </p>
      )}
      {error && (
        <p className="mt-4 rounded-xl border border-[#f5d7da] bg-[#fff8f8] px-4 py-3 text-sm text-[#a3404b]">
          {error}
        </p>
      )}
      <div className="mt-6 space-y-3">
        {results.map((opportunity) => (
          <OpportunityCard
            key={opportunity.id}
            opportunity={opportunity}
            saved={saved.has(opportunity.id)}
            onSave={() => void save(opportunity)}
          />
        ))}
        {!loading && !results.length && (
          <div className="rounded-2xl border border-dashed border-[#dfe6f0] bg-white p-10 text-center text-sm text-[#8290a4]">
            Search the Bundesagentur für Arbeit Jobsuche for real vacancies.
          </div>
        )}
      </div>
    </div>
  );
}
function OpportunityCard({
  opportunity,
  saved,
  onSave,
}: {
  opportunity: Opportunity;
  saved: boolean;
  onSave: () => void;
}) {
  return (
    <article className="rounded-2xl border border-[#e7ecf3] bg-white p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <span className="rounded-lg bg-[#edf3ff] px-2 py-1 text-[10px] font-bold uppercase text-[#2f6fed]">
            {opportunity.goal}
          </span>
          <h2 className="mt-3 text-lg font-bold text-[#1d3458]">
            {opportunity.title}
          </h2>
          <p className="mt-1 text-sm text-[#71819a]">
            {opportunity.company_name || "Company not listed"} ·{" "}
            {opportunity.location || "Location not listed"}
          </p>
        </div>
        <button
          type="button"
          onClick={onSave}
          className="text-sm font-bold text-[#2f6fed]"
        >
          {saved ? "Saved" : "Save"}
        </button>
      </div>
      {opportunity.match && (
        <p className="mt-4 text-sm font-semibold text-[#1b9b70]">
          {opportunity.match.match_score}% deterministic match ·{" "}
          {opportunity.match.explanation[0]}
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2 text-xs text-[#8290a4]">
        <span>Source: {opportunity.source_name}</span>
        <span>
          Retrieved:{" "}
          {new Date(opportunity.retrieved_at).toLocaleDateString("en-GB")}
        </span>
        {opportunity.start_date && <span>Start: {opportunity.start_date}</span>}
      </div>
      <div className="mt-5 flex gap-3">
        <Link
          href={`/opportunities/${encodeURIComponent(opportunity.id)}`}
          className="rounded-xl border border-[#dbe3ef] px-4 py-2 text-xs font-bold text-[#2f6fed]"
        >
          View details
        </Link>
        <a
          href={opportunity.source_url}
          target="_blank"
          rel="noreferrer"
          className="rounded-xl bg-[#10203b] px-4 py-2 text-xs font-bold text-white"
        >
          Open original vacancy
        </a>
      </div>
    </article>
  );
}
