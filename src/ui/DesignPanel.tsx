import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MapRenderer } from "../render/MapRenderer";
import { visualDiagnostics } from "../model/diagnostics";
import { BINDING_TOKENS, LAYOUTS, applyDesign, createDesign, datasetSummary } from "../model/design";
import type { Design, LayoutId, Project, StudioElement } from "../model/types";
import type { LibraryState } from "./LibraryPanel";
import { DiagnosticsPanel } from "./DiagnosticsPanel";

/* ------------------------------------------------------------------ *
 * Shared helpers (imported by App and LibraryPanel)                    *
 * ------------------------------------------------------------------ */

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "map";
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadJson(value: unknown, name: string): void {
  downloadBlob(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }), name);
}

/** Give markup exported to a standalone file explicit page dimensions, since the live canvas is CSS-sized. */
export function standaloneSvg(markup: string, page: { width: number; height: number }): string {
  const end = markup.indexOf(">");
  if (end < 0) return markup;
  return `${markup.slice(0, end).replace(/\swidth="[^"]*"/, "").replace(/\sheight="[^"]*"/, "")} width="${page.width}" height="${page.height}"${markup.slice(end)}`;
}

/* ------------------------------------------------------------------ *
 * Local reusable designs (browser storage)                             *
 * ------------------------------------------------------------------ */

const DESIGN_STORE = "pmap.designs";

const isDesign = (value: unknown): value is Design => {
  const candidate = value as Design | undefined;
  return !!candidate && typeof candidate === "object" && candidate.kind === "design" && Array.isArray(candidate.elements);
};

export function readSavedDesigns(): Design[] {
  try {
    const raw = localStorage.getItem(DESIGN_STORE);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isDesign) : [];
  } catch {
    return [];
  }
}

/** Throws when the browser refuses the write (quota or private mode) so callers can report it. */
export function writeSavedDesigns(designs: Design[]): void {
  localStorage.setItem(DESIGN_STORE, JSON.stringify(designs));
}

/* ------------------------------------------------------------------ *
 * Layout sketches                                                      *
 * ------------------------------------------------------------------ */

const SKETCHES: Record<LayoutId, Array<[number, number, number, number]>> = {
  statewide: [[8, 62, 118, 94], [140, 62, 70, 56], [140, 126, 70, 30], [8, 8, 202, 44]],
  results: [[8, 62, 96, 94], [116, 62, 94, 94], [8, 8, 202, 44]],
  insets: [[8, 62, 202, 72], [8, 144, 46, 36], [62, 144, 46, 36], [116, 144, 46, 36], [170, 144, 40, 36]],
  comparison: [[8, 62, 96, 90], [116, 62, 94, 90], [8, 8, 202, 44], [8, 160, 96, 24], [116, 160, 94, 24]],
  detail: [[8, 62, 118, 94], [136, 62, 74, 94], [8, 8, 202, 44]],
};

function LayoutSketch({ id }: { id: LayoutId }) {
  return <svg className="layout-sketch" viewBox="0 0 218 194" aria-hidden="true">
    <rect x="0" y="0" width="218" height="194" fill="#0d1518" stroke="#33454d" />
    {SKETCHES[id].map(([x, y, width, height], index) =>
      <rect key={index} x={x} y={y} width={width} height={height} fill={index === 0 ? "#1d3b33" : "#1c272d"} stroke="#3f5862" />)}
  </svg>;
}

/** Layout names by id, used wherever the applied layout is summarised. */
const LAYOUT_LABELS: Record<string, string> = Object.fromEntries(LAYOUTS.map(layout => [layout.id, layout.name]));

/* ------------------------------------------------------------------ *
 * Metadata bindings                                                    *
 * ------------------------------------------------------------------ */

/** Labels for the tokens the design model rebinds whenever a design is applied to an election. */
const BINDING_LABELS: Record<typeof BINDING_TOKENS[number], string> = {
  "{{metadata.title}}": "Election title",
  "{{metadata.subtitle}}": "Election subtitle",
  "{{metadata.office}}": "Office / race",
  "{{metadata.source}}": "Source",
  "{{metadata.jurisdiction}}": "Jurisdiction",
  "{{metadata.electionType}}": "Election type",
  "{{metadata.electionDate}}": "Election date",
  "{{metadata.notes}}": "Provenance notes",
  "{{year}}": "Year",
  "{{dataset.label}}": "Dataset label",
  "{{dataset.jurisdiction}}": "Dataset jurisdiction",
};
const BINDING_OPTIONS = BINDING_TOKENS.map(value => ({ value, label: BINDING_LABELS[value] }));

/* ------------------------------------------------------------------ *
 * Small shared fields                                                  *
 * ------------------------------------------------------------------ */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="property-section"><h3>{title}</h3>{children}</section>;
}
function TextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="field"><span>{label}</span><input value={value} onChange={event => onChange(event.target.value)} /></label>;
}
function NumberField({ label, value, onChange, step = 1 }: { label: string; value: number; onChange: (value: number) => void; step?: number }) {
  return <label className="field number"><span>{label}</span><input type="number" value={Number.isFinite(value) ? value : 0} step={step} onChange={event => onChange(Number(event.target.value))} /></label>;
}
function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="field color"><span>{label}</span><span className="color-control"><input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#000000"} onChange={event => onChange(event.target.value)} /><input value={value} onChange={event => onChange(event.target.value)} /></span></label>;
}
function SelectField({ label, value, options, onChange }: { label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void }) {
  return <label className="field"><span>{label}</span><select value={value} onChange={event => onChange(event.target.value)}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
}
/** Shows a token when the field holds one in full, and "Literal text" otherwise. */
function BindingSelect({ label, value, onChange }: { label: string; value: string; onChange: (token: string) => void }) {
  const token = BINDING_TOKENS.some(candidate => candidate === value) ? value : "";
  const options = [{ value: "", label: "Literal text" }, ...BINDING_OPTIONS];
  return <SelectField label={label} value={token} options={options} onChange={next => { if (next) onChange(next) }} />;
}

/* ------------------------------------------------------------------ *
 * Saved designs                                                        *
 * ------------------------------------------------------------------ */

type SavedDesignsProps = {
  project: Project;
  designs: Design[];
  activeDesignId?: string;
  onApplyDesign: (design: Design) => void;
  onDeleteDesign: (id: string) => void;
  onExportDesign: (design: Design) => void;
  onSaveDesign: (name: string) => void;
};

function SavedDesigns({ project, designs, activeDesignId, onApplyDesign, onDeleteDesign, onExportDesign, onSaveDesign }: SavedDesignsProps) {
  const [name, setName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<string>();
  const save = () => { onSaveDesign(name); setName(""); };
  return <>
    <Section title="Save this design">
      <label className="field"><span>Design name</span><input value={name} placeholder={`${project.name} design`} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === "Enter") save() }} /></label>
      <p className="hint">Stores page, theme, and layout only — never results, geometry, candidate names, or source paths.</p>
      <button className="primary-inline" onClick={save}>Save current design</button>
    </Section>
    <Section title={`Saved designs (${designs.length})`}>
      {!designs.length
        ? <p className="hint">No saved designs yet. Save one to reuse this look on another election.</p>
        : <ul className="design-list">{designs.map(design =>
          <li key={design.id} className={activeDesignId === design.id ? "selected" : ""}>
            <button className="design-name" onClick={() => onApplyDesign(design)} title="Apply this design to the current election">
              <strong>{design.name}</strong>
              <small>{LAYOUT_LABELS[design.layoutId ?? ""] ?? "Custom"} · {design.elements.length} elements</small>
            </button>
            <div className="design-actions">
              <button onClick={() => onApplyDesign(design)} title="Apply to the current election">Apply</button>
              <button onClick={() => onExportDesign(design)} title="Download a portable design file">Save file</button>
              {pendingDelete === design.id
                ? <button className="danger" onClick={() => { onDeleteDesign(design.id); setPendingDelete(undefined) }}>Confirm</button>
                : <button onClick={() => setPendingDelete(design.id)} title="Delete from this browser">Delete</button>}
            </div>
          </li>)}</ul>}
    </Section>
  </>;
}

/* ------------------------------------------------------------------ *
 * Comparison election                                                  *
 * ------------------------------------------------------------------ */

function ComparisonSection({ comparison, onLoadComparison, onRemoveComparison }: { comparison?: Project; onLoadComparison: () => void; onRemoveComparison: () => void }) {
  return <Section title="Comparison election">
    {comparison
      ? <>
        <p className="hint">Second dataset: <strong>{comparison.metadata.title}</strong> — {comparison.metadata.jurisdiction} · {comparison.renderData.records.length.toLocaleString()} precinct records.</p>
        <div className="button-row"><button onClick={onLoadComparison}>Replace</button><button onClick={onRemoveComparison}>Remove</button></div>
      </>
      : <>
        <p className="hint">Load a second matched election, then choose the Comparison layout for side-by-side maps, results panels, and legends.</p>
        <button className="primary-inline" onClick={onLoadComparison}>Load comparison election</button>
      </>}
  </Section>;
}

/* ------------------------------------------------------------------ *
 * Batch SVG export                                                     *
 * ------------------------------------------------------------------ */

function BatchExport({ project, designs, library, onNotice }: { project: Project; designs: Design[]; library: LibraryState; onNotice: (message: string, kind?: "info" | "error" | "success") => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [source, setSource] = useState("current");
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  const available = library.entries.filter(entry => entry.available);
  const selected = available.filter(entry => picked.includes(entry.id));

  async function generate() {
    const design = source === "current" ? createDesign(project, `${project.name} design`) : designs.find(candidate => candidate.id === source);
    if (!design) { onNotice("Choose which design to export.", "error"); return }
    if (!selected.length) { onNotice("Select at least one library election to export.", "error"); return }
    setProgress({ done: 0, total: selected.length });
    try {
      for (const [index, entry] of selected.entries()) {
        const response = await fetch(`/api/library/${entry.id}`);
        if (!response.ok) throw new Error(`${entry.state} ${entry.year}: ${await response.text()}`);
        const target = applyDesign(await response.json() as Project, design);
        const markup = renderToStaticMarkup(<MapRenderer project={target} />);
        downloadBlob(new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${standaloneSvg(markup, target.page)}\n`], { type: "image/svg+xml" }), `${slugify(`${entry.state}-${entry.year}-${entry.race}`)}.svg`);
        setProgress({ done: index + 1, total: selected.length });
      }
      onNotice(`Generated ${selected.length} SVG${selected.length === 1 ? "" : "s"} with ${design.name}.`, "success");
    } catch (error) {
      onNotice(`Batch SVG export failed: ${errorMessage(error)}`, "error");
    } finally {
      setProgress(undefined);
    }
  }

  return <details className="batch-export">
    <summary>Batch SVG export for other elections</summary>
    {library.status === "loading" && <p className="hint">Reading the local election catalog…</p>}
    {library.status === "error" && <p className="hint error">The election catalog could not be read: {library.message}</p>}
    {library.status === "ready" && !available.length && <p className="hint">No library election with an available source file was found, so there is nothing to batch.</p>}
    {library.status === "ready" && !!available.length && <>
        <label className="field"><span>Design</span><select value={source} onChange={event => setSource(event.target.value)}>
          <option value="current">Current editor design</option>
          {designs.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
        </select></label>
        <div className="batch-list">{available.map(entry =>
          <label key={entry.id} className="batch-item">
            <input type="checkbox" checked={picked.includes(entry.id)} onChange={event => setPicked(current => event.target.checked ? [...current, entry.id] : current.filter(id => id !== entry.id))} />
            <span>{entry.state} {entry.year} · {entry.race}</span>
          </label>)}
        </div>
        <div className="button-row">
          <button onClick={() => setPicked(available.map(entry => entry.id))}>All</button>
          <button onClick={() => setPicked([])}>None</button>
          <button className="primary-inline" disabled={!!progress || !selected.length} onClick={generate}>
            {progress ? `Generating ${progress.done}/${progress.total}…` : `Generate ${selected.length} SVG`}
          </button>
        </div>
        <p className="hint">Each election is loaded from its own matched precinct data with this design applied. Files download one at a time; allow multiple downloads in the browser.</p>
      </>}
  </details>;
}

/* ------------------------------------------------------------------ *
 * Dataset + diagnostics tab                                            *
 * ------------------------------------------------------------------ */

export function DatasetPanel({ project }: { project: Project }) {
  const summary = datasetSummary(project);
  const comparison = datasetSummary(project.comparison);
  const bounds = summary?.bounds;
  const reconciliation = project.renderData.library?.reconciliation;
  const crosswalk = project.renderData.library?.crosswalk;
  return <div className="dataset-panel">
    <div className="section-title"><strong>Dataset</strong><span>{project.metadata.jurisdiction} · matched source</span></div>
    <Section title="Processed election">
      <dl className="provenance">
        <div><dt>Race</dt><dd>{project.metadata.office}</dd></div>
        <div><dt>Date</dt><dd>{project.metadata.electionDate}</dd></div>
        <div><dt>Jurisdiction</dt><dd>{project.metadata.jurisdiction}</dd></div>
        <div><dt>Election</dt><dd>{project.metadata.electionType}</dd></div>
        <div><dt>Precinct features</dt><dd>{(summary?.features ?? 0).toLocaleString()}</dd></div>
        <div><dt>Records with votes</dt><dd>{`${(summary?.withVotes ?? 0).toLocaleString()} of ${(summary?.records ?? 0).toLocaleString()}`}</dd></div>
        <div><dt>Drawable features</dt><dd>{summary?.drawableFeatures.toLocaleString() ?? "0"}</dd></div>
        <div><dt>Unmapped records</dt><dd>{summary?.unmappedRecords.toLocaleString() ?? "0"}</dd></div>
        <div><dt>Votes without geometry</dt><dd>{summary?.unmappedVotes.toLocaleString() ?? "0"}</dd></div>
        <div><dt>Coordinate system</dt><dd>{project.renderData.crs ?? "not recorded"}</dd></div>
        {bounds && <div><dt>Bounds</dt><dd>{bounds.map(value => value.toFixed(2)).join(", ")}</dd></div>}
      </dl>
      {summary && <ul className="hint-list">{Object.entries(summary.candidateTotals).map(([id, votes]) => {
        const candidate = project.data.candidates.find(candidate => candidate.id === id);
        return <li key={id}>{candidate?.displayName ?? id}: {votes.toLocaleString()} votes{candidate?.visible === false ? " (hidden)" : ""}</li>;
      })}</ul>}
    </Section>
    {reconciliation && <Section title="Vote reconciliation">
      <p className="hint">Reference: {reconciliation.sourceLabel ?? "Declared source totals"}. Recovered totals include unmapped records; unrecovered ballots are not invented precinct votes.</p>
      <dl className="provenance">{Object.entries(reconciliation.source).map(([id, reference]) => <div key={id}>
        <dt>{project.data.candidates.find(candidate => candidate.id === id)?.displayName ?? id}</dt>
        <dd>{(reconciliation.preserved[id] ?? 0).toLocaleString()} recovered / {reference.toLocaleString()} reference total<br/>{(reconciliation.unmatched[id] ?? 0).toLocaleString()} recovered votes without geometry</dd>
      </div>)}</dl>
      {reconciliation.note && <p className="hint">{reconciliation.note}</p>}
    </Section>}
    {crosswalk && <Section title="Existing matching audit">
      <dl className="provenance">
        <div><dt>Audit rows</dt><dd>{crosswalk.rows.toLocaleString()}</dd></div>
        <div><dt>Accepted rows</dt><dd>{crosswalk.accepted.toLocaleString()}</dd></div>
        <div><dt>Unresolved rows</dt><dd>{crosswalk.unmatched.toLocaleString()}</dd></div>
        {Object.entries(crosswalk.confidence ?? {}).map(([level, count]) => <div key={level}><dt>{level} confidence</dt><dd>{count.toLocaleString()}</dd></div>)}
      </dl>
    </Section>}
    <Section title="Source provenance">
      {project.dataset
        ? <dl className="provenance">
          <div><dt>Dataset id</dt><dd>{project.dataset.id}</dd></div>
          <div><dt>Match status</dt><dd>{project.dataset.matchStatus}</dd></div>
          {project.dataset.matchMethod && <div><dt>Matching method</dt><dd>{project.dataset.matchMethod}</dd></div>}
          <div><dt>Geometry vintage</dt><dd>{project.dataset.geometryVintage}</dd></div>
          <div><dt>Source file</dt><dd title={project.dataset.sourcePath}>{project.dataset.sourcePath || project.data.geographyPath || "not recorded"}</dd></div>
          {project.dataset.resultsPath && <div><dt>Matched returns</dt><dd>{project.dataset.resultsPath}</dd></div>}
          {project.dataset.crosswalkPath && <div><dt>Crosswalk</dt><dd>{project.dataset.crosswalkPath}</dd></div>}
          <div><dt>Match audit</dt><dd title={project.dataset.matchAudit}>{project.dataset.matchAudit ?? "not provided"}</dd></div>
          {Object.entries(summary?.sourceHashes ?? {}).map(([path, hash]) => <div key={path}><dt>Source hash</dt><dd title={hash}>{`${hash.slice(0, 16)}…`} · {path.split("/").pop()}</dd></div>)}
        </dl>
        : <p className="hint">This project was not loaded from the matched library, so no library provenance is attached. Manual imports are reported in Diagnostics instead.</p>}
      {project.metadata.notes.length > 0 && <ul className="hint-list">{project.metadata.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
    </Section>
    {comparison && <Section title="Comparison election">
      <dl className="provenance">
        <div><dt>Race</dt><dd>{comparison.label}</dd></div>
        <div><dt>Jurisdiction</dt><dd>{comparison.jurisdiction}</dd></div>
        <div><dt>Date</dt><dd>{comparison.electionDate}</dd></div>
        <div><dt>Match status</dt><dd>{comparison.matchStatus ?? "not recorded"}</dd></div>
        <div><dt>Precinct features</dt><dd>{comparison.features.toLocaleString()}</dd></div>
        <div><dt>Records with votes</dt><dd>{`${comparison.withVotes.toLocaleString()} of ${comparison.records.toLocaleString()}`}</dd></div>
      </dl>
    </Section>}
    <Section title="Element data binding">
      <p className="hint">Map, results, legend, and selector elements draw from the primary or the comparison election. The assignment is saved in the design.</p>
      <ul className="binding-list">{project.elements.map(element =>
        <li key={element.id}><span>{element.name}</span><em>{element.dataset === "comparison" ? "comparison" : "primary"}</em></li>)}
      </ul>
    </Section>
    <DiagnosticsPanel diagnostics={[...project.renderData.diagnostics, ...visualDiagnostics(project)]} />
  </div>;
}

/* ------------------------------------------------------------------ *
 * Design chooser (workflow step 2)                                     *
 * ------------------------------------------------------------------ */

export type DesignChooserProps = {
  project: Project;
  designs: Design[];
  activeDesignId?: string;
  comparison?: Project;
  onLayout: (id: LayoutId) => void;
  onApplyDesign: (design: Design) => void;
  onDeleteDesign: (id: string) => void;
  onExportDesign: (design: Design) => void;
  onSaveDesign: (name: string) => void;
  onLoadComparison: () => void;
  onRemoveComparison: () => void;
  onContinue: () => void;
};

export function DesignChooser({ project, designs, activeDesignId, comparison, onLayout, onApplyDesign, onDeleteDesign, onExportDesign, onSaveDesign, onLoadComparison, onRemoveComparison, onContinue }: DesignChooserProps) {
  return <div className="chooser">
    <header className="chooser-head">
      <div>
        <span>STEP 2 · DESIGN</span>
        <h2>{project.metadata.title}</h2>
        <p>Pick a layout or a saved design. Designs restyle the page only — matched precinct geometry, candidate votes, and source provenance stay untouched.</p>
      </div>
      <dl className="chooser-meta">
        <div><dt>Election</dt><dd>{project.metadata.jurisdiction} · {project.metadata.electionDate}</dd></div>
        <div><dt>Precincts</dt><dd>{project.renderData.features.length.toLocaleString()}</dd></div>
        <div><dt>Current layout</dt><dd>{LAYOUT_LABELS[project.layoutId ?? ""] ?? "Custom"}</dd></div>
      </dl>
    </header>
    <div className="chooser-body">
      <section className="chooser-layouts">
        <h3>Layouts</h3>
        <div className="layout-cards">{LAYOUTS.map(layout => {
          const blocked = layout.id === "comparison" && !comparison;
          return <button key={layout.id} className={`layout-card ${project.layoutId === layout.id ? "selected" : ""}`} disabled={blocked} onClick={() => onLayout(layout.id)}>
            <LayoutSketch id={layout.id} />
            <strong>{layout.name}</strong>
            <p>{layout.description}</p>
            {blocked && <em>Load a comparison election to use this layout</em>}
          </button>;
        })}</div>
        <ComparisonSection comparison={comparison} onLoadComparison={onLoadComparison} onRemoveComparison={onRemoveComparison} />
      </section>
      <aside className="chooser-side">
        <SavedDesigns project={project} designs={designs} activeDesignId={activeDesignId} onApplyDesign={onApplyDesign} onDeleteDesign={onDeleteDesign} onExportDesign={onExportDesign} onSaveDesign={onSaveDesign} />
        <button className="primary chooser-continue" onClick={onContinue}>Open editor →</button>
      </aside>
    </div>
  </div>;
}

/* ------------------------------------------------------------------ *
 * Design inspector panel (workflow step 3)                             *
 * ------------------------------------------------------------------ */

export type DesignPanelProps = {
  project: Project;
  designs: Design[];
  activeDesignId?: string;
  comparison?: Project;
  onUpdate: (mutate: (draft: Project) => void) => void;
  onLayout: (id: LayoutId) => void;
  onApplyDesign: (design: Design) => void;
  onDeleteDesign: (id: string) => void;
  onExportDesign: (design: Design) => void;
  onSaveDesign: (name: string) => void;
  onLoadComparison: () => void;
  onRemoveComparison: () => void;
  onExport: (format: "svg" | "png" | "pdf") => void;
  onExportProject: () => void;
  onImportProject: (file: File) => void;
  onImportDesign: (file: File) => void;
  onExportPalette: () => void;
  onImportPalette: (file: File) => void;
  onNotice: (message: string, kind?: "info" | "error" | "success") => void;
  library: LibraryState;
};

export function DesignPanel({ project, designs, activeDesignId, comparison, onUpdate, onLayout, onApplyDesign, onDeleteDesign, onExportDesign, onSaveDesign, onLoadComparison, onRemoveComparison, onExport, onExportProject, onImportProject, onImportDesign, onExportPalette, onImportPalette, onNotice, library }: DesignPanelProps) {
  const headers = project.elements.filter((element): element is Extract<StudioElement, { type: "header" }> => element.type === "header");
  const results = project.elements.filter((element): element is Extract<StudioElement, { type: "results" }> => element.type === "results");
  const texts = project.elements.filter((element): element is Extract<StudioElement, { type: "text" }> => element.type === "text");
  const setHeader = (id: string, field: "title" | "subtitle" | "kicker" | "identifier", token: string) =>
    onUpdate(draft => { const target = draft.elements.find(element => element.id === id); if (target?.type === "header") target[field] = token });
  const setResults = (id: string, field: "officeTitle" | "electionLabel", token: string) =>
    onUpdate(draft => { const target = draft.elements.find(element => element.id === id); if (target?.type === "results") target[field] = token });
  const setText = (id: string, token: string) =>
    onUpdate(draft => { const target = draft.elements.find(element => element.id === id); if (target?.type === "text") target.text = token });

  return <div className="design-panel">
    <Section title="Layout">
      <div className="layout-chips">{LAYOUTS.map(layout => {
        const blocked = layout.id === "comparison" && !comparison;
        return <button key={layout.id} className={`chip ${project.layoutId === layout.id ? "active" : ""}`} disabled={blocked} title={blocked ? "Load a comparison election first" : layout.description} onClick={() => onLayout(layout.id)}>{layout.name}</button>;
      })}</div>
      <p className="hint">A layout repositions and restyles the page while keeping this election's results and geometry.</p>
    </Section>

    <SavedDesigns project={project} designs={designs} activeDesignId={activeDesignId} onApplyDesign={onApplyDesign} onDeleteDesign={onDeleteDesign} onExportDesign={onExportDesign} onSaveDesign={onSaveDesign} />
    <ComparisonSection comparison={comparison} onLoadComparison={onLoadComparison} onRemoveComparison={onRemoveComparison} />

    <Section title="Page">
      <div className="field-grid two">
        <NumberField label="Width (px)" value={project.page.width} onChange={value => onUpdate(draft => { if (value > 0) draft.page.width = value })} />
        <NumberField label="Height (px)" value={project.page.height} onChange={value => onUpdate(draft => { if (value > 0) draft.page.height = value })} />
      </div>
      <div className="field-grid two">
        <NumberField label="DPI" value={project.page.dpi} onChange={value => onUpdate(draft => { if (value > 0) draft.page.dpi = value })} />
      </div>
      <ColorField label="Page background" value={project.page.background} onChange={value => onUpdate(draft => { draft.page.background = value })} />
      <NumberField label="Safe margin" value={project.page.safeMargin} onChange={value => onUpdate(draft => { draft.page.safeMargin = value })} />
      <NumberField label="Grid size" value={project.page.grid.size} onChange={value => onUpdate(draft => { if (value > 0) draft.page.grid.size = value })} step={0.5} />
    </Section>

    <Section title="Theme colors · layout defaults">
      {(["header", "panel", "page", "ink", "muted", "border", "noData", "unopposed"] as const).map(key =>
        <ColorField key={key} label={key} value={project.theme.colors[key]} onChange={value => onUpdate(draft => { draft.theme.colors[key] = value })} />)}
      <ColorField label="Frame line" value={project.theme.border.color} onChange={value => onUpdate(draft => { draft.theme.border.color = value })} />
      <NumberField label="Line width" value={project.theme.border.width} step={0.5} onChange={value => onUpdate(draft => { draft.theme.border.width = value })} />
    </Section>

    <Section title="Theme fonts · layout defaults">
      <TextField label="Serif" value={project.theme.fonts.serif} onChange={value => onUpdate(draft => { draft.theme.fonts.serif = value })} />
      <TextField label="Sans" value={project.theme.fonts.sans} onChange={value => onUpdate(draft => { draft.theme.fonts.sans = value })} />
      <TextField label="Data" value={project.theme.fonts.data} onChange={value => onUpdate(draft => { draft.theme.fonts.data = value })} />
      <p className="hint">Reapply a layout to use these defaults. Element typography and colors change existing layers without resetting their arrangement. Fonts must be available in the browser and on the export server.</p>
    </Section>

    {(headers.length > 0 || results.length > 0 || texts.length > 0) && <Section title="Metadata bindings">
      <p className="hint">Bound fields follow whichever election the design is applied to, so a saved design stays correct on another race.</p>
      {headers.map(element => <div key={element.id} className="binding-editor">
        <strong>{element.name}</strong>
        <BindingSelect label="Title" value={element.title} onChange={token => setHeader(element.id, "title", token)} />
        <BindingSelect label="Subtitle" value={element.subtitle} onChange={token => setHeader(element.id, "subtitle", token)} />
        <BindingSelect label="Kicker" value={element.kicker} onChange={token => setHeader(element.id, "kicker", token)} />
        <BindingSelect label="Identifier" value={element.identifier} onChange={token => setHeader(element.id, "identifier", token)} />
      </div>)}
      {results.map(element => <div key={element.id} className="binding-editor">
        <strong>{element.name}</strong>
        <BindingSelect label="Office" value={element.officeTitle} onChange={token => setResults(element.id, "officeTitle", token)} />
        <BindingSelect label="Election label" value={element.electionLabel} onChange={token => setResults(element.id, "electionLabel", token)} />
      </div>)}
      {texts.map(element => <div key={element.id} className="binding-editor">
        <strong>{element.name}</strong>
        <BindingSelect label="Text" value={element.text} onChange={token => setText(element.id, token)} />
      </div>)}
    </Section>}

    <Section title="Export">
      <div className="button-row">
        <button onClick={() => onExport("svg")}>SVG</button>
        <button onClick={() => onExport("png")}>PNG</button>
        <button onClick={() => onExport("pdf")}>PDF</button>
      </div>
      <p className="hint">SVG keeps paths and text; PNG and PDF are converted from the same vector page at {project.page.dpi} DPI.</p>
      <div className="button-row">
        <button onClick={() => onExportDesign(createDesign(project, designs.find(design => design.id === activeDesignId)?.name ?? `${project.name} design`))}>Download design file</button>
        <button onClick={onExportProject}>Download project</button>
      </div>
      <div className="button-row">
        <label className="button">Import design<input type="file" accept=".json" hidden onChange={event => { const file = event.target.files?.[0]; if (file) onImportDesign(file); event.target.value = "" }} /></label>
        <label className="button">Reopen project<input type="file" accept=".json,.pmap.json" hidden onChange={event => { const file = event.target.files?.[0]; if (file) onImportProject(file); event.target.value = "" }} /></label>
      </div>
      <p className="hint">Design files carry page, theme, and layout only. Project files carry election results, matched geometry, and provenance.</p>
      <div className="button-row">
        <button onClick={onExportPalette}>Download candidate palette</button>
        <label className="button">Apply palette<input type="file" accept=".json" hidden onChange={event => { const file = event.target.files?.[0]; if (file) onImportPalette(file); event.target.value = "" }} /></label>
      </div>
      <p className="hint">A palette transfers candidate colors to another election by stable candidate id, leaving names, votes, and ordering untouched.</p>
    </Section>

    <BatchExport project={project} designs={designs} library={library} onNotice={onNotice} />
  </div>;
}
