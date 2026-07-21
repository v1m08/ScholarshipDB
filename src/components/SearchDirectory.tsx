"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { US_STATE_NAMES } from "@/lib/facets";
import {
  formatDate,
  formatMoney,
  isClosed,
  localDateString,
  type CatalogMetadata,
  type ScholarshipSummary,
  type SearchSummaryResponse,
} from "@/lib/scholarship";

interface SearchDirectoryProps {
  initial: SearchSummaryResponse;
  facets: CatalogMetadata["facets"];
}

const PAGE_SIZE = 30;

export function SearchDirectory({ initial, facets }: SearchDirectoryProps) {
  const [query, setQuery] = useState("");
  const [grade, setGrade] = useState("");
  const [tag, setTag] = useState("");
  const [state, setState] = useState("");
  const [minimumAward, setMinimumAward] = useState("");
  const [institutionScope, setInstitutionScope] = useState("all");
  const [includeClosed, setIncludeClosed] = useState(false);
  const [vettedOnly, setVettedOnly] = useState(false);
  const [results, setResults] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchError, setSearchError] = useState("");
  const initialSearch = useRef(true);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const asOfDate = localDateString();

  const parametersForSearch = useCallback((page = 1, cursor?: string) => {
    const parameters = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (query.trim()) parameters.set("q", query.trim());
    if (grade) parameters.set("grade", grade);
    if (tag) parameters.set("tag", tag);
    if (state) parameters.set("state", state);
    if (minimumAward) parameters.set("minimumAward", minimumAward);
    if (institutionScope !== "all") parameters.set("institutionScope", institutionScope);
    if (includeClosed) parameters.set("includeClosed", "true");
    if (vettedOnly) parameters.set("vettedOnly", "true");
    if (cursor) parameters.set("cursor", cursor);
    return parameters;
  }, [grade, includeClosed, institutionScope, minimumAward, query, state, tag, vettedOnly]);

  useEffect(() => {
    if (initialSearch.current) {
      initialSearch.current = false;
      return;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setLoading(true);
      setSearchError("");
      try {
        const response = await fetch(`/api/search?${parametersForSearch()}`, { signal: controller.signal });
        if (!response.ok) throw new Error("Search request failed");
        setResults((await response.json()) as SearchSummaryResponse);
      } catch {
        if (!controller.signal.aborted) setSearchError("Scholarship search is temporarily unavailable. Please try again.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 150);
    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [parametersForSearch]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || results.hasMore === false || results.records.length >= results.total) return;
    const observer = new IntersectionObserver(async (entries) => {
      if (!entries.some((entry) => entry.isIntersecting) || loadingMore) return;
      setLoadingMore(true);
      try {
        const response = await fetch(`/api/search?${parametersForSearch(results.page + 1, results.nextCursor)}`);
        if (!response.ok) throw new Error("Search continuation failed");
        const next = await response.json() as SearchSummaryResponse;
        setResults((current) => ({ ...next, total: current.total, rawTotal: current.rawTotal, records: [...current.records, ...next.records] }));
      } finally {
        setLoadingMore(false);
      }
    }, { rootMargin: "900px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [loadingMore, parametersForSearch, results]);

  return (
    <section className="directory" aria-label="Scholarship directory">
      <div className="filters">
        <label className="query"><span>Search scholarships</span><input autoComplete="off" onChange={(event) => setQuery(event.target.value)} placeholder="engineering, Maryland, first generation..." type="search" value={query} /></label>
        <label><span>Grade</span><select onChange={(event) => setGrade(event.target.value)} value={grade}><option value="">Any grade</option>{facets.grades.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label><span>Student tag</span><select onChange={(event) => setTag(event.target.value)} value={tag}><option value="">Any tag</option>{facets.tags.map((value) => <option key={value} value={value}>{value.replaceAll("-", " ")}</option>)}</select></label>
        <label><span>State-specific</span><select onChange={(event) => setState(event.target.value)} value={state}><option value="">Any location</option>{facets.states.map((value) => <option key={value} value={value}>{US_STATE_NAMES[value] || value}</option>)}</select></label>
        <label><span>Minimum award</span><select onChange={(event) => setMinimumAward(event.target.value)} value={minimumAward}><option value="">Any amount</option><option value="1000">$1,000+</option><option value="5000">$5,000+</option><option value="10000">$10,000+</option></select></label>
        <label><span>Institution scope</span><select onChange={(event) => setInstitutionScope(event.target.value)} value={institutionScope}><option value="all">All opportunities</option><option value="general">General only</option><option value="institution">College-specific only</option></select></label>
        <div className="filter-actions">
          <label className="toggle-bar"><input checked={includeClosed} onChange={(event) => setIncludeClosed(event.target.checked)} type="checkbox" /><span><strong>{includeClosed ? "Past deadlines included" : "Showing active deadlines only"}</strong><small>Toggle for showing differing deadlines</small></span></label>
          <label className="toggle-bar"><input checked={vettedOnly} onChange={(event) => setVettedOnly(event.target.checked)} type="checkbox" /><span><strong>Vetted scholarships only</strong><small>Show records with a Vetted check</small></span></label>
        </div>
      </div>
      <div className="result-header" aria-live="polite"><strong>{results.total}</strong> listing{results.total === 1 ? "" : "s"} found<span>{loading ? "Searching..." : "Source-linked opportunities."}</span></div>
      {searchError && <p className="search-error" role="alert">{searchError}</p>}
      <div className="results directory-table" role="table" aria-label="Scholarship listings">
        <div className="directory-table-head" role="row"><span role="columnheader">Scholarship</span><span role="columnheader">Deadline</span><span role="columnheader">Eligibility</span><span role="columnheader">Award</span></div>
        {results.records.map((record) => <ScholarshipRow asOfDate={asOfDate} key={record.id} record={record} />)}
        {!results.records.length && <div className="empty">No listings match those filters. Show past deadlines or broaden one filter.</div>}
      </div>
      {results.hasMore !== false && results.records.length < results.total && <div className="load-sentinel" ref={sentinel} aria-live="polite">{loadingMore ? "Loading more scholarships..." : "More scholarships load as you scroll."}</div>}
    </section>
  );
}

function ScholarshipRow({ asOfDate, record }: { asOfDate: string; record: ScholarshipSummary }) {
  const closed = isClosed(record, asOfDate);
  return <Link aria-label={`View details for ${record.title}`} className={closed ? "scholarship-row closed-card" : "scholarship-row open-card"} href={`/scholarships/${record.id}`} prefetch={false} role="row">
    <span className="scholarship-row-main" role="cell"><span className="scholarship-row-heading"><strong className="scholarship-row-title">{record.title}</strong>{record.vetting?.status !== "unvetted" && <span className="row-vetting human">✓ Vetted</span>}</span><span className="scholarship-row-provider">{record.provider}</span><span className="scholarship-row-description">{record.description}</span></span>
    <span className="scholarship-row-deadline" role="cell"><strong>{formatDate(record.deadline)}</strong><small>{closed ? "Past deadline" : "Active"}</small></span>
    <span className="scholarship-row-eligibility" role="cell">{record.eligibility.minimumGpa !== null && <span>GPA {record.eligibility.minimumGpa}+</span>}{record.requirements.essay === true && <span>Essay required</span>}{record.requirements.essay === false && <span>No essay</span>}{record.eligibility.tags.map((value) => <span key={value}>{value.replaceAll("-", " ")}</span>)}{record.institutionSpecific && <span title={`College-specific${record.institutionName ? `: ${record.institutionName}` : ""}`}>Institution</span>}</span>
    <strong className="scholarship-row-award" role="cell">{formatMoney(record.award.maximum, record.award.varies)}</strong>
  </Link>;
}
