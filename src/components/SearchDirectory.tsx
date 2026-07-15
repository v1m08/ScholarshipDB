"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  formatDate,
  formatMoney,
  effectiveVetting,
  isClosed,
  localDateString,
  sourceMissingFields,
  type CatalogMetadata,
  type SearchResponse,
  type Scholarship,
  yesNoUnknown,
} from "@/lib/scholarship";
import { US_STATE_NAMES } from "@/lib/facets";

interface SearchDirectoryProps {
  initial: SearchResponse;
  facets: CatalogMetadata["facets"];
  asOfDate: string;
}

const PAGE_SIZE = 100;
type ExportFormat = "xlsx" | "sheets" | "pdf" | "csv";

function truncateDescription(value: string, maximum = 200): string {
  const description = value.trim();
  if (description.length <= maximum) return description;
  const shortened = description.slice(0, maximum + 1);
  const breakAt = shortened.lastIndexOf(" ");
  return `${shortened.slice(0, breakAt > maximum * 0.7 ? breakAt : maximum).trim()}...`;
}

function listOrUnknown(values: string[]): string {
  return values.length ? values.join(", ") : "Not published";
}

function deduplicateScholarships(records: Scholarship[]): Scholarship[] {
  return [...new Map(records.map((record) => [record.id, record])).values()];
}

function exportRows(records: Scholarship[]) {
  return records.map((record) => ({
    title: record.title,
    provider: record.provider,
    deadline: formatDate(record.deadline),
    award: formatMoney(record.award.maximum, record.award.varies),
    tags: record.eligibility.tags.join(", "),
    eligibility: record.eligibility.other.join("; "),
    description: record.description,
    applicationUrl: record.applicationUrl,
    sourceUrl: record.sourceUrl,
  }));
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function rowsToCsv(records: Scholarship[]): string {
  const headers = ["Scholarship", "Provider", "Deadline", "Award", "Tags", "Eligibility", "Description", "Application URL", "Source URL"];
  const rows = exportRows(records).map((row) => Object.values(row).map(csvCell).join(","));
  return `\uFEFF${headers.map(csvCell).join(",")}\r\n${rows.join("\r\n")}`;
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function rowsToExcel(records: Scholarship[]): string {
  const headers = ["Scholarship", "Provider", "Deadline", "Award", "Tags", "Eligibility", "Description", "Application URL", "Source URL"];
  const rows = [headers, ...exportRows(records).map((row) => Object.values(row))];
  const xmlRows = rows.map((row, index) => `<Row>${row.map((value) => `<Cell${index === 0 ? ' ss:StyleID="Header"' : ""}><Data ss:Type="String">${xmlEscape(value)}</Data></Cell>`).join("")}</Row>`).join("");
  return `<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Styles><Style ss:ID="Header"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#12633F" ss:Pattern="Solid"/></Style></Styles><Worksheet ss:Name="Shortlist"><Table>${xmlRows}</Table></Worksheet></Workbook>`;
}

function pdfEscape(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, " ").replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function wrapPdfText(value: string, width = 88): string[] {
  const words = value.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (`${line} ${word}`.trim().length > width) {
      if (line) lines.push(line);
      line = word;
    } else line = `${line} ${word}`.trim();
  }
  if (line) lines.push(line);
  return lines;
}

function rowsToPdf(records: Scholarship[]): ArrayBuffer {
  const lines = ["OpenScholar Index - Shortlisted Scholarships", `Exported ${new Date().toLocaleDateString("en-US")}`, ""];
  for (const row of exportRows(records)) {
    lines.push(row.title, `${row.provider} | ${row.award} | ${row.deadline}`);
    lines.push(...wrapPdfText(row.description, 92), `Apply: ${row.applicationUrl}`, "");
  }
  const pages: string[][] = [];
  for (let index = 0; index < lines.length; index += 44) pages.push(lines.slice(index, index + 44));
  const objects: string[] = [];
  const add = (value: string) => { objects.push(value); return objects.length; };
  const catalogId = add("");
  const pagesId = add("");
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageIds: number[] = [];
  for (const pageLines of pages) {
    const content = `BT /F1 10 Tf 45 752 Td 14 TL ${pageLines.map((line) => `(${pdfEscape(line)}) Tj T*`).join(" ")} ET`;
    const contentId = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`));
  }
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf).buffer as ArrayBuffer;
}

function downloadFile(contents: BlobPart, type: string, filename: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function SearchDirectory({ initial, facets, asOfDate }: SearchDirectoryProps) {
  const [query, setQuery] = useState("");
  const [grade, setGrade] = useState("");
  const [tag, setTag] = useState("");
  const [state, setState] = useState("");
  const [minimumAward, setMinimumAward] = useState("");
  const [institutionScope, setInstitutionScope] = useState("all");
  const [includeClosed, setIncludeClosed] = useState(false);
  const [vettedOnly, setVettedOnly] = useState(false);
  const [results, setResults] = useState(initial);
  const [effectiveAsOfDate, setEffectiveAsOfDate] = useState(asOfDate);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [selectedScholarship, setSelectedScholarship] = useState<Scholarship | null>(null);
  const [shortlisted, setShortlisted] = useState<Map<string, Scholarship>>(() => new Map());
  const [deferredUnpins, setDeferredUnpins] = useState<Map<string, Scholarship>>(() => new Map());
  const [exportFormat, setExportFormat] = useState<ExportFormat>("xlsx");
  const initialSearch = useRef(true);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const modalTitleId = useId();

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
    parameters.set("asOfDate", effectiveAsOfDate);
    if (cursor) parameters.set("cursor", cursor);
    return parameters;
  }, [effectiveAsOfDate, grade, includeClosed, institutionScope, minimumAward, query, state, tag, vettedOnly]);

  useEffect(() => {
    setEffectiveAsOfDate(localDateString());
  }, []);

  useEffect(() => {
    if (initialSearch.current) {
      initialSearch.current = false;
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setSearchError("");
    const timeout = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/search?${parametersForSearch()}`, { signal: controller.signal });
        if (!response.ok) throw new Error("Search request failed");
        setResults((await response.json()) as SearchResponse);
      } catch (error) {
        if (!controller.signal.aborted) {
          console.error(error);
          setSearchError("Search is temporarily unavailable. Please try again.");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 120);
    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [parametersForSearch]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || results.hasMore === false || results.records.length >= results.total) return;
    const observer = new IntersectionObserver(async (entries) => {
      if (!entries.some((entry) => entry.isIntersecting) || loading || loadingMore) return;
      setLoadingMore(true);
      try {
        const response = await fetch(`/api/search?${parametersForSearch(results.page + 1, results.nextCursor)}`);
        if (!response.ok) throw new Error("Search continuation failed");
        const next = (await response.json()) as SearchResponse;
        setResults((current) => ({
          ...next,
          total: current.total,
          rawTotal: current.rawTotal,
          records: deduplicateScholarships([...current.records, ...next.records]),
        }));
      } finally {
        setLoadingMore(false);
      }
    }, { rootMargin: "1800px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [loading, loadingMore, parametersForSearch, results]);

  useEffect(() => {
    if (!selectedScholarship) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSelectedScholarship(null);
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = document.querySelector<HTMLElement>(".scholarship-modal");
      const focusable = dialog?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [selectedScholarship]);

  function toggleShortlist(record: Scholarship) {
    setShortlisted((current) => {
      const next = new Map(current);
      if (next.has(record.id)) {
        next.delete(record.id);
        setDeferredUnpins((pending) => new Map(pending).set(record.id, record));
      } else {
        next.set(record.id, record);
        setDeferredUnpins((pending) => {
          if (!pending.has(record.id)) return pending;
          const updated = new Map(pending);
          updated.delete(record.id);
          return updated;
        });
      }
      return next;
    });
  }

  function finishDeferredUnpin(id: string) {
    setDeferredUnpins((current) => {
      if (!current.has(id)) return current;
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  }

  function exportShortlist() {
    const records = [...shortlisted.values()];
    if (!records.length) return;
    if (exportFormat === "xlsx") {
      downloadFile(rowsToExcel(records), "application/vnd.ms-excel", "openscholar-shortlist.xls");
    } else if (exportFormat === "pdf") {
      downloadFile(rowsToPdf(records), "application/pdf", "openscholar-shortlist.pdf");
    } else {
      const filename = exportFormat === "sheets" ? "openscholar-shortlist-for-sheets.csv" : "openscholar-shortlist.csv";
      downloadFile(rowsToCsv(records), "text/csv;charset=utf-8", filename);
    }
  }

  const hasActiveSearch = Boolean(
    query.trim() ||
    grade ||
    tag ||
    state ||
    minimumAward ||
    institutionScope !== "all" ||
    vettedOnly,
  );
  const displayedRecords = hasActiveSearch
    ? results.records
    : deduplicateScholarships([
        ...shortlisted.values(),
        ...deferredUnpins.values(),
        ...results.records,
      ]);
  const orderedRecords = displayedRecords
    .map((record, originalIndex) => ({
      originalIndex,
      pinned: shortlisted.has(record.id) || deferredUnpins.has(record.id),
      record,
    }))
    .sort((left, right) => Number(right.pinned) - Number(left.pinned) || left.originalIndex - right.originalIndex)
    .map(({ record }) => record);

  return (
    <section className="directory" aria-label="Scholarship directory">
      <div className="filters">
        <label className="query">
          <span>Search scholarships</span>
          <input
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="engineering, Maryland, first generation..."
            type="search"
            value={query}
          />
        </label>
        <label>
          <span>Grade</span>
          <select onChange={(event) => setGrade(event.target.value)} value={grade}>
            <option value="">Any grade</option>
            {facets.grades.map((value) => <option key={value}>{value}</option>)}
          </select>
        </label>
        <label>
          <span>Student tag</span>
          <select onChange={(event) => setTag(event.target.value)} value={tag}>
            <option value="">Any tag</option>
            {facets.tags.map((value) => <option key={value} value={value}>{value.replaceAll("-", " ")}</option>)}
          </select>
        </label>
        <label>
          <span>State-specific</span>
          <select onChange={(event) => setState(event.target.value)} value={state}>
            <option value="">Any location</option>
            {facets.states.map((value) => (
              <option key={value} value={value}>{US_STATE_NAMES[value] || value}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Minimum award</span>
          <select onChange={(event) => setMinimumAward(event.target.value)} value={minimumAward}>
            <option value="">Any amount</option>
            <option value="1000">$1,000+</option>
            <option value="5000">$5,000+</option>
            <option value="10000">$10,000+</option>
          </select>
        </label>
        <label>
          <span>Institution scope</span>
          <select onChange={(event) => setInstitutionScope(event.target.value)} value={institutionScope}>
            <option value="all">All opportunities</option>
            <option value="general">General only</option>
            <option value="institution">College-specific only</option>
          </select>
        </label>
        <div className="filter-actions">
          <label className="toggle-bar">
            <input checked={includeClosed} onChange={(event) => setIncludeClosed(event.target.checked)} type="checkbox" />
            <span>
              <strong>{includeClosed ? "Past deadlines included" : "Showing active deadlines only"}</strong>
              <small>Toggle for showing differing deadlines</small>
            </span>
          </label>
          <label className="toggle-bar">
            <input checked={vettedOnly} onChange={(event) => setVettedOnly(event.target.checked)} type="checkbox" />
            <span>
              <strong>Vetted scholarships only</strong>
              <small>Show records with a Vetted check</small>
            </span>
          </label>
          <div className="export-controls">
            <label>
              <span>Export {shortlisted.size ? `${shortlisted.size} shortlisted` : "shortlist"}</span>
              <select onChange={(event) => setExportFormat(event.target.value as ExportFormat)} value={exportFormat}>
                <option value="xlsx">Excel (.xls)</option>
                <option value="sheets">Google Sheets (.csv)</option>
                <option value="pdf">PDF</option>
                <option value="csv">CSV</option>
              </select>
            </label>
            <span
              aria-label={!shortlisted.size ? "Export unavailable: save at least one scholarship to your shortlist first." : undefined}
              className="export-button-wrap"
              data-tooltip={!shortlisted.size ? "Save at least one scholarship to your shortlist before exporting." : "Exports your saved scholarships. If no file appears, allow downloads for this site in your browser."}
              tabIndex={!shortlisted.size ? 0 : undefined}
            >
              <button
                className="export-button"
                disabled={!shortlisted.size}
                onClick={exportShortlist}
                title={!shortlisted.size ? "Save at least one scholarship to your shortlist before exporting." : "Export saved scholarships. Your browser may ask you to allow downloads."}
                type="button"
              >
                Export
              </button>
            </span>
          </div>
        </div>
      </div>

      <div className="result-header" aria-live="polite">
        <strong>{results.total}</strong> listing{results.total === 1 ? "" : "s"} found
        <span>
          {loading
            ? "Searching..."
            : results.rawTotal && results.rawTotal !== results.total
              ? `Grouped from ${results.rawTotal.toLocaleString("en-US")} scholarship records.`
              : "Indexed search, no account needed."}
        </span>
      </div>
      {searchError ? <p className="search-error" role="alert">{searchError}</p> : null}

      <div className="results directory-table" role="table" aria-label="Scholarship listings">
        <div className="directory-table-head" role="row">
          <span role="columnheader">Scholarship</span>
          <span role="columnheader">Deadline</span>
          <span role="columnheader">Eligibility</span>
          <span role="columnheader">Award</span>
        </div>
        {orderedRecords.map((record: Scholarship) => {
          const closed = isClosed(record, effectiveAsOfDate);
          const vetting = effectiveVetting(record);
          return (
          <div
            aria-label={`View details for ${record.title}`}
            className={closed ? "scholarship-row closed-card" : "scholarship-row open-card"}
            key={record.id}
            onClick={() => setSelectedScholarship(record)}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setSelectedScholarship(record);
              }
            }}
            onMouseLeave={() => finishDeferredUnpin(record.id)}
            role="row"
            tabIndex={0}
          >
            <span className={shortlisted.has(record.id) ? "shortlist-rail selected" : "shortlist-rail"} role="cell">
              <button
                aria-pressed={shortlisted.has(record.id)}
                aria-label={shortlisted.has(record.id) ? "Remove scholarship from export shortlist" : "Add scholarship to export shortlist"}
                className="shortlist-rail-button"
                onClick={(event) => {
                  event.stopPropagation();
                  toggleShortlist(record);
                }}
                type="button"
              />
              <span className="shortlist-tooltip" role="tooltip">
                {shortlisted.has(record.id)
                  ? "Selected for export. Click to remove it."
                  : "Click this bar to add the scholarship to your export shortlist."}
              </span>
            </span>
            <span className="scholarship-row-main" role="cell">
              <span className="scholarship-row-heading">
                <strong className="scholarship-row-title">{record.title}</strong>
                {vetting.status !== "unvetted" && (
                  <span className="row-vetting human" title={`Vetted${vetting.vettedAt ? ` on ${formatDate(vetting.vettedAt)}` : ""}`}>
                    ✓ Vetted
                  </span>
                )}
              </span>
              <span className="scholarship-row-provider">{record.provider}</span>
              <span className="scholarship-row-description">{truncateDescription(record.description)}</span>
            </span>
            <span className="scholarship-row-deadline" role="cell">
              <strong>{formatDate(record.deadline)}</strong>
              <small>{closed ? "Past deadline" : "Active"}</small>
            </span>
            <span className="scholarship-row-eligibility" role="cell">
              {record.eligibility.minimumGpa !== null && <span>GPA {record.eligibility.minimumGpa}+</span>}
              {record.requirements.essay === true && <span>Essay required</span>}
              {record.requirements.essay === false && <span>No essay</span>}
              {record.eligibility.tags.slice(0, 2).map((value) => (
                <span key={value}>{value.replaceAll("-", " ")}</span>
              ))}
              {record.institutionSpecific && (
                <span title={`College-specific${record.institutionName ? `: ${record.institutionName}` : ""}`}>Institution</span>
              )}
            </span>
            <strong className="scholarship-row-award" role="cell">
              {formatMoney(record.award.maximum, record.award.varies)}
            </strong>
          </div>
        );
        })}
        {!results.records.length && (
          <div className="empty">
            No listings match those filters. Show past deadlines or broaden one filter.
          </div>
        )}
      </div>
      {results.hasMore !== false && results.records.length < results.total && (
        <div className="load-sentinel" ref={sentinel} aria-live="polite">
          {loadingMore ? "Loading more scholarships..." : "More scholarships load as you scroll."}
        </div>
      )}

      {selectedScholarship && (
        <ScholarshipModal
          asOfDate={effectiveAsOfDate}
          closeButton={closeButton}
          onClose={() => setSelectedScholarship(null)}
          scholarship={selectedScholarship}
          titleId={modalTitleId}
        />
      )}
    </section>
  );
}

interface ScholarshipModalProps {
  asOfDate: string;
  closeButton: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  scholarship: Scholarship;
  titleId: string;
}

function ScholarshipModal({ asOfDate, closeButton, onClose, scholarship, titleId }: ScholarshipModalProps) {
  const closed = isClosed(scholarship, asOfDate);
  const vetting = effectiveVetting(scholarship);
  const missingFields = sourceMissingFields(scholarship);

  return (
    <div className="scholarship-modal-backdrop" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <article
        aria-labelledby={titleId}
        aria-modal="true"
        className={closed ? "scholarship-modal closed-card" : "scholarship-modal open-card"}
        role="dialog"
      >
        <div className="scholarship-modal-actions">
          <button aria-label="Close scholarship details" className="modal-close" onClick={onClose} ref={closeButton} type="button">
            <span aria-hidden="true">&times;</span>
          </button>
        </div>
        <div className="detail-head">
          <div className="badge-row">
            <p className={closed ? "status closed" : "status open"}>{closed ? "Past deadline" : "Active deadline"}</p>
            {vetting.status !== "unvetted" && <span className="vetting-ribbon human-vetted">✓ Vetted</span>}
            {scholarship.institutionSpecific && <span className="institution-badge">Institution</span>}
          </div>
          <h1 id={titleId}>{scholarship.title}</h1>
          <p className="provider">{scholarship.provider}</p>
          <div className="detail-featured">
            <strong>{formatMoney(scholarship.award.maximum, scholarship.award.varies)}</strong>
            <span>Deadline: {formatDate(scholarship.deadline)}</span>
          </div>
          <p>{scholarship.description}</p>
          <a className="button" href={scholarship.applicationUrl} rel="noreferrer" target="_blank">View original listing</a>
        </div>

        <section>
          <h2>Eligibility</h2>
          <dl className="detail-grid">
            <div><dt>Location</dt><dd>{listOrUnknown(scholarship.eligibility.states.length ? scholarship.eligibility.states : scholarship.eligibility.countries)}</dd></div>
            <div><dt>Grade</dt><dd>{listOrUnknown(scholarship.eligibility.grades)}</dd></div>
            <div><dt>Degree</dt><dd>{listOrUnknown(scholarship.eligibility.degreeLevels)}</dd></div>
            <div><dt>Fields</dt><dd>{listOrUnknown(scholarship.eligibility.fields)}</dd></div>
            <div><dt>Minimum GPA</dt><dd>{scholarship.eligibility.minimumGpa ?? "Not published"}</dd></div>
            <div><dt>Minimum age</dt><dd>{scholarship.eligibility.minimumAge ?? "Not published"}</dd></div>
            <div><dt>Citizenship</dt><dd>{listOrUnknown(scholarship.eligibility.citizenship)}</dd></div>
          </dl>
          {!!scholarship.eligibility.other.length && (
            <ul className="requirements-list">
              {scholarship.eligibility.other.map((value) => <li key={value}>{value}</li>)}
            </ul>
          )}
        </section>

        <section>
          <h2>Application facts</h2>
          <dl className="detail-grid compact">
            <div><dt>Essay required</dt><dd>{yesNoUnknown(scholarship.requirements.essay)}</dd></div>
            <div><dt>Need-based</dt><dd>{yesNoUnknown(scholarship.requirements.needBased)}</dd></div>
            <div><dt>Merit-based</dt><dd>{yesNoUnknown(scholarship.requirements.meritBased)}</dd></div>
            <div><dt>Application fee</dt><dd>{yesNoUnknown(scholarship.requirements.fee)}</dd></div>
          </dl>
          <p className="unknown-note">“Not published” means the field was not visible in the indexed public source.</p>
        </section>

        <section className="provenance">
          <h2>Source</h2>
          <p>
            Original source: <a href={scholarship.sourceUrl} rel="noreferrer" target="_blank">{scholarship.sourceName}</a>.
            {" "}Last checked {formatDate(scholarship.sourceCheckedAt)}. Confirm current rules before applying.
          </p>
          {vetting.status !== "unvetted" && (
            <p>
              Vetted
              {vetting.vettedAt ? ` on ${formatDate(vetting.vettedAt)}` : ""}.
            </p>
          )}
          <p>Fields not fully fetched: {missingFields.length ? missingFields.join(", ") : "none currently flagged"}.</p>
        </section>
      </article>
    </div>
  );
}
