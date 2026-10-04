import { applyPalette, contentBox, dataBounds, datasetProject, datasetSummary, paletteFromProject } from "../model/design";
import { SUPPORTED_MAP_MODES, type Candidate, type FontStyle, type HeaderElement, type InsetElement, type LegendElement, type MainMapElement, type MapStyle, type Project, type ResultsPanelElement, type SelectorElement, type ShapeElement, type StudioElement, type TextElement } from "../model/types";
import { candidateTotals } from "../model/derive";

type Change = (fn: (project: Project) => void) => void;
type ElementChange<T extends StudioElement> = (fn: (element: T) => void) => void;

/** Typed writer for one element, so every control touches only the field it claims. */
function elementWriter<T extends StudioElement>(elementId: string, onChange: Change): ElementChange<T> {
  return fn => onChange(project => { const target = project.elements.find(candidate => candidate.id === elementId) as T | undefined; if (target) fn(target); });
}

export function Inspector({ project, element, onChange }: { project: Project; element?: StudioElement; onChange: Change }) {
  if (!element) return <DocumentInspector project={project} onChange={onChange}/>;
  return <div className="properties">
    <div className="selection-title"><span>{element.type}</span><input value={element.name} onChange={event => onChange(project => { const target = project.elements.find(candidate => candidate.id === element.id); if (target) target.name = event.target.value; })}/></div>
    <ElementInspector project={project} element={element} onChange={onChange}/>
    {element.type === "header" && <HeaderControls project={project} element={element} onChange={onChange}/>}
    {element.type === "map" && <MapControls project={project} element={element} onChange={onChange}/>}
    {element.type === "results" && <ResultsControls project={project} element={element} onChange={onChange}/>}
    {element.type === "inset" && <InsetControls project={project} element={element} onChange={onChange}/>}
    {element.type === "text" && <TextControls project={project} element={element} onChange={onChange}/>}
    {element.type === "legend" && <LegendControls project={project} element={element} onChange={onChange}/>}
    {element.type === "shape" && <ShapeControls project={project} element={element} onChange={onChange}/>}
    {element.type === "selector" && <SelectorControls project={project} element={element} onChange={onChange}/>}
    {element.type !== "selector" && <CandidatePalette project={project} onChange={onChange}/>}
  </div>;
}

/* ------------------------------------------------------------- document (no selection) */

function DocumentInspector({ project, onChange }: { project: Project; onChange: Change }) {
  const summary = datasetSummary(project);
  const comparison = datasetSummary(project.comparison);
  const set = <K extends keyof Project["page"]>(key: K, value: Project["page"][K]) => onChange(draft => { draft.page[key] = value; });
  const setTheme = (fn: (theme: Project["theme"]) => void) => onChange(draft => fn(draft.theme));
  return <div className="properties">
    <div className="selection-title"><span>document</span><input value={project.name} onChange={event => onChange(draft => { draft.name = event.target.value; })}/></div>
    <Section title="Page">
      <div className="field-grid two"><NumberField label="Width" value={project.page.width} onChange={value => set("width", Math.max(1, value))}/><NumberField label="Height" value={project.page.height} onChange={value => set("height", Math.max(1, value))}/></div>
      <div className="field-grid two"><NumberField label="DPI" value={project.page.dpi} min={36} onChange={value => set("dpi", Math.max(36, value))}/><NumberField label="Safe margin" value={project.page.safeMargin} onChange={value => set("safeMargin", Math.max(0, value))}/></div>
      <ColorField label="Page background" value={project.page.background} onChange={value => set("background", value)}/>
      <p className="hint">Width and height fix the exported pixel canvas. DPI controls physical sizing in PDF, not PNG pixel count. Safe margin frames layout presets; declared units and bleed are documentary only.</p>
      <Toggle label="Snap to grid" value={project.page.grid.snap} onChange={value => onChange(draft => { draft.page.grid.snap = value; })}/>
      <NumberField label="Grid size" value={project.page.grid.size} min={1} onChange={value => onChange(draft => { draft.page.grid.size = Math.max(1, value); })}/>
    </Section>
    <Section title="Theme fonts · layout defaults">
      <TextField label="Serif" value={project.theme.fonts.serif} onChange={value => setTheme(theme => { theme.fonts.serif = value; })}/>
      <TextField label="Sans" value={project.theme.fonts.sans} onChange={value => setTheme(theme => { theme.fonts.sans = value; })}/>
      <TextField label="Data" value={project.theme.fonts.data} onChange={value => setTheme(theme => { theme.fonts.data = value; })}/>
    </Section>
    <Section title="Theme colors · layout defaults">
      {(["page", "ink", "muted", "panel", "header", "border", "noData", "unopposed"] as const).map(key =>
        <ColorField key={key} label={key} value={project.theme.colors[key]} onChange={value => setTheme(theme => { theme.colors[key] = value; })}/>)}
      <ColorField label="Rule color" value={project.theme.border.color} onChange={value => setTheme(theme => { theme.border.color = value; })}/>
      <NumberField label="Rule width" value={project.theme.border.width} step={0.5} min={0} onChange={value => setTheme(theme => { theme.border.width = value; })}/>
      <p className="hint">Choose a layout again to apply these defaults. Edit an element’s typography or colors to change it without resetting your arrangement.</p>
    </Section>
    <Section title="Election data">
      {summary ? <dl className="data-summary">
        <div><dt>Election</dt><dd>{summary.label}</dd></div>
        <div><dt>Jurisdiction</dt><dd>{summary.jurisdiction} · {summary.electionDate}</dd></div>
        <div><dt>Match</dt><dd>{summary.matchStatus ?? "local project"}</dd></div>
        <div><dt>Geometry</dt><dd>{summary.geometryVintage ?? summary.bounds?.map(value => value.toFixed(3)).join(", ") ?? "n/a"}</dd></div>
        <div><dt>Coverage</dt><dd>{summary.withVotes}/{summary.records} records with votes · {summary.drawableFeatures} drawable features</dd></div>
        <div><dt>Unmapped</dt><dd>{summary.unmappedRecords} records · {summary.unmappedVotes.toLocaleString()} votes without geometry</dd></div>
        <div><dt>County outlines</dt><dd>{project.renderData.countyBoundaries?.features.length ?? "none in source"}</dd></div>
      </dl> : <p className="hint">No election data loaded.</p>}
      {comparison && <p className="hint">Comparison: {comparison.label} · {comparison.withVotes}/{comparison.records} records with votes · {comparison.unmappedVotes.toLocaleString()} votes without geometry</p>}
      <div className="hint">Source hashes stay attached to the loaded project and are never rewritten by styling.</div>
    </Section>
    <Section title="Export">
      <Toggle label="Embed metadata" value={project.export.embedMetadata} onChange={value => onChange(draft => { draft.export.embedMetadata = value; })}/>
    </Section>
  </div>;
}

/* ------------------------------------------------------------------- elements */

function ElementInspector({ project, element, onChange }: { project: Project; element: StudioElement; onChange: Change }) {
  const edit = elementWriter<StudioElement>(element.id, onChange);
  const box = contentBox(project.page);
  const align = (mode: "left" | "center" | "right" | "top" | "middle" | "bottom") => edit(target => {
    const frame = target.frame;
    if (mode === "left") frame.x = box.x;
    if (mode === "center") frame.x = box.x + (box.width - frame.width) / 2;
    if (mode === "right") frame.x = box.x + box.width - frame.width;
    if (mode === "top") frame.y = box.y;
    if (mode === "middle") frame.y = box.y + (box.height - frame.height) / 2;
    if (mode === "bottom") frame.y = box.y + box.height - frame.height;
  });
  return <>
    <Section title="Position & size">
      <div className="field-grid four">{(['x', 'y', 'width', 'height'] as const).map(key => <NumberField key={key} label={key.toUpperCase()} value={element.frame[key]} onChange={value => edit(target => { target.frame[key] = value; })}/>)}</div>
      <div className="field-grid two"><NumberField label="Opacity" value={element.opacity} step={.05} min={0} max={1} onChange={value => edit(target => { target.opacity = value; })}/><NumberField label="Layer" value={element.zIndex} onChange={value => edit(target => { target.zIndex = value; })}/></div>
      <div className="align-row">
        <button title="Align left" onClick={() => align("left")}>⇤</button><button title="Align horizontal centre" onClick={() => align("center")}>⇹</button>
        <button title="Align right" onClick={() => align("right")}>⇥</button><button title="Align top" onClick={() => align("top")}>⇡</button>
        <button title="Align vertical middle" onClick={() => align("middle")}>⇳</button><button title="Align bottom" onClick={() => align("bottom")}>⇣</button>
      </div>
      <div className="field-grid two"><Toggle label="Visible" value={element.visible} onChange={value => edit(target => { target.visible = value; })}/><Toggle label="Locked" value={element.locked} onChange={value => edit(target => { target.locked = value; })}/></div>
      <SelectField label="Dataset" value={element.dataset ?? "primary"} options={["primary", "comparison"]} onChange={value => edit(target => { target.dataset = value as "primary" | "comparison"; })}/>
    </Section>
    <Section title="Box">
      <ColorField label="Background" value={element.background ?? "#FFFFFF"} onChange={value => edit(target => { target.background = value; })}/>
      <ColorField label="Border" value={element.border?.color ?? project.theme.colors.border} onChange={value => edit(target => { target.border = { color: value, width: target.border?.width ?? 1, radius: target.border?.radius ?? 0 }; })}/>
      <div className="field-grid two"><NumberField label="Border width" value={element.border?.width ?? 1} step={.5} min={0} onChange={value => edit(target => { target.border = { color: target.border?.color ?? project.theme.colors.border, width: value, radius: target.border?.radius ?? 0 }; })}/><NumberField label="Radius" value={element.border?.radius ?? 0} min={0} onChange={value => edit(target => { target.border = { color: target.border?.color ?? project.theme.colors.border, width: target.border?.width ?? 1, radius: value }; })}/></div>
    </Section>
  </>;
}

function HeaderControls({ project, element, onChange }: { project: Project; element: HeaderElement; onChange: Change }) {
  const edit = elementWriter<HeaderElement>(element.id, onChange);
  return <>
    <Section title="Content">
      <TextField label="Title" value={element.title} onChange={value => edit(target => { target.title = value; })}/>
      <TextField label="Subtitle" value={element.subtitle} onChange={value => edit(target => { target.subtitle = value; })}/>
      <TextField label="Kicker" value={element.kicker} onChange={value => edit(target => { target.kicker = value; })}/>
      <TextField label="Identifier" value={element.identifier} onChange={value => edit(target => { target.identifier = value; })}/>
      <p className="hint">Tokens re-bind when the design moves to another election: {"{{metadata.title}}"}, {"{{metadata.jurisdiction}}"}, {"{{year}}"} …</p>
    </Section>
    <FontEditor title="Title typography" style={element.titleStyle} onChange={value => edit(target => { target.titleStyle = value; })}/>
    <FontEditor title="Subtitle typography" style={element.subtitleStyle} onChange={value => edit(target => { target.subtitleStyle = value; })}/>
    <FontEditor title="Kicker typography" style={element.kickerStyle} onChange={value => edit(target => { target.kickerStyle = value; })}/>
    <FontEditor title="Identifier typography" style={element.identifierStyle} onChange={value => edit(target => { target.identifierStyle = value; })}/>
    <Section title="Header">
      <ColorField label="Background" value={element.background || project.theme.colors.header} onChange={value => edit(target => { target.background = value; })}/>
      <NumberField label="Padding" value={element.padding} onChange={value => edit(target => { target.padding = value; })}/>
    </Section>
  </>;
}

function MapControls({ project, element, onChange }: { project: Project; element: MainMapElement; onChange: Change }) {
  const edit = elementWriter<MainMapElement>(element.id, onChange);
  const style = element.style;
  const setStyle = <K extends keyof MapStyle>(key: K, value: MapStyle[K]) => edit(target => { target.style[key] = value; });
  const source = datasetProject(project, element.dataset) ?? project;
  const bounds = dataBounds(source);
  const extent = element.extent;
  const setExtent = (index: number, value: number) => edit(target => {
    const next = [...(target.extent ?? bounds ?? [0, 0, 1, 1])] as [number, number, number, number];
    next[index] = value;
    target.extent = next;
  });
  return <>
    <Section title="Framing">
      <div className="hint">Geographic window in dataset coordinates (lon/lat for library elections). Empty means “fit the whole election”.</div>
      {extent ? <div className="field-grid four">{[0, 1, 2, 3].map(index => <NumberField key={index} label={["X min", "Y min", "X max", "Y max"][index]} value={extent[index]} step={.01} onChange={value => setExtent(index, value)}/>)}</div>
        : <p className="hint">{bounds ? `Auto-fit · data bounds ${bounds.map(value => value.toFixed(3)).join(", ")}` : "Auto-fit · no data bounds"}</p>}
      <div className="button-row">
        <button disabled={!bounds} onClick={() => edit(target => { target.extent = bounds ?? undefined; })}>Frame data bounds</button>
        <button disabled={!extent} onClick={() => edit(target => { delete target.extent; })}>Auto-fit</button>
      </div>
      <div className="field-grid three"><NumberField label="Zoom" value={element.zoom} step={.05} min={.05} onChange={value => edit(target => { target.zoom = Math.max(.05, value); })}/><NumberField label="Pan X" value={element.pan[0]} onChange={value => edit(target => { target.pan = [value, target.pan[1]]; })}/><NumberField label="Pan Y" value={element.pan[1]} onChange={value => edit(target => { target.pan = [target.pan[0], value]; })}/></div>
      <div className="button-row"><button onClick={() => edit(target => { target.zoom = 1; target.pan = [0, 0]; })}>Reset zoom & pan</button></div>
      <SelectField label="Projection" value={element.projection.type} options={["identity", "albers", "mercator"]} onChange={value => edit(target => { target.projection = { ...target.projection, type: value as MainMapElement["projection"]["type"] }; })}/>
      <SelectField label="Purpose" value={element.purpose ?? "choropleth"} options={["choropleth", "locator"]} onChange={value => edit(target => { target.purpose = value as "choropleth" | "locator"; })}/>
      <Toggle label="Clip to frame" value={style.clip} onChange={value => setStyle("clip", value)}/>
    </Section>
    <Section title="Encoding">
      <SelectField label="Color mode" value={style.mode} options={[...SUPPORTED_MAP_MODES]} onChange={value => setStyle("mode", value as MapStyle["mode"])}/>
      <Toggle label="Continuous scale" value={style.continuous} onChange={value => setStyle("continuous", value)}/>
      {style.thresholds.length >= 1 && <p className="hint">Explicit thresholds are set, so shading uses those bins and the continuous scale is bypassed until they are cleared.</p>}
      <div className="field-grid two"><NumberField label="Buckets" value={style.buckets} min={2} max={30} onChange={value => setStyle("buckets", Math.round(value))}/><NumberField label="Domain max" value={style.domain[1]} step={.05} min={.01} onChange={value => setStyle("domain", [style.domain[0], value])}/></div>
      <Toggle label="Reverse scale" value={style.reverse} onChange={value => setStyle("reverse", value)}/>
      <div className="field-grid two"><NumberField label="Minimum shade" value={style.minStrength} min={0} max={1} step={.05} onChange={value => setStyle("minStrength", value)}/><NumberField label="Maximum shade" value={style.maxStrength} min={0} max={1} step={.05} onChange={value => setStyle("maxStrength", value)}/></div>
    </Section>
    <Section title="Margin thresholds">
      <p className="hint">Blank uses {style.buckets} even buckets. Any ascending values replace them and drive the binned legend ticks.</p>
      <NumberListField values={style.thresholds} onChange={values => setStyle("thresholds", values)}/>
      <div className="button-row"><button onClick={() => setStyle("thresholds", Array.from({ length: Math.max(1, Math.round(style.buckets) - 1) }, (_unused, index) => Math.round(style.domain[1] * (index + 1) / Math.max(2, Math.round(style.buckets)) * 1000) / 1000))}>Even buckets</button><button onClick={() => setStyle("thresholds", [])}>Clear</button></div>
    </Section>
    <Section title="Boundaries">
      <ColorField label="Precinct line" value={style.precinctStroke} onChange={value => setStyle("precinctStroke", value)}/>
      <div className="field-grid two"><NumberField label="Width" value={style.precinctStrokeWidth} step={.1} min={0} onChange={value => setStyle("precinctStrokeWidth", value)}/><NumberField label="Opacity" value={style.precinctStrokeOpacity} step={.05} min={0} max={1} onChange={value => setStyle("precinctStrokeOpacity", value)}/></div>
      <ColorField label="County line" value={style.countyStroke} onChange={value => setStyle("countyStroke", value)}/>
      <div className="field-grid two"><NumberField label="Width" value={style.countyStrokeWidth} step={.1} min={0} onChange={value => setStyle("countyStrokeWidth", value)}/><NumberField label="Opacity" value={style.countyStrokeOpacity} step={.05} min={0} max={1} onChange={value => setStyle("countyStrokeOpacity", value)}/></div>
      <p className="hint">{source.renderData.countyBoundaries ? "County outlines come from the matched source." : "This election’s source has no county field, so no county overlay is drawn."}</p>
      <ColorField label="Frame / exterior" value={style.exteriorStroke} onChange={value => setStyle("exteriorStroke", value)}/>
      <NumberField label="Exterior width" value={style.exteriorStrokeWidth} step={.1} min={0} onChange={value => setStyle("exteriorStrokeWidth", value)}/>
      <div className="field-grid two"><ColorField label="No votes" value={style.noDataColor} onChange={value => setStyle("noDataColor", value)}/><ColorField label="Unopposed" value={style.unopposedColor} onChange={value => setStyle("unopposedColor", value)}/></div>
      <ColorField label="Map background" value={style.background === "transparent" ? source.theme.colors.page : style.background} onChange={value => setStyle("background", value)}/>
    </Section>
  </>;
}

function ResultsControls({ project, element, onChange }: { project: Project; element: ResultsPanelElement; onChange: Change }) {
  const edit = elementWriter<ResultsPanelElement>(element.id, onChange);
  const columns = element.columns ?? [];
  const ramp = element.ramp ?? { visible: false, segments: 10, min: 0, max: 0.6, width: 180, height: 8, ticks: [] };
  const nameStyle = element.candidateNameStyle ?? { family: project.theme.fonts.serif, size: 14, weight: 700, color: project.theme.colors.ink };
  const numberStyle = element.dataStyle ?? { family: project.theme.fonts.data, size: 13, color: project.theme.colors.ink };
  const editColumn = (id: string, fn: (column: ResultsPanelElement["columns"][number]) => void) => edit(target => { const column = (target.columns ?? []).find(item => item.id === id); if (column) fn(column); });
  return <>
    <Section title="Panel content">
      <TextField label="Office" value={element.officeTitle} onChange={value => edit(target => { target.officeTitle = value; })}/>
      <TextField label="Election label" value={element.electionLabel} onChange={value => edit(target => { target.electionLabel = value; })}/>
      <div className="field-grid two"><NumberField label="Row height" value={element.rowHeight} min={8} onChange={value => edit(target => { target.rowHeight = Math.max(8, value); })}/><NumberField label="Header height" value={element.headerHeight} min={16} onChange={value => edit(target => { target.headerHeight = Math.max(16, value); })}/></div>
      <div className="field-grid two"><NumberField label="Vote decimals" value={element.voteDecimals} min={0} max={4} onChange={value => edit(target => { target.voteDecimals = value; })}/><NumberField label="Percent decimals" value={element.percentDecimals} min={0} max={4} onChange={value => edit(target => { target.percentDecimals = value; })}/></div>
      <div className="field-grid two"><Toggle label="Alternating rows" value={element.alternating} onChange={value => edit(target => { target.alternating = value; })}/><Toggle label="Show total" value={element.showTotal} onChange={value => edit(target => { target.showTotal = value; })}/></div>
    </Section>
    <Section title="Columns">
      {columns.map(column => <div key={column.id} className="column-row">
        <span className="column-id">{column.id}</span>
        <input value={column.label} onChange={event => editColumn(column.id, item => { item.label = event.target.value; })}/>
        <input type="number" value={column.width} step={.02} min={.01} onChange={event => editColumn(column.id, item => { item.width = Number(event.target.value); })}/>
        <select value={column.align} onChange={event => editColumn(column.id, item => { item.align = event.target.value as typeof item.align; })}><option>left</option><option>center</option><option>right</option></select>
        <button onClick={() => editColumn(column.id, item => { item.visible = !item.visible; })}>{column.visible === false ? "○" : "◉"}</button>
      </div>)}
      <p className="hint">Widths are relative shares of the panel; hidden columns are not drawn.</p>
    </Section>
    <FontEditor title="Candidate names" style={nameStyle} onChange={value => edit(target => { target.candidateNameStyle = value; })}/>
    <FontEditor title="Numbers" style={numberStyle} onChange={value => edit(target => { target.dataStyle = value; })}/>
    <Section title="Candidate margin ramps">
      <Toggle label="Show ramps" value={ramp.visible} onChange={value => edit(target => { target.ramp = { ...target.ramp, visible: value }; })}/>
      <div className="field-grid three"><NumberField label="Segments" value={ramp.segments} min={2} max={40} onChange={value => edit(target => { target.ramp = { ...target.ramp, segments: Math.round(value) }; })}/><NumberField label="Width" value={ramp.width} onChange={value => edit(target => { target.ramp = { ...target.ramp, width: value }; })}/><NumberField label="Height" value={ramp.height} onChange={value => edit(target => { target.ramp = { ...target.ramp, height: value }; })}/></div>
      <div className="field-grid two"><NumberField label="Share min" value={ramp.min} step={.05} min={0} max={1} onChange={value => edit(target => { target.ramp = { ...target.ramp, min: value }; })}/><NumberField label="Share max" value={ramp.max} step={.05} min={0} max={1} onChange={value => edit(target => { target.ramp = { ...target.ramp, max: value }; })}/></div>
      <div className="hint">Ticks (fractions, e.g. 0.25 0.5)</div>
      <NumberListField values={ramp.ticks} onChange={values => edit(target => { target.ramp = { ...ramp, ticks: values }; })}/>
    </Section>
  </>;
}

function InsetControls({ project, element, onChange }: { project: Project; element: InsetElement; onChange: Change }) {
  const edit = elementWriter<InsetElement>(element.id, onChange);
  const source = datasetProject(project, element.dataset) ?? project;
  const bounds = dataBounds(source);
  const extent = element.geographicExtent;
  const setMapStyle = <K extends keyof MapStyle>(key: K, value: MapStyle[K]) => edit(target => { target.mapStyle = { ...target.mapStyle, [key]: value }; });
  const style = element.mapStyle ?? {};
  const setCenter = (axis: 0 | 1, value: number) => edit(target => {
    const window = target.geographicExtent ?? bounds;
    if (!window) return;
    const next = [...window] as [number, number, number, number];
    const delta = value - (window[axis] + window[axis + 2]) / 2;
    next[axis] += delta;
    next[axis + 2] += delta;
    target.geographicExtent = next;
    target.center = [(next[0] + next[2]) / 2, (next[1] + next[3]) / 2];
  });
  return <>
    <Section title="Inset">
      <TextField label="Label" value={element.label} onChange={value => edit(target => { target.label = value; })}/>
      <SelectField label="Scale mode" value={element.scaleMode} options={["independent", "identical"]} onChange={value => edit(target => { target.scaleMode = value as InsetElement["scaleMode"]; })}/>
      <TextField label="Scale group" value={element.scaleGroup ?? ""} onChange={value => edit(target => { target.scaleGroup = value || undefined; })}/>
      <div className="field-grid two"><NumberField label="Center X" value={element.center[0]} step={.01} onChange={value => setCenter(0, value)}/><NumberField label="Center Y" value={element.center[1]} step={.01} onChange={value => setCenter(1, value)}/></div>
      {extent ? <div className="field-grid four">{[0, 1, 2, 3].map(index => <NumberField key={index} label={["X min", "Y min", "X max", "Y max"][index]} value={extent[index]} step={.01}
        onChange={value => edit(target => { const next = [...(target.geographicExtent ?? bounds ?? [0, 0, 1, 1])] as [number, number, number, number]; next[index] = value; target.geographicExtent = next; target.center = [(next[0] + next[2]) / 2, (next[1] + next[3]) / 2]; })}/>)}</div>
        : <p className="hint">Inset has no window yet: it is drawn at the main-map framing.</p>}
      <div className="button-row">
        <button disabled={!bounds} onClick={() => edit(target => { if (bounds) { target.geographicExtent = bounds; target.center = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2]; } })}>Frame data bounds</button>
        <button disabled={!extent} onClick={() => edit(target => { delete target.geographicExtent; })}>Clear window</button>
      </div>
      {extent && <div className="button-row"><button onClick={() => edit(target => { const [x0, y0, x1, y1] = target.geographicExtent ?? [0, 0, 1, 1]; const dx = (x1 - x0) * .1, dy = (y1 - y0) * .1; target.geographicExtent = [x0 + dx, y0 + dy, x1 - dx, y1 - dy]; })}>Tighten 10%</button><button onClick={() => edit(target => { const [x0, y0, x1, y1] = target.geographicExtent ?? [0, 0, 1, 1]; const dx = (x1 - x0) * .1, dy = (y1 - y0) * .1; target.geographicExtent = [x0 - dx, y0 - dy, x1 + dx, y1 + dy]; })}>Widen 10%</button></div>}
      <ColorField label="Label background" value={element.labelBackground} onChange={value => edit(target => { target.labelBackground = value; })}/>
      <NumberField label="Label padding" value={element.labelPadding} min={0} onChange={value => edit(target => { target.labelPadding = value; })}/>
    </Section>
    <FontEditor title="Inset label" style={element.labelStyle} onChange={value => edit(target => { target.labelStyle = value; })}/>
    <Section title="Inset map style">
      <SelectField label="Color mode" value={style.mode ?? "inherit"} options={["inherit", ...SUPPORTED_MAP_MODES]} onChange={value => edit(target => {
        const next = { ...target.mapStyle };
        if (value === "inherit") delete next.mode; else next.mode = value as MapStyle["mode"];
        target.mapStyle = next;
      })}/>
      <div className="field-grid two"><NumberField label="Min shade" value={style.minStrength ?? 0.45} step={.05} min={0} max={1} onChange={value => setMapStyle("minStrength", value)}/><NumberField label="Max shade" value={style.maxStrength ?? 1} step={.05} min={0} max={1} onChange={value => setMapStyle("maxStrength", value)}/></div>
      <NumberField label="Precinct width" value={style.precinctStrokeWidth ?? 0.55} step={.1} min={0} onChange={value => setMapStyle("precinctStrokeWidth", value)}/>
      <NumberField label="Exterior width" value={style.exteriorStrokeWidth ?? 2.5} step={.1} min={0} onChange={value => setMapStyle("exteriorStrokeWidth", value)}/>
      {style.noDataColor && <ColorField label="No votes" value={style.noDataColor} onChange={value => setMapStyle("noDataColor", value)}/>}
      <div className="button-row"><button onClick={() => edit(target => { delete target.mapStyle; })}>Inherit main map style</button></div>
    </Section>
  </>;
}

function TextControls({ project, element, onChange }: { project: Project; element: TextElement; onChange: Change }) {
  const edit = elementWriter<TextElement>(element.id, onChange);
  return <>
    <Section title="Text">
      <label className="field"><span>Content</span><textarea value={element.text} onChange={event => edit(target => { target.text = event.target.value; })}/></label>
      <Toggle label="Wrap to frame" value={element.wrap} onChange={value => edit(target => { target.wrap = value; })}/>
      <p className="hint">Alignment uses the element frame; tokens such as {"{{metadata.source}}"} re-bind per election.</p>
    </Section>
    <FontEditor title="Typography" style={element.style} onChange={value => edit(target => { target.style = value; })}/>
  </>;
}

function LegendControls({ project, element, onChange }: { project: Project; element: LegendElement; onChange: Change }) {
  const edit = elementWriter<LegendElement>(element.id, onChange);
  const items = element.items ?? [];
  return <>
    <Section title="Legend">
      <SelectField label="Type" value={element.legendType} options={["winner-margin", "continuous", "binned", "categorical", "manual"]} onChange={value => edit(target => { target.legendType = value as LegendElement["legendType"]; })}/>
      <TextField label="Title" value={element.title} onChange={value => edit(target => { target.title = value; })}/>
      <TextField label="Subtitle" value={element.subtitle ?? ""} onChange={value => edit(target => { target.subtitle = value; })}/>
      <SelectField label="Orientation" value={element.orientation} options={["horizontal", "vertical"]} onChange={value => edit(target => { target.orientation = value as LegendElement["orientation"]; })}/>
      <NumberField label="Columns" value={element.columns} min={1} max={8} onChange={value => edit(target => { target.columns = Math.max(1, Math.round(value)); })}/>
      <p className="hint">Ramps inherit the {element.dataset ?? "primary"} map’s mode, thresholds and domain, so the legend always matches the drawn shades.</p>
    </Section>
    {element.legendType === "manual" && <Section title="Manual entries">
      {items.map((item, index) => <div key={`${item.label}-${index}`} className="item-row">
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(item.color) ? item.color : "#000000"} onChange={event => edit(target => { const entry = (target.items ?? [])[index]; if (entry) entry.color = event.target.value; })}/>
        <input value={item.label} onChange={event => edit(target => { const entry = (target.items ?? [])[index]; if (entry) entry.label = event.target.value; })}/>
        <button onClick={() => edit(target => { target.items = (target.items ?? []).filter((_unused, position) => position !== index); })}>×</button>
      </div>)}
      <div className="button-row"><button onClick={() => edit(target => { target.items = [...(target.items ?? []), { label: "Entry", color: project.theme.colors.ink }]; })}>Add entry</button></div>
    </Section>}
    <FontEditor title="Legend type" style={element.style} onChange={value => edit(target => { target.style = value; })}/>
  </>;
}

function ShapeControls({ project, element, onChange }: { project: Project; element: ShapeElement; onChange: Change }) {
  const edit = elementWriter<ShapeElement>(element.id, onChange);
  return <Section title="Shape">
    <SelectField label="Kind" value={element.shape} options={["rect", "ellipse", "line", "arrow"]} onChange={value => edit(target => { target.shape = value as ShapeElement["shape"]; })}/>
    <ColorField label="Fill" value={element.fill} onChange={value => edit(target => { target.fill = value; })}/>
    <ColorField label="Stroke" value={element.stroke} onChange={value => edit(target => { target.stroke = value; })}/>
    <NumberField label="Stroke width" value={element.strokeWidth} step={.5} min={0} onChange={value => edit(target => { target.strokeWidth = value; })}/>
    <ColorField label="Background" value={element.background ?? project.theme.colors.panel} onChange={value => edit(target => { target.background = value; })}/>
  </Section>;
}

function SelectorControls({ project, element, onChange }: { project: Project; element: SelectorElement; onChange: Change }) {
  const edit = elementWriter<SelectorElement>(element.id, onChange);
  return <>
    <Section title="Dataset key">
      <TextField label="Label" value={element.label} onChange={value => edit(target => { target.label = value; })}/>
      <SelectField label="Orientation" value={element.orientation} options={["horizontal", "vertical"]} onChange={value => edit(target => { target.orientation = value as SelectorElement["orientation"]; })}/>
      <NumberField label="Swatch size" value={element.swatchSize} min={4} onChange={value => edit(target => { target.swatchSize = Math.max(4, value); })}/>
      <SelectField label="Active dataset" value={element.active} options={["primary", "comparison"]} onChange={value => edit(target => { target.active = value as SelectorElement["active"]; })}/>
      <p className="hint">Election names are read from the loaded datasets, so the key never freezes an old election label. {project.comparison ? "" : "Load a second election to fill the comparison row."}</p>
    </Section>
    <FontEditor title="Key typography" style={element.style} onChange={value => edit(target => { target.style = value; })}/>
  </>;
}

function CandidatePalette({ project, onChange }: { project: Project; onChange: Change }) {
  const ordered = [...project.data.candidates].sort((a, b) => a.order - b.order);
  const totals = candidateTotals(project.renderData.records, project.data.candidates);
  const update = (id: string, fn: (candidate: Candidate) => void) => onChange(project => { const candidate = project.data.candidates.find(item => item.id === id); if (candidate) fn(candidate); });
  const move = (id: string, direction: -1 | 1) => onChange(project => {
    const candidates = [...project.data.candidates].sort((a, b) => a.order - b.order);
    const index = candidates.findIndex(candidate => candidate.id === id), neighbour = candidates[index + direction];
    if (!neighbour || !candidates[index]) return;
    const order = candidates[index].order;
    candidates[index].order = neighbour.order;
    neighbour.order = order;
  });
  return <>
    <Section title="Candidates">
      {ordered.map((candidate, index) => <div key={candidate.id} className="candidate-editor">
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(candidate.color) ? candidate.color : "#000000"} onChange={event => update(candidate.id, item => { item.color = event.target.value; })}/>
        <input type="color" title="Light shade" value={candidate.lightColor && /^#[0-9a-f]{6}$/i.test(candidate.lightColor) ? candidate.lightColor : "#E8EDF0"} onChange={event => update(candidate.id, item => { item.lightColor = event.target.value; })}/>
        <input value={candidate.displayName} onChange={event => update(candidate.id, item => { item.displayName = event.target.value; })}/>
        <span className="candidate-votes">{Math.round(totals[candidate.id] ?? 0).toLocaleString()}</span>
        <button title="Move up" disabled={index === 0} onClick={() => move(candidate.id, -1)}>↑</button>
        <button title="Move down" disabled={index === ordered.length - 1} onClick={() => move(candidate.id, 1)}>↓</button>
        <button className={candidate.visible ? "visible" : ""} title="Visible" onClick={() => update(candidate.id, item => { item.visible = !item.visible; })}>{candidate.visible ? "◉" : "○"}</button>
      </div>)}
      <p className="hint">Row order, colors and shade anchors only; votes come from the loaded election and are never written into a design.</p>
      {project.comparison && <div className="button-row"><button onClick={() => onChange(draft => {
        if (!draft.comparison) return;
        const transferred = applyPalette(draft, paletteFromProject(draft.comparison));
        draft.data = transferred.project.data;
      })}>Adopt comparison palette</button></div>}
    </Section>
    {project.comparison && <p className="hint">Comparison election: {project.comparison.name}. Palette transfer matches candidates by stable id first, then by slot.</p>}
  </>;
}

/* ------------------------------------------------------------------- fields */

function Section({ title, children }: { title: string; children: React.ReactNode }) { return <section className="property-section"><h3>{title}</h3>{children}</section>; }
function TextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) { return <label className="field"><span>{label}</span><input value={value} onChange={event => onChange(event.target.value)}/></label>; }
function NumberField({ label, value, onChange, step = 1, min, max }: { label: string; value: number; onChange: (value: number) => void; step?: number; min?: number; max?: number }) { return <label className="field number"><span>{label}</span><input type="number" value={Number.isFinite(value) ? value : 0} step={step} min={min} max={max} onChange={event => onChange(Number(event.target.value))}/></label>; }
function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) { return <label className="field color"><span>{label}</span><span className="color-control"><input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#000000"} onChange={event => onChange(event.target.value)}/><input value={value} onChange={event => onChange(event.target.value)}/></span></label>; }
function SelectField({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) { return <label className="field"><span>{label}</span><select value={value} onChange={event => onChange(event.target.value)}>{options.map(option => <option key={option}>{option}</option>)}</select></label>; }
function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) { return <label className="toggle"><span>{label}</span><input type="checkbox" checked={value} onChange={event => onChange(event.target.checked)}/><i/></label>; }
function NumberListField({ values, onChange }: { values: number[]; onChange: (values: number[]) => void }) {
  return <div className="number-list">
    {values.map((value, index) => <span key={index} className="number-list-item">
      <input type="number" value={value} step={.01} onChange={event => onChange(values.map((item, position) => position === index ? Number(event.target.value) : item))}/>
      <button onClick={() => onChange(values.filter((_unused, position) => position !== index))}>×</button>
    </span>)}
    <button className="add" onClick={() => onChange([...values, Math.round((values[values.length - 1] ?? 0.25) * 1000) / 1000])}>＋</button>
  </div>;
}
function FontEditor({ title, style, onChange }: { title: string; style: FontStyle; onChange: (value: FontStyle) => void }) {
  const set = (key: keyof FontStyle, value: unknown) => onChange({ ...style, [key]: value });
  return <Section title={title}>
    <TextField label="Family" value={style.family || ""} onChange={value => set("family", value)}/>
    <div className="field-grid two"><NumberField label="Size" value={style.size || 12} step={.5} onChange={value => set("size", value)}/><TextField label="Weight" value={String(style.weight || 400)} onChange={value => set("weight", /^\d+$/.test(value) ? Number(value) : value)}/></div>
    <ColorField label="Color" value={style.color || "#182329"} onChange={value => set("color", value)}/>
    <div className="field-grid three">
      <SelectField label="Align" value={style.align ?? "left"} options={["left", "center", "right"]} onChange={value => set("align", value)}/>
      <SelectField label="Case" value={style.transform ?? "none"} options={["none", "uppercase", "lowercase", "capitalize"]} onChange={value => set("transform", value)}/>
      <NumberField label="Spacing" value={style.letterSpacing ?? 0} step={.1} onChange={value => set("letterSpacing", value)}/>
    </div>
    <NumberField label="Line height" value={style.lineHeight ?? 1.25} step={.05} min={.5} onChange={value => set("lineHeight", value)}/>
  </Section>;
}
