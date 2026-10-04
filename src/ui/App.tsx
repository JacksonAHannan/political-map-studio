import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Rnd } from "react-rnd";
import { MapRenderer } from "../render/MapRenderer";
import { commit, redo, undo, type HistoryState } from "../model/history";
import { validateProject } from "../model/schema";
import { applyDesignReport, applyLayoutReport, applyPalette, createDesign, normalizeDesign, paletteFromProject, switchElectionReport, withComparison } from "../model/design";
import type { Design, LayoutId, Project } from "../model/types";
import { LayersPanel } from "./LayersPanel";
import { Inspector } from "./Inspector";
import { DataImporter } from "./DataImporter";
import { LibraryPanel, useLibrary, type LibraryEntry } from "./LibraryPanel";
import { DesignChooser, DesignPanel, DatasetPanel, readSavedDesigns, writeSavedDesigns, downloadBlob, downloadJson, errorMessage, slugify } from "./DesignPanel";
import "./library.css";
import { loadAutosave, loadAutosaveInfo, saveAutosave, type AutosaveInfo } from "../model/autosave";

type Screen = "library" | "design" | "editor";
type Tab = "design" | "properties" | "dataset" | "data" | "json";
type Notice = { text: string; kind: "info" | "error" | "success" };
type Action = { type: "commit"; project: Project } | { type: "undo" } | { type: "redo" };

/** Everyday inspector tabs, and the two raw-control tabs kept behind the Advanced disclosure. */
const PRIMARY_TABS: Array<[Tab, string, string]> = [
  ["design", "Design", "Page, theme, layout, saved designs, and export"],
  ["properties", "Element", "Selected layer properties"],
  ["dataset", "Dataset", "Election, source provenance, and diagnostics"],
];
const ADVANCED_TABS: Array<[Tab, string, string]> = [
  ["data", "GIS import", "Process new geography and results files"],
  ["json", "JSON", "Edit the raw project document"],
];

const reducer = (state: HistoryState | null, action: Action): HistoryState | null => {
  if (action.type === "commit") return state ? commit(state, action.project) : { past: [], present: action.project, future: [] };
  if (!state) return state;
  return action.type === "undo" ? undo(state) : redo(state);
};

/**
 * Clone everything the editor is allowed to change. Matched geometry, derived records,
 * diagnostics, and source hashes are carried by reference so no editor action can rewrite
 * the processed election, and large precinct geometry is never copied on a drag.
 */
function editorClone(project: Project): Project {
  return {
    ...project,
    metadata: { ...project.metadata, notes: [...project.metadata.notes] },
    page: { ...project.page, grid: { ...project.page.grid } },
    theme: structuredClone(project.theme),
    data: { ...project.data, join: { ...project.data.join }, fields: { ...project.data.fields }, candidates: project.data.candidates.map(candidate => structuredClone(candidate)) },
    export: { ...project.export, formats: [...project.export.formats] },
    elements: project.elements.map(element => structuredClone(element)),
    comparison: project.comparison ? editorClone(project.comparison) : undefined,
  };
}

export function App() {
  const [history, dispatch] = useReducer(reducer, null);
  const [screen, setScreen] = useState<Screen>("library");
  const [tab, setTab] = useState<Tab>("properties");
  const [advanced, setAdvanced] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [zoom, setZoom] = useState(0.62);
  const [jsonDraft, setJsonDraft] = useState("");
  const [notice, setNotice] = useState<Notice>({ text: "Reading the local election library…", kind: "info" });
  const [autosavedAt, setAutosavedAt] = useState<string>();
  const [resume, setResume] = useState<AutosaveInfo>();
  const [resuming, setResuming] = useState(false);
  const [preserveDesign, setPreserveDesign] = useState(true);
  const [comparisonReturn, setComparisonReturn] = useState<"design" | "editor">();
  const [designs, setDesigns] = useState<Design[]>(() => readSavedDesigns());
  const [activeDesignId, setActiveDesignId] = useState<string>();
  const stageRef = useRef<HTMLElement>(null);
  const library = useLibrary();
  const project = history?.present;
  const comparison = project?.comparison;
  const pickingComparison = screen === "library" && !!comparisonReturn;

  /* Startup: offer the autosave, never auto-load demo content. */
  useEffect(() => {
    loadAutosaveInfo()
      .then(saved => {
        if (!saved) return;
        setResume(saved);
        setNotice({ text: "An unsaved project was recovered. Resume it or choose an election below.", kind: "info" });
      })
      .catch(error => setNotice({ text: `Autosave unavailable: ${errorMessage(error)}`, kind: "error" }));
  }, []);

  /* Autosave is paused on the library screen so the recovered project is not overwritten. */
  useEffect(() => {
    if (!project || screen === "library") return;
    const timer = setTimeout(() => {
      saveAutosave(project)
        .then(() => setAutosavedAt(new Date().toISOString()))
        .catch(error => setNotice({ text: `Autosave unavailable: ${errorMessage(error)}`, kind: "error" }));
    }, 900);
    return () => clearTimeout(timer);
  }, [project, screen]);

  useEffect(() => { if (project && tab === "json") setJsonDraft(JSON.stringify(project, null, 2)) }, [project, tab]);

  const update = useCallback((mutate: (draft: Project) => void) => {
    if (!project) return;
    const next = editorClone(project);
    mutate(next);
    next.modifiedAt = new Date().toISOString();
    dispatch({ type: "commit", project: next });
  }, [project]);

  const commitProject = (next: Project) => {
    dispatch({ type: "commit", project: next });
    setSelected(current => next.elements.some(element => element.id === current) ? current : next.elements[0]?.id);
  };

  const exportMap = useCallback(async (format: "svg" | "png" | "pdf") => {
    if (!project) return;
    const live = document.getElementById("studio-canvas-svg");
    if (!live) { setNotice({ text: "Open the editor to export: the canvas is only mounted while editing.", kind: "error" }); return }
    const clean = live.cloneNode(true) as SVGSVGElement;
    clean.querySelectorAll("[data-editor-overlay]").forEach(node => node.remove());
    clean.setAttribute("width", String(project.page.width));
    clean.setAttribute("height", String(project.page.height));
    const svg = clean.outerHTML;
    if (format === "svg") { downloadBlob(new Blob([svg], { type: "image/svg+xml" }), `${slugify(project.name)}.svg`); setNotice({ text: "SVG exported", kind: "success" }); return }
    try {
      const response = await fetch(`/api/export/${format}`, { method: "POST", headers: { "Content-Type": "image/svg+xml", "X-Page-Dpi": String(project.page.dpi) }, body: svg });
      if (!response.ok) throw new Error(await response.text());
      downloadBlob(await response.blob(), `${slugify(project.name)}.${format}`);
      setNotice({ text: `${format.toUpperCase()} exported`, kind: "success" });
    } catch (error) {
      setNotice({ text: `Export failed: ${errorMessage(error)}`, kind: "error" });
    }
  }, [project]);

  const duplicateSelected = useCallback(() => {
    const element = project?.elements.find(candidate => candidate.id === selected);
    if (!element) return;
    const clone = structuredClone(element);
    clone.id = `${clone.id}-copy-${Date.now()}`;
    clone.name = `${clone.name} copy`;
    clone.frame.x += 18;
    clone.frame.y += 18;
    update(draft => {
      clone.zIndex = Math.max(...draft.elements.map(item => item.zIndex)) + 1;
      draft.elements.push(clone);
    });
    setSelected(clone.id);
  }, [project, selected, update]);

  /* Shortcuts never fire while the user is typing in a field or a dialog is open. */
  useEffect(() => {
    if (!project || screen === "library") return;
    const key = (event: KeyboardEvent) => {
      const target = event.target;
      const typing = target instanceof HTMLElement
        && (target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement);
      if (typing) return;
      const meta = event.ctrlKey || event.metaKey;
      if (meta && event.key.toLowerCase() === "z") { event.preventDefault(); dispatch({ type: event.shiftKey ? "redo" : "undo" }) }
      else if (meta && event.key.toLowerCase() === "s") { event.preventDefault(); downloadJson(project, `${slugify(project.name)}.pmap.json`); setNotice({ text: "Project downloaded", kind: "success" }) }
      else if (meta && event.key.toLowerCase() === "d") { event.preventDefault(); duplicateSelected() }
      else if (event.key === "Delete" && selected) { update(draft => { draft.elements = draft.elements.filter(element => element.id !== selected) }); setSelected(undefined) }
      else if (meta && ["+", "="].includes(event.key)) { event.preventDefault(); setZoom(value => Math.min(2, value + 0.08)) }
      else if (meta && event.key === "-") { event.preventDefault(); setZoom(value => Math.max(0.15, value - 0.08)) }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [project, screen, selected, update, duplicateSelected]);

  const selectedElement = useMemo(() => project?.elements.find(element => element.id === selected), [project, selected]);

  function persistDesigns(next: Design[]): boolean {
    try {
      writeSavedDesigns(next);
      setDesigns(next);
      return true;
    } catch (error) {
      setNotice({ text: `Design storage refused the save: ${errorMessage(error)}`, kind: "error" });
      return false;
    }
  }

  async function openElection(entry: LibraryEntry) {
    const response = await fetch(`/api/library/${entry.id}`);
    if (!response.ok) throw new Error(await response.text());
    const incoming = await response.json() as Project;
    setComparisonReturn(undefined);
    if (!project) {
      commitProject(incoming);
      setNotice({ text: `${entry.state} ${entry.year} ${entry.race} loaded from the matched library.`, kind: "success" });
      setScreen("design");
      return;
    }
    const report = switchElectionReport(project, incoming, preserveDesign);
    const attached = withComparison(report.project, report.project.comparison);
    commitProject(attached.project);
    const messages = [...report.notices, ...attached.notices].map(notice => notice.message);
    setNotice({ text: `${entry.state} ${entry.year} ${entry.race} loaded${preserveDesign ? " over the current page design" : ""}.${messages.length ? ` ${messages.join(" ")}` : ""}`, kind: messages.length ? "info" : "success" });
    // A kept design means the page is ready to edit; otherwise the next step is choosing a design.
    setScreen(preserveDesign ? "editor" : "design");
  }

  async function loadComparison(entry: LibraryEntry) {
    if (!project) return;
    const response = await fetch(`/api/library/${entry.id}`);
    if (!response.ok) throw new Error(await response.text());
    const incoming = await response.json() as Project;
    const attached = withComparison(project, incoming);
    const laid = applyLayoutReport(attached.project, "comparison");
    commitProject(laid.project);
    setComparisonReturn(undefined);
    setScreen(comparisonReturn ?? "design");
    const notices = [...attached.notices, ...laid.notices];
    setNotice({ text: `Comparison set to ${entry.state} ${entry.year} ${entry.race} and the comparison layout applied.${notices.length ? ` ${notices.map(notice => notice.message).join(" ")}` : ""}`, kind: notices.some(notice => notice.level === "warning") ? "info" : "success" });
  }

  function chooseLayout(id: LayoutId) {
    if (!project) return;
    if (id === "comparison" && !comparison) { setComparisonReturn(screen === "editor" ? "editor" : "design"); setScreen("library"); return }
    const report = applyLayoutReport(project, id);
    commitProject(report.project);
    const messages = report.notices.map(notice => notice.message);
    setNotice({ text: `${id} layout applied to ${project.metadata.title}.${messages.length ? ` ${messages.join(" ")}` : ""}`, kind: messages.length ? "info" : "success" });
  }

  function removeComparison() {
    if (!project) return;
    commitProject(withComparison(project).project);
    setNotice({ text: "Comparison election removed. Elements bound to the comparison dataset stay inactive until another comparison is loaded.", kind: "info" });
  }

  function applySavedDesign(design: Design) {
    if (!project) return;
    try {
      const report = applyDesignReport(project, design);
      commitProject(report.project);
      setActiveDesignId(design.id);
      const messages = report.notices.map(notice => notice.message);
      setNotice({ text: `Design “${design.name}” applied. Results, geometry, and provenance are unchanged.${messages.length ? ` ${messages.join(" ")}` : ""}`, kind: messages.length ? "info" : "success" });
    } catch (error) {
      setNotice({ text: `Design could not be applied: ${errorMessage(error)}`, kind: "error" });
    }
  }

  function saveDesign(name: string) {
    if (!project) return;
    const design = createDesign(project, name.trim() || `${project.name} design`);
    if (!persistDesigns(designs.some(existing => existing.name === design.name) ? designs.map(existing => existing.name === design.name ? design : existing) : [...designs, design])) return;
    setActiveDesignId(design.id);
    setNotice({ text: `Design “${design.name}” saved in this browser.`, kind: "success" });
  }

  function deleteDesign(id: string) {
    if (!persistDesigns(designs.filter(design => design.id !== id))) return;
    if (activeDesignId === id) setActiveDesignId(undefined);
    setNotice({ text: "Design deleted from this browser.", kind: "info" });
  }

  function exportDesignFile(design: Design) {
    downloadJson(design, `${slugify(design.name)}.design.json`);
    setNotice({ text: `Design “${design.name}” downloaded.`, kind: "success" });
  }

  /** Accepts portable design files and the pre-design template format used by older exports. */
  function importDesign(file: File) {
    file.text().then(text => {
      const parsed = JSON.parse(text);
      const looksLikeDesign = parsed?.kind === "design" && Array.isArray(parsed.elements);
      const looksLikeTemplate = parsed?.kind === "template" && Array.isArray(parsed.elements);
      if (!looksLikeDesign && !looksLikeTemplate) throw new Error("This file is not a design or template document");
      if (!project) throw new Error("Choose an election before importing a reusable design");
      const design = normalizeDesign(parsed, project);
      const report = applyDesignReport(project, design);
      if (!persistDesigns([...designs.filter(existing => existing.id !== design.id), design])) return;
      commitProject(report.project);
      setActiveDesignId(design.id);
      const messages = report.notices.map(notice => notice.message);
      setNotice({ text: `Design “${design.name}” imported and applied.${messages.length ? ` ${messages.join(" ")}` : ""}`, kind: "success" });
    }).catch(error => setNotice({ text: `Design import failed: ${errorMessage(error)}`, kind: "error" }));
  }

  /** Candidate colors transfer between elections by stable id; votes and labels never move. */
  function importPalette(file: File) {
    if (!project) return;
    file.text().then(text => {
      const report = applyPalette(project, JSON.parse(text));
      commitProject(report.project);
      const unmatched = report.unmatched.length;
      setNotice({
        text: `Palette applied to ${report.applied.length} candidate${report.applied.length === 1 ? "" : "s"}${unmatched ? `; ${unmatched} entr${unmatched === 1 ? "y" : "ies"} matched nothing in this election and were left out` : ""}.`,
        kind: unmatched ? "info" : "success",
      });
    }).catch(error => setNotice({ text: `Palette import failed: ${errorMessage(error)}`, kind: "error" }));
  }

  function importProject(file: File) {
    file.text().then(text => {
      const parsed = JSON.parse(text);
      if (parsed?.kind === "design" || parsed?.kind === "template") { importDesign(file); return }
      const check = validateProject(parsed);
      if (!check.success) throw new Error(check.error.issues[0]?.message ?? "project validation failed");
      const next = parsed as Project;
      commitProject(next);
      setResume(undefined);
      setActiveDesignId(undefined);
      setScreen("editor");
      setNotice({ text: `${next.metadata.title} reopened${next.comparison ? " with its comparison dataset" : ""}.`, kind: "success" });
    }).catch(error => setNotice({ text: `Project could not be opened: ${errorMessage(error)}`, kind: "error" }));
  }

  async function resumeProject() {
    if (!resume || resuming) return;
    setResuming(true);
    try {
      const saved = await loadAutosave();
      if (!saved || !validateProject(saved).success) throw new Error("Stored project failed validation and was left untouched.");
      commitProject(saved);
      setResume(undefined);
      setScreen("editor");
      setNotice({ text: `${saved.metadata.title} resumed from autosave.`, kind: "success" });
    } catch (error) {
      setNotice({ text: `Recovery failed: ${errorMessage(error)}`, kind: "error" });
    } finally {
      setResuming(false);
    }
  }

  function downloadProject() {
    if (!project) return;
    downloadJson(project, `${slugify(project.name)}.pmap.json`);
    setNotice({ text: "Project downloaded — results, geometry, and provenance included.", kind: "success" });
  }

  function applyJson() {
    try {
      const parsed = JSON.parse(jsonDraft);
      const check = validateProject(parsed);
      if (!check.success) throw new Error(check.error.issues.map(issue => issue.message).join("; "));
      commitProject(parsed as Project);
      setNotice({ text: "JSON applied to the project.", kind: "success" });
    } catch (error) {
      setNotice({ text: `JSON error: ${errorMessage(error)}`, kind: "error" });
    }
  }

  function fitZoom() {
    if (!project || !stageRef.current) { setZoom(0.62); return }
    const { clientWidth, clientHeight } = stageRef.current;
    setZoom(Math.max(0.15, Math.min(1.5, Math.min((clientWidth - 90) / project.page.width, (clientHeight - 90) / project.page.height))));
  }

  const resumeBanner = <div className="resume-banner">
    <div className="resume-text">
      <strong>{resume ? "Unsaved work found" : "Start from a project file"}</strong>
      <span>{resume ? `${resume.metadata.title} · last modified ${new Date(resume.modifiedAt).toLocaleString()}` : "Nothing is auto-loaded. Choose an election below, or reopen a project you saved earlier."}</span>
    </div>
    <div className="button-row">
      {resume && <button className="primary" disabled={resuming} onClick={resumeProject}>{resuming ? "Restoring project…" : "Resume saved project"}</button>}
      {resume && <button onClick={() => { setResume(undefined); setNotice({ text: "Recovered project dismissed. It stays in autosave until you edit another election.", kind: "info" }) }}>Dismiss</button>}
      <label className="button">Reopen project file<input type="file" accept=".json,.pmap.json" hidden onChange={event => { const file = event.target.files?.[0]; if (file) importProject(file); event.target.value = "" }} /></label>
    </div>
  </div>;

  if (screen === "library" || !project) {
    return <div className="studio-shell">
      <header className="app-bar">
        <div className="brand"><span className="brand-mark">PM</span><div><strong>Political Map Studio</strong><span>{project ? project.name : "Matched election library"}</span></div></div>
        <Workflow screen={screen} tab={tab} onScreen={setScreen} onTab={setTab} hasProject={!!project} />
        <div className="status">{notice.text}</div>
      </header>
      <LibraryPanel
        current={project}
        library={library}
        onReload={library.reload}
        purpose={pickingComparison ? "comparison" : "primary"}
        preserveDesign={preserveDesign}
        onPreserveDesign={setPreserveDesign}
        onNotice={(text, kind = "info") => setNotice({ text, kind })}
        banner={pickingComparison ? undefined : resumeBanner}
        notice={pickingComparison ? "Pick a second matched election. Its own geometry, results, and provenance are used for the comparison elements." : undefined}
        onOpen={async entry => {
          if (pickingComparison) await loadComparison(entry);
          else await openElection(entry);
        }}
      />
      {pickingComparison && <button className="cancel-overlay" onClick={() => { setComparisonReturn(undefined); setScreen(comparisonReturn === "editor" ? "editor" : "design") }}>Cancel comparison selection</button>}
    </div>;
  }

  const statusLine = `${project.metadata.jurisdiction} · ${project.renderData.features.length.toLocaleString()} precinct features · ${project.renderData.records.length.toLocaleString()} records`;

  if (screen === "design") {
    return <div className="studio-shell design-shell">
      <header className="app-bar">
        <div className="brand"><span className="brand-mark">PM</span><div><strong>Political Map Studio</strong><span>{project.name}</span></div></div>
        <Workflow screen={screen} tab={tab} onScreen={setScreen} onTab={setTab} hasProject />
        <div className="status">{notice.text}</div>
      </header>
      <DesignChooser
        project={project}
        designs={designs}
        activeDesignId={activeDesignId}
        comparison={comparison}
        onLayout={chooseLayout}
        onApplyDesign={applySavedDesign}
        onDeleteDesign={deleteDesign}
        onExportDesign={exportDesignFile}
        onSaveDesign={saveDesign}
        onLoadComparison={() => { setComparisonReturn("design"); setScreen("library") }}
        onRemoveComparison={removeComparison}
        onContinue={() => setScreen("editor")}
      />
    </div>;
  }

  return <div className="studio-shell">
    <header className="app-bar">
      <div className="brand"><span className="brand-mark">PM</span><div><strong>Political Map Studio</strong><span>{project.name}</span></div></div>
      <Workflow screen={screen} tab={tab} onScreen={setScreen} onTab={setTab} hasProject />
      <div className="toolbar">
        <button onClick={() => dispatch({ type: "undo" })} disabled={!history?.past.length} title="Undo (Ctrl+Z)">↶</button>
        <button onClick={() => dispatch({ type: "redo" })} disabled={!history?.future.length} title="Redo (Ctrl+Y)">↷</button>
        <span className="separator" />
        <button onClick={() => setZoom(value => Math.max(0.15, value - 0.08))} title="Zoom out (Ctrl+-)">−</button>
        <output>{Math.round(zoom * 100)}%</output>
        <button onClick={() => setZoom(value => Math.min(2, value + 0.08))} title="Zoom in (Ctrl++)">+</button>
        <button onClick={fitZoom}>Fit</button>
        <span className="separator" />
        <button onClick={() => exportMap("svg")}>SVG</button>
        <button onClick={() => exportMap("png")}>PNG</button>
        <button onClick={() => exportMap("pdf")}>PDF</button>
      </div>
      <div className="status">{notice.text}{autosavedAt && <em className="autosave-stamp"> · autosaved {new Date(autosavedAt).toLocaleTimeString()}</em>}</div>
    </header>
    <div className="workspace">
      <LayersPanel project={project} selected={selected} onSelect={setSelected} onChange={update} onDuplicate={duplicateSelected} />
      <main className={`stage ${notice.kind === "error" ? "has-error" : ""}`} ref={stageRef}>
        <div className="stage-bar">
          <span>{statusLine}</span>
          <span>Layout: {project.layoutId ?? "custom"}{comparison ? " · comparison loaded" : ""}</span>
        </div>
        <div className="canvas-wrap" style={{ width: project.page.width * zoom, height: project.page.height * zoom }}>
          <div className="canvas" style={{ width: project.page.width, height: project.page.height, transform: `scale(${zoom})`, transformOrigin: "top left" }}>
            <MapRenderer project={project} selectedId={selected} onSelect={setSelected} />
            {selectedElement && !selectedElement.locked && <Rnd
              bounds="parent"
              scale={zoom}
              size={{ width: selectedElement.frame.width, height: selectedElement.frame.height }}
              position={{ x: selectedElement.frame.x, y: selectedElement.frame.y }}
              onDragStop={(_, data) => update(draft => {
                const element = draft.elements.find(item => item.id === selected);
                if (!element) return;
                const snap = draft.page.grid.snap;
                const size = draft.page.grid.size;
                element.frame.x = snap ? Math.round(data.x / size) * size : Math.round(data.x);
                element.frame.y = snap ? Math.round(data.y / size) * size : Math.round(data.y);
              })}
              onResizeStop={(_, __, ref, ___, position) => update(draft => {
                const element = draft.elements.find(item => item.id === selected);
                if (!element) return;
                element.frame = { x: Math.round(position.x), y: Math.round(position.y), width: Math.round(ref.offsetWidth), height: Math.round(ref.offsetHeight) };
              })}
              className="selection-box" />}
          </div>
        </div>
      </main>
      <aside className="inspector">
        <nav>
          {PRIMARY_TABS.map(([value, label, hint]) =>
            <button key={value} className={tab === value ? "active" : ""} title={hint} onClick={() => setTab(value)}>{label}</button>)}
          <button
            className={`advanced-toggle ${advanced ? "open" : ""}`}
            title={advanced ? "Hide GIS import and raw JSON" : "Show GIS import and raw JSON"}
            aria-expanded={advanced}
            onClick={() => setAdvanced(open => {
              const next = !open;
              if (!next) setTab(current => current === "data" || current === "json" ? "design" : current);
              return next;
            })}>{advanced ? "▾" : "▸"} Advanced</button>
          {advanced && ADVANCED_TABS.map(([value, label, hint]) =>
            <button key={value} className={tab === value ? "active" : ""} title={hint} onClick={() => setTab(value)}>{label}</button>)}
        </nav>
        {tab === "design" && <DesignPanel
          project={project}
          designs={designs}
          activeDesignId={activeDesignId}
          comparison={comparison}
          library={library}
          onUpdate={update}
          onLayout={chooseLayout}
          onApplyDesign={applySavedDesign}
          onDeleteDesign={deleteDesign}
          onExportDesign={exportDesignFile}
          onSaveDesign={saveDesign}
          onLoadComparison={() => { setComparisonReturn("editor"); setScreen("library") }}
          onRemoveComparison={removeComparison}
          onExport={exportMap}
          onExportProject={downloadProject}
          onImportProject={importProject}
          onImportDesign={importDesign}
          onExportPalette={() => { downloadJson(paletteFromProject(project), `${slugify(project.name)}.palette.json`); setNotice({ text: "Candidate palette downloaded.", kind: "success" }) }}
          onImportPalette={importPalette}
          onNotice={(text, kind = "info") => setNotice({ text, kind })}
        />}
        {tab === "properties" && <Inspector project={project} element={selectedElement} onChange={update} />}
        {tab === "dataset" && <DatasetPanel project={project} />}
        {tab === "data" && <DataImporter project={project} onProject={commitProject} onNotice={text => setNotice({ text, kind: "info" })} />}
        {tab === "json" && <div className="json-editor"><textarea value={jsonDraft} onChange={event => setJsonDraft(event.target.value)} spellCheck={false} /><button onClick={applyJson}>Validate and apply</button></div>}
      </aside>
    </div>
  </div>;
}

function Workflow({ screen, tab, onScreen, onTab, hasProject }: { screen: Screen; tab: Tab; onScreen: (screen: Screen) => void; onTab: (tab: Tab) => void; hasProject: boolean }) {
  const steps: Array<{ key: string; label: string; active: boolean; go: () => void; disabled?: boolean }> = [
    { key: "election", label: "1 Election", active: screen === "library" || screen === "design", go: () => onScreen("library") },
    { key: "design", label: "2 Design", active: screen === "design", go: () => onScreen("design"), disabled: !hasProject },
    { key: "edit", label: "3 Edit", active: screen === "editor" && tab !== "design", go: () => { onScreen("editor"); onTab("properties") }, disabled: !hasProject },
    { key: "export", label: "4 Export", active: screen === "editor" && tab === "design", go: () => { onScreen("editor"); onTab("design") }, disabled: !hasProject },
  ];
  return <nav className="workflow">{steps.map(step =>
    <button key={step.key} className={step.active ? "active" : ""} disabled={step.disabled} onClick={step.go}>{step.label}</button>)}
  </nav>;
}
