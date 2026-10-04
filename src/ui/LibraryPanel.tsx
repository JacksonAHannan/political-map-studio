import { useCallback, useEffect, useMemo, useState } from "react";
import type { Project } from "../model/types";
import { errorMessage } from "./DesignPanel";

// The catalog is fetched by App and shared with the design panel, so both screens agree on it.

export type LibraryEntry = {
  id: string; state: string; stateCode: string; year: number; election: string; race: string; office: string;
  date: string; geographyLevel: string; geometryVintage: string; source: string; matchStatus: string;
  candidateCount: number; available: boolean; previewUrl?: string; previewLabel?: string; sourcePath?: string; matchAudit?: string;
  previewThumbnailUrl?: string; matchMethod?: string; resultsPath?: string; crosswalkPath?: string;
};

export type LibraryState = { status: "loading" | "ready" | "error"; entries: LibraryEntry[]; message?: string };

export const matchTone = (status: string): "ok" | "review" | "warn" =>
  /source-integrated|crosswalked|verified|reviewed/i.test(status) ? "ok" : /review|approximat|partial/i.test(status) ? "review" : "warn";

export function useLibrary(): LibraryState & { reload: () => void } {
  const [state, setState] = useState<LibraryState>({ status: "loading", entries: [] });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setState(current => ({ ...current, status: "loading", message: undefined }));
    fetch("/api/library")
      .then(async response => { if (!response.ok) throw new Error(await response.text()); return response.json() })
      .then(data => { if (!cancelled) setState({ status: "ready", entries: Array.isArray(data.entries) ? data.entries : [] }) })
      .catch(error => { if (!cancelled) setState({ status: "error", entries: [], message: errorMessage(error) }) });
    return () => { cancelled = true };
  }, [attempt]);
  const reload = useCallback(() => setAttempt(value => value + 1), []);
  return { ...state, reload };
}

export function searchEntries(entries: LibraryEntry[], query: string): LibraryEntry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return entries;
  return entries.filter(entry => {
    const text = [entry.state, entry.stateCode, String(entry.year), entry.race, entry.office, entry.election, entry.date, entry.geographyLevel, entry.geometryVintage, entry.source, entry.matchStatus, entry.matchMethod].join(" ").toLowerCase();
    return terms.every(term => text.includes(term));
  });
}

/** Thumbnail with its own failure state so a missing published preview never blocks the card. */
function Preview({ entry }: { entry: LibraryEntry }) {
  const [failed, setFailed] = useState(false);
  const showImage = !!entry.previewUrl && !failed;
  return <div className="preview">
    {showImage
      ? <img src={entry.previewThumbnailUrl ?? entry.previewUrl} alt={`Published preview of ${entry.state} ${entry.race}`} loading="lazy" decoding="async" onError={() => setFailed(true)} />
      : <div className="preview-empty"><span>{entry.stateCode || "—"}</span><em>{entry.available ? "No published preview" : "Source unavailable"}</em></div>}
    {showImage && <span className="preview-label">{entry.previewLabel ?? "Published map"}</span>}
  </div>;
}

export type LibraryPanelProps = {
  current?: Project;
  library: LibraryState;
  onReload: () => void;
  purpose: "primary" | "comparison";
  preserveDesign: boolean;
  onPreserveDesign: (value: boolean) => void;
  onOpen: (entry: LibraryEntry) => Promise<void> | void;
  onNotice: (message: string, kind?: "info" | "error" | "success") => void;
  banner?: React.ReactNode;
  notice?: string;
};

export function LibraryPanel({ current, library, onReload, purpose, preserveDesign, onPreserveDesign, onOpen, onNotice, banner, notice }: LibraryPanelProps) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState("");
  const [year, setYear] = useState("");
  const [selected, setSelected] = useState<string>();
  const [loadingId, setLoadingId] = useState<string>();

  const states = useMemo(() => [...new Set(library.entries.map(entry => entry.state))].sort(), [library.entries]);
  const years = useMemo(() => [...new Set(library.entries.filter(entry => !state || entry.state === state).map(entry => entry.year))].sort((a, b) => b - a), [library.entries, state]);
  const filtered = useMemo(() => {
    const base = library.entries.filter(entry => (!state || entry.state === state) && (!year || entry.year === Number(year)));
    return searchEntries(base, query).sort((a, b) => a.state.localeCompare(b.state) || b.year - a.year || a.race.localeCompare(b.race));
  }, [library.entries, state, year, query]);
  const active = library.entries.find(entry => entry.id === selected);
  const resultsLabel = `${filtered.length} of ${library.entries.length} elections`;
  const comparisonBlocked = purpose === "comparison" && active?.id === (current?.dataset?.id ?? current?.id);

  async function open(entry?: LibraryEntry) {
    const target = entry ?? active;
    if (!target || !target.available) return;
    setLoadingId(target.id);
    onNotice(`Loading ${target.state} ${target.year} ${target.race} from the matched library…`);
    try {
      await onOpen(target);
    } catch (error) {
      onNotice(`Library load failed: ${errorMessage(error)}`, "error");
    } finally {
      setLoadingId(undefined);
    }
  }

  return <div className="library-screen">
    <header className="library-head">
      <div className="library-intro">
        <span>{purpose === "comparison" ? "STEP 2 · COMPARISON ELECTION" : "STEP 1 · ELECTION"}</span>
        <h1>{purpose === "comparison" ? "Choose the second election" : "Choose a matched election"}</h1>
        <p>{purpose === "comparison"
          ? "Compare two real elections side by side. Both datasets keep their own geometry and provenance."
          : "Every race below already has precinct returns matched to geography. Pick one race and one design; no importing or crosswalking required."}</p>
      </div>
      <div className="library-count">
        <div><span>Matched races</span><strong>{library.status === "ready" ? library.entries.length : "—"}</strong></div>
        <div><span>Sources present</span><strong>{library.status === "ready" ? `${library.entries.filter(entry => entry.available).length}/${library.entries.length}` : "—"}</strong></div>
      </div>
    </header>

    {banner}

    <div className="library-controls">
      <label className="library-search"><span>Search</span>
        <input value={query} placeholder="Race, office, year, state, matching status…" onChange={event => setQuery(event.target.value)} />
      </label>
      <label><span>State</span>
        <select value={state} onChange={event => { setState(event.target.value); setYear(""); setSelected(undefined) }}>
          <option value="">All states</option>
          {states.map(value => <option key={value}>{value}</option>)}
        </select>
      </label>
      <label><span>Year</span>
        <select value={year} onChange={event => { setYear(event.target.value); setSelected(undefined) }}>
          <option value="">All years</option>
          {years.map(value => <option key={value}>{value}</option>)}
        </select>
      </label>
      <div className="library-controls-meta">
        <span>{library.status === "ready" ? resultsLabel : "Loading catalog…"}</span>
        {library.status === "ready" && query.length > 0 && <button onClick={() => setQuery("")}>Clear search</button>}
      </div>
    </div>

    {notice && <p className="library-notice">{notice}</p>}

    <div className="library-body">
      <div className="library-grid">
        {library.status === "loading" && Array.from({ length: 6 }, (_, index) => <div className="library-card skeleton" key={index}><div className="preview" /><span className="skeleton-line" /><span className="skeleton-line short" /></div>)}

        {library.status === "error" && <div className="library-message error">
          <span>!</span>
          <strong>The election catalog could not be read</strong>
          <p>The studio serves the library from its local backend. Start it, then retry. No demo data is substituted.</p>
          <code>{library.message}</code>
          <button onClick={onReload}>Retry</button>
        </div>}

        {library.status === "ready" && filtered.length === 0 && <div className="library-message">
          <span>?</span>
          <strong>No election matches these filters</strong>
          <p>Try a different state or year, or clear the search. The catalog holds {library.entries.length} matched races.</p>
          <button onClick={() => { setQuery(""); setState(""); setYear("") }}>Reset filters</button>
        </div>}

        {library.status === "ready" && filtered.map(entry => <button
          key={entry.id}
          className={`library-card ${selected === entry.id ? "selected" : ""} ${entry.available ? "" : "unavailable"}`}
          disabled={!entry.available}
          onClick={() => setSelected(entry.id)}
          onDoubleClick={() => void open(entry)}>
          <Preview entry={entry} />
          <div className="card-head">
            <span className="card-year">{entry.year}</span>
            <span className={`card-match ${matchTone(entry.matchStatus)}`}>{entry.matchStatus}</span>
          </div>
          <strong className="card-race">{entry.race}</strong>
          <span className="card-where">{entry.state} · {entry.election} · {entry.geographyLevel}</span>
          <dl className="card-meta">
            <div><dt>Geometry</dt><dd title={entry.geometryVintage}>{entry.geometryVintage}</dd></div>
            <div><dt>Candidates</dt><dd>{entry.candidateCount}</dd></div>
          </dl>
          <div className="card-foot">
            <span className={`source-flag ${entry.available ? "ok" : "bad"}`}>{entry.available ? "Source file present" : "Source file missing"}</span>
            {loadingId === entry.id && <span className="card-loading">Loading…</span>}
          </div>
        </button>)}
      </div>

      <aside className="library-detail">
        {active
          ? <>
            <div className="detail-title"><span>{active.stateCode} · {active.date}</span><h2>{active.race}</h2><p>{active.state} · {active.election}</p></div>
            <dl className="provenance">
              <div><dt>Office</dt><dd>{active.office}</dd></div>
              <div><dt>Level</dt><dd>{active.geographyLevel}</dd></div>
              <div><dt>Geometry vintage</dt><dd>{active.geometryVintage}</dd></div>
              <div><dt>Matching</dt><dd>{active.matchStatus}</dd></div>
              {active.matchMethod && <div><dt>Matching method</dt><dd>{active.matchMethod}</dd></div>}
              <div><dt>Source</dt><dd>{active.source}</dd></div>
              {active.sourcePath && <div><dt>Source file</dt><dd title={active.sourcePath}>{active.sourcePath}</dd></div>}
              {active.resultsPath && <div><dt>Matched returns</dt><dd>{active.resultsPath}</dd></div>}
              {active.crosswalkPath && <div><dt>Crosswalk</dt><dd>{active.crosswalkPath}</dd></div>}
              <div><dt>Match audit</dt><dd title={active.matchAudit}>{active.matchAudit ?? "not provided"}</dd></div>
              <div><dt>Preview</dt><dd>{active.previewLabel ?? "Published map"}</dd></div>
            </dl>
            {active.id === current?.id && <p className="hint">{purpose === "comparison" ? "This is the election already on the page. Choose a different race to compare against." : "This election is already open in the editor."}</p>}
            <button className="primary" disabled={!active.available || comparisonBlocked || loadingId === active.id} onClick={() => void open()}>
              {loadingId === active.id ? "Loading matched precincts…" : purpose === "comparison" ? "Use as comparison" : "Use this election"}
            </button>
          </>
          : <div className="library-message">
            <span>◎</span>
            <strong>Select an election</strong>
            <p>Pick a card to inspect its matched geography, source, and audit trail before opening it.</p>
          </div>}
      </aside>
    </div>

    <footer className="library-foot">
      <label className={`preserve-design ${current && purpose === "primary" ? "" : "muted"}`}>
        <input type="checkbox" disabled={!current || purpose === "comparison"} checked={!!current && purpose === "primary" && preserveDesign} onChange={event => onPreserveDesign(event.target.checked)} />
        <span>Keep the current page design — replace only the election, results, and metadata</span>
      </label>
      <div className="library-foot-actions">
        {current && purpose === "primary" && <span className="hint">Open: {current.metadata.title}</span>}
        <button className="primary" disabled={!active?.available || comparisonBlocked || !!loadingId} onClick={() => void open()}>
          {purpose === "comparison" ? "Load comparison election" : "Open election"} →
        </button>
      </div>
    </footer>
  </div>;
}
