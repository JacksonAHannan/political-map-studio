import type { FeatureCollection, Geometry } from "geojson";

export type Frame = { x: number; y: number; width: number; height: number };
export type FontStyle = {
  family?: string; size?: number; weight?: number | string; style?: string;
  color?: string; letterSpacing?: number; lineHeight?: number; align?: "left" | "center" | "right";
  transform?: "none" | "uppercase" | "lowercase" | "capitalize";
};
export type Candidate = {
  id: string; sourceNames: string[]; displayName: string; shortName?: string;
  color: string; lightColor?: string; darkColor?: string; visible: boolean;
  order: number; metadata?: Record<string, string | number | boolean>;
};
export const SUPPORTED_MAP_MODES = ["winner-margin", "winner"] as const;
export type MapMode = typeof SUPPORTED_MAP_MODES[number];
export type DataConfig = {
  resultsPath?: string; geographyPath?: string; resultsFormat: "wide" | "long";
  join: { resultField: string; geographyField: string; countyResultField?: string; countyGeographyField?: string };
  fields: { candidate?: string; votes?: string; totalVotes?: string; winner?: string; margin?: string; county?: string; precinctName?: string };
  writeIns: "include" | "exclude" | "group"; candidates: Candidate[];
};
export type Theme = {
  id: string; name: string;
  colors: { page: string; ink: string; muted: string; panel: string; header: string; border: string; noData: string; unopposed: string };
  fonts: { serif: string; sans: string; data: string; title?: FontStyle; body?: FontStyle; label?: FontStyle; footnote?: FontStyle };
  border: { color: string; width: number; opacity: number };
};
export type MapStyle = {
  mode: MapMode;
  valueField?: string; candidateId?: string; continuous: boolean; buckets: number;
  thresholds: number[]; minStrength: number; maxStrength: number; domain: [number, number]; reverse: boolean;
  noDataColor: string; unopposedColor: string; precinctStroke: string; precinctStrokeWidth: number;
  precinctStrokeOpacity: number; countyStroke: string; countyStrokeWidth: number; countyStrokeOpacity: number;
  exteriorStroke: string; exteriorStrokeWidth: number; background: string; antialias: boolean; clip: boolean;
};

/** Which election dataset an element renders and binds metadata against. */
export type ElementDataset = "primary" | "comparison";
export const LAYOUT_IDS = ["statewide", "results", "insets", "comparison", "detail"] as const;
export type LayoutId = typeof LAYOUT_IDS[number];
export type Layout = { id: LayoutId; name: string; description: string };

export type BaseElement = {
  id: string; name: string; type: string; frame: Frame; visible: boolean; locked: boolean;
  zIndex: number; opacity: number; background?: string; border?: { color: string; width: number; radius: number };
  /** Election dataset this element draws from. Absent means "primary". */
  dataset?: ElementDataset;
};
export type HeaderElement = BaseElement & { type: "header"; title: string; subtitle: string; kicker: string; identifier: string; padding: number; titleStyle: FontStyle; subtitleStyle: FontStyle; kickerStyle: FontStyle; identifierStyle: FontStyle };
/**
 * Main map. `extent` is an explicit geographic window `[x0, y0, x1, y1]` in the
 * dataset CRS (degrees for library elections); absent means auto-fit the whole
 * dataset. `zoom`/`pan` are applied on top of the fitted transform, so adjusting
 * them never moves another jurisdiction's frame onto stale coordinates.
 */
export type MainMapElement = BaseElement & { type: "map"; projection: { type: "identity" | "albers" | "mercator"; rotate?: [number, number, number]; parallels?: [number, number] }; extent?: [number, number, number, number]; zoom: number; pan: [number, number]; style: MapStyle; purpose?: "choropleth" | "locator" };
export type ResultsPanelElement = BaseElement & { type: "results"; officeTitle: string; electionLabel: string; columns: Array<{ id: "candidate" | "votes" | "share" | "status"; label: string; visible: boolean; width: number; align: "left" | "center" | "right" }>; rowHeight: number; headerHeight: number; candidateNameStyle: FontStyle; dataStyle: FontStyle; alternating: boolean; showTotal: boolean; voteDecimals: number; percentDecimals: number; ramp: { visible: boolean; segments: number; min: number; max: number; width: number; height: number; ticks: number[] } };
export type InsetElement = BaseElement & { type: "inset"; label: string; center: [number, number]; geographicExtent?: [number, number, number, number]; scaleGroup?: string; scaleMode: "independent" | "identical"; mapStyle?: Partial<MapStyle>; labelStyle: FontStyle; labelBackground: string; labelPadding: number };
export type TextElement = BaseElement & { type: "text"; text: string; style: FontStyle; wrap: boolean };
export type LegendElement = BaseElement & { type: "legend"; legendType: "categorical" | "continuous" | "binned" | "winner-margin" | "manual"; title: string; subtitle?: string; orientation: "horizontal" | "vertical"; columns: number; items?: Array<{ label: string; color: string }>; style: FontStyle };
export type ShapeElement = BaseElement & { type: "shape"; shape: "line" | "rect" | "ellipse" | "arrow"; fill: string; stroke: string; strokeWidth: number };
/**
 * Explicit dataset key for comparison layouts. Labels are derived from the loaded
 * elections at render time, so a saved design never freezes an election name.
 */
export type SelectorElement = BaseElement & { type: "selector"; label: string; orientation: "horizontal" | "vertical"; swatchSize: number; active: ElementDataset; style: FontStyle };
export type StudioElement = HeaderElement | MainMapElement | ResultsPanelElement | InsetElement | TextElement | LegendElement | ShapeElement | SelectorElement;
export type DerivedRecord = { key: string; county?: string; name?: string; totalVotes: number; winnerId?: string; runnerUpId?: string; margin?: number; turnout?: number; values: Record<string, string | number | null>; candidateVotes: Record<string, number> };
export type Diagnostic = { severity: "error" | "warning" | "info"; code: string; message: string; count?: number; records?: Array<Record<string, unknown>>; fix?: string };

export type RenderFeature = { type: "Feature"; id?: string | number; properties: Record<string, unknown>; geometry: Geometry | null };
export type SourceReconciliation = {
  source: Record<string, number>; mapped: Record<string, number>; unmatched: Record<string, number>;
  preserved: Record<string, number>; coverage: Record<string, number | null>; note?: string;
  sourceLabel?: string; incompleteElection?: boolean;
};
export type RenderData = {
  type: "FeatureCollection"; features: RenderFeature[]; records: DerivedRecord[]; diagnostics: Diagnostic[];
  bounds?: [number, number, number, number]; crs?: string; sourceHashes?: Record<string, string>;
  /** County outlines dissolved from the matched precinct geography; absent when the source has no county field. */
  countyBoundaries?: FeatureCollection;
  /** Audit metadata from the existing upstream precinct matching, never an editor-generated match. */
  library?: {
    matchMethod?: string;
    results?: { path: string; rows: number; joined: number; unmatched: number };
    crosswalk?: { path: string; rows: number; accepted: number; unmatched: number; methods?: Record<string, number>; confidence?: Record<string, number>; relationships?: Record<string, number> };
    reconciliation?: SourceReconciliation;
    provenance?: Array<{ path: string; role: string; sha256: string }>;
  };
};

/** Provenance of the election data currently loaded in a project. */
export type DatasetRef = {
  id: string; label: string; sourcePath: string; matchStatus: string; geometryVintage: string;
  matchAudit?: string; sourceHash: string;
  matchMethod?: string; resultsPath?: string; crosswalkPath?: string;
  provenance?: Array<{ path: string; role: string; sha256: string }>;
};

/**
 * A portable, election-independent page design. It carries layout, styling and
 * metadata *bindings* (`{{metadata.title}}`, `{{dataset.label}}`, …) only: never
 * election records, geometry, source text or candidate names. Applying it to an
 * election re-binds every token, so the same file works for any race.
 */
export type Design = {
  kind: "design"; schemaVersion: 1; id: string; name: string; createdAt: string;
  page: Project["page"]; theme: Theme; elements: StudioElement[];
  layoutId?: LayoutId; themeId?: string;
  /** Colors by explicit display-order slot, never candidate names or votes. */
  candidateStyles?: Partial<Record<ElementDataset, Array<{ slot: number; color: string; lightColor?: string; darkColor?: string }>>>;
};

export type Project = {
  schemaVersion: 1; id: string; name: string; modifiedAt: string;
  metadata: { title: string; subtitle: string; office: string; electionDate: string; electionType: string; jurisdiction: string; source: string; notes: string[] };
  page: { width: number; height: number; unit: "px" | "in" | "mm"; dpi: number; background: string; bleed: number; safeMargin: number; grid: { enabled: boolean; size: number; snap: boolean } };
  data: DataConfig; theme: Theme; layoutId?: string; themeId?: string;
  elements: StudioElement[]; renderData: RenderData; export: { formats: Array<"svg" | "png" | "pdf">; textAsPaths: boolean; embedMetadata: boolean };
  /** Provenance of the loaded election, when it came from the matched library. */
  dataset?: DatasetRef;
  /** Second election rendered by `dataset: "comparison"` elements. */
  comparison?: Project;
  /** Design currently applied, kept so it can be re-saved or re-applied. */
  design?: Design;
};
