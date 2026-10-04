/**
 * Election-independent page designs.
 *
 * A `Design` carries layout, styling and *metadata bindings* only. Every human
 * readable string is stored as a token (`{{metadata.title}}`, `{{dataset.label}}`,
 * `{{year}}`, …) so the same saved design can be applied to any election without
 * freezing the previous election's labels. Applying a design never copies vote
 * records, geometry, source text or candidate names — it re-binds tokens against
 * the project it lands on.
 */
import type { Geometry, GeoJsonObject, Position } from "geojson";
import {
  LAYOUT_IDS, type Design, type ElementDataset, type Frame, type HeaderElement, type InsetElement,
  type Layout, type LayoutId, type LegendElement, type MainMapElement, type MapStyle, type Project, type RenderData,
  type RenderFeature, type ResultsPanelElement, type SelectorElement, type StudioElement, type TextElement, type Theme,
} from "./types";
import { validateDesign } from "./schema";

export type Bounds = [number, number, number, number];
export type Notice = { code: string; message: string; level: "info" | "warning"; elementId?: string };
export type Report = { project: Project; notices: Notice[] };

export const BINDING_TOKENS = [
  "{{metadata.title}}", "{{metadata.subtitle}}", "{{metadata.office}}", "{{metadata.source}}",
  "{{metadata.jurisdiction}}", "{{metadata.electionType}}", "{{metadata.electionDate}}", "{{metadata.notes}}",
  "{{year}}", "{{dataset.label}}", "{{dataset.jurisdiction}}",
] as const;

export const LAYOUTS: Layout[] = [
  { id: "statewide", name: "Statewide", description: "Full-width precinct map with the results panel floating over the map and a horizontal margin legend." },
  { id: "results", name: "Results spread", description: "Large title over a district map, compact results table at right, horizontal margin legend and source footer." },
  { id: "insets", name: "Insets", description: "Main map, results and named-place insets. Comparable windows share one scale; differently shaped windows fit independently." },
  { id: "comparison", name: "Comparison", description: "Two elections side by side with independent titles, maps, results and a dataset key." },
  { id: "detail", name: "Detail", description: "Zoomed detail map with an editable geographic window, a locator overview and a compact results panel." },
];

/* ------------------------------------------------------------------ tokens */

type TokenPair = { token: string; value: string; tokenizable: boolean };

function tokenValues(project: Project): TokenPair[] {
  const m = project.metadata;
  const jurisdiction = m.jurisdiction || project.dataset?.label || "";
  return [
    { token: "{{metadata.title}}", value: m.title, tokenizable: true },
    { token: "{{metadata.subtitle}}", value: m.subtitle, tokenizable: true },
    { token: "{{metadata.office}}", value: m.office, tokenizable: true },
    { token: "{{metadata.source}}", value: m.source, tokenizable: true },
    { token: "{{metadata.jurisdiction}}", value: jurisdiction, tokenizable: true },
    { token: "{{metadata.electionType}}", value: m.electionType, tokenizable: true },
    { token: "{{metadata.electionDate}}", value: m.electionDate, tokenizable: true },
    { token: "{{metadata.notes}}", value: m.notes.join(" · "), tokenizable: false },
    { token: "{{year}}", value: m.electionDate.slice(0, 4), tokenizable: false },
    { token: "{{dataset.label}}", value: project.dataset?.label || project.name, tokenizable: true },
    { token: "{{dataset.jurisdiction}}", value: jurisdiction, tokenizable: true },
  ];
}

/** Replace binding tokens with the values of `project`. Unknown tokens are left alone. */
export function bindText(value: string, project: Project): string {
  let out = value;
  for (const { token, value: replacement } of tokenValues(project)) out = out.replaceAll(token, replacement);
  return out;
}

/** Reverse of {@link bindText}: replace concrete metadata values with their tokens. */
function tokenizeText(value: string, projects: Project[]): string {
  const pairs = projects.flatMap(project => tokenValues(project)).filter(pair => pair.tokenizable && pair.value.length >= 4);
  pairs.sort((a, b) => b.value.length - a.value.length);
  let out = value;
  for (const { token, value: needle } of pairs) out = out.replaceAll(needle, token);
  return out;
}

const BOUND_FIELDS: Record<string, readonly string[]> = {
  header: ["title", "subtitle", "kicker", "identifier"],
  text: ["text"],
  results: ["officeTitle", "electionLabel"],
  legend: ["title", "subtitle"],
  selector: ["label"],
  inset: ["label"],
};

function visitText(element: StudioElement, visit: (field: string, value: string) => string) {
  const fields = BOUND_FIELDS[element.type];
  if (!fields) return;
  const record = element as unknown as Record<string, unknown>;
  for (const field of fields) if (typeof record[field] === "string") record[field] = visit(field, record[field] as string);
}

/** The project an element draws from: `dataset: "comparison"` reads `project.comparison`. */
export function datasetProject(project: Project, dataset?: ElementDataset): Project | undefined {
  return dataset === "comparison" ? project.comparison : project;
}

/** Resolve tokens for display (renderer/export use this so literals never leak). */
export function resolveText(value: string, project: Project): string {
  return value.includes("{{") ? bindText(value, project) : value;
}


function tokenizeElement(element: StudioElement, projects: Project[]) {
  visitText(element, (_field, value) => tokenizeText(value, projects));
  if (element.type === "legend" && element.legendType !== "manual") element.items = undefined;
}

/* ---------------------------------------------------------------- geometry */

const EPSILON = 1e-9;

export function normalizeExtent(extent?: readonly number[]): Bounds | undefined {
  if (!extent || extent.length < 4) return undefined;
  const [ax, ay, bx, by] = extent.slice(0, 4).map(Number);
  if (![ax, ay, bx, by].every(Number.isFinite)) return undefined;
  const out: Bounds = [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
  return out[2] - out[0] > EPSILON && out[3] - out[1] > EPSILON ? out : undefined;
}

/** The geographic window an element maps, if it pins one. */
export function elementExtent(element: MainMapElement | InsetElement): Bounds | undefined {
  return normalizeExtent(element.type === "map" ? element.extent : element.geographicExtent);
}

function visitCoordinates(coordinates: unknown, accumulate: (position: Position) => void) {
  if (!Array.isArray(coordinates)) return;
  if (typeof coordinates[0] === "number") {
    const position = coordinates as Position;
    if (Number.isFinite(position[0]) && Number.isFinite(position[1]) && position.length >= 2) accumulate(position);
    return;
  }
  for (const child of coordinates) visitCoordinates(child, accumulate);
}

type GeometryLike = { coordinates?: unknown; geometries?: GeometryLike[] } | null;

/** Matched library geography may be a GeometryCollection, so bounds walk `geometries` too. */
function visitGeometry(geometry: GeometryLike, accumulate: (position: Position) => void) {
  if (!geometry) return;
  visitCoordinates(geometry.coordinates, accumulate);
  for (const child of geometry.geometries ?? []) visitGeometry(child, accumulate);
}

/** Join key of a rendered feature: the matched record key, never a positional index. */
export function featureKey(feature: RenderFeature): string {
  return String(feature.properties.__joinKey ?? feature.id ?? "");
}

/**
 * Bounds of every feature whose geometry carries at least one finite position, the count of
 * those features, their overall extent, and the bounds of each county outline. `null`/empty
 * geometries are absent, so a record key missing here has nothing the map can draw for it.
 * A join key carried by more than one feature holds the union of their bounds, which keeps
 * window culling conservative: a key that draws anywhere is never dropped.
 */
export type FeatureIndex = {
  boundsByKey: Map<string, Bounds>;
  boundaryBounds: Array<Bounds | undefined>;
  drawableFeatures: number;
  scanned: Bounds | undefined;
};

const featureIndexCache = new WeakMap<RenderData, FeatureIndex>();

/**
 * One coordinate scan per immutable dataset. Consumers (window culling, unmapped-record
 * accounting, extent fitting) share it; it is dropped with the `RenderData` it describes,
 * so a new election or geometry edit builds a fresh index rather than a stale one.
 */
export function featureIndex(data: RenderData): FeatureIndex {
  const cached = featureIndexCache.get(data);
  if (cached) return cached;
  const boundsByKey = new Map<string, Bounds>();
  let drawableFeatures = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (bounds: Bounds): void => {
    if (bounds[0] < x0) x0 = bounds[0];
    if (bounds[1] < y0) y0 = bounds[1];
    if (bounds[2] > x1) x1 = bounds[2];
    if (bounds[3] > y1) y1 = bounds[3];
  };
  for (const feature of data.features) {
    const bounds = geometryBounds(feature.geometry);
    if (!bounds) continue;
    drawableFeatures += 1;
    const key = featureKey(feature);
    const existing = boundsByKey.get(key);
    boundsByKey.set(key, existing ? boundsUnion(existing, bounds) : bounds);
    add(bounds);
  }
  const boundaryBounds = (data.countyBoundaries?.features ?? []).map(feature => geometryBounds(feature.geometry));
  for (const bounds of boundaryBounds) if (bounds) add(bounds);
  const index: FeatureIndex = { boundsByKey, boundaryBounds, drawableFeatures, scanned: Number.isFinite(x0) ? [x0, y0, x1, y1] : undefined };
  featureIndexCache.set(data, index);
  return index;
}

/** Bounds of one geometry, or `undefined` when it carries no finite position. */
export function geometryBounds(geometry: Geometry | null): Bounds | undefined {
  if (!geometry) return undefined;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  visitGeometry(geometry as unknown as GeometryLike, position => {
    if (position[0] < x0) x0 = position[0];
    if (position[1] < y0) y0 = position[1];
    if (position[0] > x1) x1 = position[0];
    if (position[1] > y1) y1 = position[1];
  });
  return Number.isFinite(x0) && Number.isFinite(y0) ? [x0, y0, x1, y1] : undefined;
}

const boundsCache = new WeakMap<RenderData, Bounds | undefined>();

/** Extent of the drawable data, from the declared bounds or a single coordinate scan (cached). */
export function dataBounds(project: Project): Bounds | undefined {
  const data = project.renderData;
  if (boundsCache.has(data)) return boundsCache.get(data);
  const bounds = normalizeExtent(data.bounds) ?? featureIndex(data).scanned;
  boundsCache.set(data, bounds);
  return bounds;
}

export function boundsContain(outer: Bounds, inner: Bounds): boolean {
  const slack = Math.max(outer[2] - outer[0], outer[3] - outer[1]) * 1e-6;
  return inner[0] >= outer[0] - slack && inner[1] >= outer[1] - slack && inner[2] <= outer[2] + slack && inner[3] <= outer[3] + slack;
}

export function boundsUnion(a: Bounds, b: Bounds): Bounds {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function boundsArea(bounds: Bounds): number { return Math.max(0, bounds[2] - bounds[0]) * Math.max(0, bounds[3] - bounds[1]); }

export function padBounds(bounds: Bounds, ratio: number, limit?: Bounds): Bounds {
  const [x0, y0, x1, y1] = bounds;
  const dx = (x1 - x0) * ratio, dy = (y1 - y0) * ratio;
  const padded: Bounds = [x0 - dx, y0 - dy, x1 + dx, y1 + dy];
  if (!limit) return padded;
  return [Math.max(padded[0], limit[0]), Math.max(padded[1], limit[1]), Math.min(padded[2], limit[2]), Math.min(padded[3], limit[3])];
}

/**
 * Rectangular polygon for an extent, used to fit a projection (incl. conics) to a window.
 * The ring is wound clockwise in lon/lat order because d3-geo reads the opposite winding as
 * the sphere *minus* the rectangle, which would fit the whole world into the frame.
 */
export function extentGeometry(bounds: Bounds): GeoJsonObject {
  const [x0, y0, x1, y1] = bounds;
  const ring: Position[] = [[x0, y0], [x0, y1], [x1, y1], [x1, y0], [x0, y0]];
  return { type: "Polygon", coordinates: [ring] } as unknown as GeoJsonObject;
}

function normalizeName(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

/** Bounds of the geometry carrying a given precinct/place name (e.g. "HUNTSVILLE"). */
export function labelBounds(project: Project, label: string): Bounds | undefined {
  const wanted = normalizeName(label);
  if (!wanted) return undefined;
  const keys = new Set<string>();
  for (const record of project.renderData.records) {
    const name = record.name ? normalizeName(record.name) : "";
    const county = record.county ? normalizeName(record.county) : "";
    if (name === wanted || county === wanted || name.split(" ")[0] === wanted.split(" ")[0] && wanted.split(" ").length === 1 && name.startsWith(wanted)) keys.add(record.key);
  }
  if (!keys.size) return undefined;
  return featureBounds(project, keys);
}

function featureBounds(project: Project, keys: Set<string>): Bounds | undefined {
  const { boundsByKey } = featureIndex(project.renderData);
  let bounds: Bounds | undefined;
  for (const key of keys) {
    const found = boundsByKey.get(key);
    if (found) bounds = bounds ? boundsUnion(bounds, found) : found;
  }
  return bounds;
}

/**
 * Width-to-height ratio the projected data will occupy. Geographic coordinates are
 * corrected by the mean-latitude cosine, which is what a conformal/conic projection
 * does at map scale; anything else is used as-is.
 */
export function dataAspect(project: Project): number | undefined {
  return aspectOfBounds(project, dataBounds(project));
}

function aspectOfBounds(project: Project, bounds: Bounds | undefined): number | undefined {
  if (!bounds) return undefined;
  const [x0, y0, x1, y1] = bounds;
  const width = x1 - x0, height = y1 - y0;
  if (!(width > 0) || !(height > 0)) return undefined;
  const crs = project.renderData.crs ?? "";
  const geographic = /4326|CRS84|WGS ?84|EPSG:4\d{3}/i.test(crs)
    || (crs === "" && x0 >= -180 && x1 <= 180 && y0 >= -90 && y1 <= 90);
  return geographic ? (width * Math.cos((y0 + y1) / 2 * Math.PI / 180)) / height : width / height;
}

/** Largest sub-rectangle of `cell` with the data's aspect ratio, centred in the cell. */
function shapeFrame(cell: Cell, aspect: number | undefined): Cell {
  if (!aspect || !Number.isFinite(aspect) || aspect <= 0) return cell;
  const current = cell.width / cell.height;
  if (Math.abs(Math.log(current / aspect)) < 0.12) return cell;
  if (current < aspect) {
    const height = Math.min(cell.height, cell.width / aspect);
    return { x: cell.x, y: cell.y + (cell.height - height) / 2, width: cell.width, height };
  }
  const width = Math.max(cell.width * 0.35, cell.height * aspect);
  return { x: cell.x + (cell.width - width) / 2, y: cell.y, width, height: cell.height };
}

/**
 * Deterministic inset candidates: named places that exist in the loaded election,
 * then the largest distinct named features, then data quadrants. Never invents a
 * place name the election does not carry.
 */
export function insetCandidates(project: Project, limit = 4): Array<{ label: string; extent: Bounds }> {
  const bounds = dataBounds(project);
  const out: Array<{ label: string; extent: Bounds }> = [];
  const seen: Bounds[] = [];
  const push = (label: string, extent: Bounds) => {
    if (out.length >= limit || !dataBounds(project)) return;
    if (bounds && !boundsContain(bounds, extent)) return;
    if (seen.some(other => boundsArea(boundsUnion(other, extent)) < boundsArea(extent) * 1.15)) return;
    seen.push(extent);
    out.push({ label, extent: padBounds(extent, 0.30, bounds) });
  };
  for (const label of ["HUNTSVILLE", "BIRMINGHAM", "MONTGOMERY", "MOBILE"]) {
    const extent = labelBounds(project, label);
    if (extent) push(label, extent);
  }
  if (out.length < 2) {
    const groups = new Map<string, Set<string>>();
    for (const record of project.renderData.records) {
      const name = normalizeName(record.name ?? "");
      if (name.length < 3) continue;
      const existing = groups.get(name) ?? new Set<string>();
      existing.add(record.key);
      groups.set(name, existing);
    }
    const ranked = [...groups.entries()].map(([name, keys]) => ({ name, extent: featureBounds(project, keys) }))
      .filter((item): item is { name: string; extent: Bounds } => Boolean(item.extent))
      .sort((a, b) => boundsArea(b.extent) - boundsArea(a.extent) || a.name.localeCompare(b.name));
    for (const item of ranked) { push(item.name, item.extent); if (out.length >= limit) break; }
  }
  if (out.length < 2 && bounds) {
    const [x0, y0, x1, y1] = bounds, mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    const quadrants: Array<[string, Bounds]> = [
      ["NORTHWEST", [x0, my, mx, y1]], ["NORTHEAST", [mx, my, x1, y1]],
      ["SOUTHWEST", [x0, y0, mx, my]], ["SOUTHEAST", [mx, y0, x1, my]],
    ];
    for (const [label, extent] of quadrants) push(label, extent);
  }
  return out;
}

/** Shared px-per-unit scale for `scaleMode: "identical"` inset groups. */
export function identicalInsetScale(elements: StudioElement[]): Map<string, number> {
  const groups = new Map<string, number>();
  for (const element of elements) {
    if (element.type !== "inset" || !element.visible || element.scaleMode !== "identical" || !element.scaleGroup) continue;
    const extent = elementExtent(element);
    if (!extent) continue;
    const pad = Math.min(6, Math.min(element.frame.width, element.frame.height) * 0.02);
    const scale = Math.min((element.frame.width - pad * 2) / (extent[2] - extent[0]), (element.frame.height - pad * 2) / (extent[3] - extent[1]));
    groups.set(element.scaleGroup, Math.min(groups.get(element.scaleGroup) ?? Infinity, scale));
  }
  return groups;
}

/* ------------------------------------------------------------------ styling */

const DEFAULT_MAP_STYLE: MapStyle = {
  mode: "winner-margin", continuous: true, buckets: 12, thresholds: [], minStrength: 0.45, maxStrength: 1,
  domain: [0, 0.6], reverse: false, noDataColor: "#D7D9D7", unopposedColor: "#A6AAAB", precinctStroke: "#FFFFFF",
  precinctStrokeWidth: 0.8, precinctStrokeOpacity: 0.8, countyStroke: "#27343C", countyStrokeWidth: 1.1,
  countyStrokeOpacity: 0.8, exteriorStroke: "#101A20", exteriorStrokeWidth: 2.5, background: "transparent",
  antialias: true, clip: true,
};

/** Ink that stays readable on a given background. */
export function inkOn(background: string, theme: Theme): string {
  const match = /^#([0-9a-f]{6})$/i.exec(background.trim());
  if (!match) return theme.colors.ink;
  const [r, g, b] = match[1].match(/.{2}/g)!.map(part => parseInt(part, 16) / 255);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.55 ? theme.colors.ink : "#FFFFFF";
}

const marginDomainCache = new WeakMap<RenderData, [number, number]>();

/** Largest recorded winner margin, rounded up, as the default margin domain (scanned once per dataset). */
export function marginDomain(project: Project): [number, number] {
  const data = project.renderData;
  const cached = marginDomainCache.get(data);
  if (cached) return cached;
  let max = 0;
  for (const record of data.records) max = Math.max(max, record.margin ?? 0);
  const domain: [number, number] = [0, Math.max(0.05, Math.ceil(max * 20) / 20)];
  marginDomainCache.set(data, domain);
  return domain;
}

function mapStyle(theme: Theme, domain: [number, number], overrides: Partial<MapStyle> = {}): MapStyle {
  return {
    ...DEFAULT_MAP_STYLE, noDataColor: theme.colors.noData, unopposedColor: theme.colors.unopposed,
    countyStroke: theme.colors.border, exteriorStroke: theme.colors.ink, domain, ...overrides,
  };
}

/* -------------------------------------------------------------- page layout */

const REFERENCE_PAGE = { width: 1400, height: 1200 };

/** Usable area between the safe margins. */
export function contentBox(page: Project["page"]): Frame {
  const m = Math.max(0, Math.min(page.safeMargin, Math.min(page.width, page.height) / 4));
  return { x: m, y: m, width: page.width - m * 2, height: page.height - m * 2 };
}

type Cell = Frame;

function shrink(cell: Cell, dx: number, dy = dx): Cell {
  return { x: cell.x + dx, y: cell.y + dy, width: cell.width - dx * 2, height: cell.height - dy * 2 };
}

function splitX(cell: Cell, gap: number, weights: number[]): Cell[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const usable = cell.width - gap * (weights.length - 1);
  let x = cell.x;
  return weights.map(weight => {
    const width = usable * weight / total;
    const out = { x, y: cell.y, width, height: cell.height };
    x += width + gap;
    return out;
  });
}

function splitY(cell: Cell, gap: number, weights: number[]): Cell[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const usable = cell.height - gap * (weights.length - 1);
  let y = cell.y;
  return weights.map(weight => {
    const height = usable * weight / total;
    const out = { x: cell.x, y, width: cell.width, height };
    y += height + gap;
    return out;
  });
}

function roundFrame(cell: Cell): Frame {
  const x = Math.round(cell.x * 10) / 10, y = Math.round(cell.y * 10) / 10;
  return { x, y, width: Math.round((cell.x + cell.width) * 10) / 10 - x, height: Math.round((cell.y + cell.height) * 10) / 10 - y };
}

type Ctx = {
  project: Project; comparison?: Project; box: Frame; theme: Theme; k: number;
  bounds?: Bounds; comparisonBounds?: Bounds; domain: [number, number];
};

function scaler(box: Frame): number { return Math.min(box.width / REFERENCE_PAGE.width, box.height / REFERENCE_PAGE.height); }
const size = (k: number, value: number) => Math.max(1, Math.round(value * k * 10) / 10);
const font = (k: number, value: number) => Math.max(6, Math.round(value * k * 2) / 2);

function context(project: Project): Ctx {
  const box = contentBox(project.page);
  return {
    project, comparison: project.comparison, box, theme: project.theme, k: scaler(box),
    bounds: dataBounds(project), comparisonBounds: project.comparison ? dataBounds(project.comparison) : undefined,
    domain: marginDomain(project),
  };
}

/* ----------------------------------------------------------- element factory */

function headerBlock(ctx: Ctx, cell: Cell, dataset: ElementDataset, options: { band: "dark" | "page"; name: string; title: number; subtitle: number }): HeaderElement {
  const { theme, k } = ctx;
  const background = options.band === "dark" ? theme.colors.header : theme.colors.page;
  const ink = options.band === "dark" ? inkOn(theme.colors.header, theme) : theme.colors.ink;
  const muted = options.band === "dark" ? inkOn(theme.colors.header, theme) : theme.colors.muted;
  return {
    id: dataset === "comparison" ? "header-comparison" : "header", name: options.name, type: "header", dataset,
    frame: roundFrame(cell), visible: true, locked: false, zIndex: 10, opacity: 1, background, padding: size(k, 26),
    title: "{{metadata.title}}", subtitle: "{{metadata.subtitle}}", kicker: "{{metadata.jurisdiction}} · {{year}}",
    identifier: "{{metadata.electionType}}",
    titleStyle: { family: theme.fonts.serif, size: font(k, options.title), weight: 700, color: ink },
    subtitleStyle: { family: theme.fonts.serif, size: font(k, options.subtitle), color: muted },
    kickerStyle: { family: theme.fonts.sans, size: font(k, 11), weight: 700, color: muted, transform: "uppercase" },
    identifierStyle: { family: theme.fonts.sans, size: font(k, 11), weight: 700, color: muted, transform: "uppercase", align: "right" },
  };
}

function mapBlock(ctx: Ctx, cell: Cell, options: { id: string; name: string; dataset: ElementDataset; extent?: Bounds; domain?: [number, number]; purpose?: "choropleth" | "locator"; style?: Partial<MapStyle> }): MainMapElement {
  const source = datasetProject(ctx.project, options.dataset);
  const sourceBounds = source ? dataBounds(source) : undefined;
  const extent = options.extent && sourceBounds && boundsContain(sourceBounds, options.extent) ? options.extent : undefined;
  // Give the map a frame the data actually fills: the window when one is pinned, else the whole election.
  const aspect = source ? aspectOfBounds(source, extent ?? sourceBounds) : undefined;
  return {
    id: options.id, name: options.name, type: "map", dataset: options.dataset, frame: roundFrame(shapeFrame(cell, aspect)), visible: true,
    locked: false, zIndex: options.purpose === "locator" ? 22 : 20, opacity: 1, projection: { type: "albers" },
    extent, zoom: 1, pan: [0, 0], purpose: options.purpose ?? "choropleth",
    style: mapStyle(ctx.theme, options.domain ?? ctx.domain, options.style),
  };
}

function resultsBlock(ctx: Ctx, cell: Cell, dataset: ElementDataset): ResultsPanelElement {
  const { theme, k } = ctx;
  const rowHeight = size(k, 44), headerHeight = size(k, 64);
  const rows = Math.max(1, (dataset === "comparison" ? ctx.comparison : ctx.project)?.data.candidates.filter(candidate => candidate.visible).length ?? 1);
  // Fit the panel to its rows so a three-candidate race does not leave an empty body.
  const fitted: Cell = { ...cell, height: Math.min(cell.height, headerHeight + 10 + rows * rowHeight + 34) };
  return {
    id: dataset === "comparison" ? "results-comparison" : "results", name: dataset === "comparison" ? "Comparison results" : "Results panel",
    type: "results", dataset, frame: roundFrame(fitted), visible: true, locked: false, zIndex: 30, opacity: 1,
    background: theme.colors.panel, border: { color: theme.colors.border, width: 1, radius: 0 },
    officeTitle: "{{metadata.office}}", electionLabel: "{{metadata.electionType}} · {{year}}",
    columns: [
      { id: "candidate", label: "CANDIDATE", visible: true, width: 0.52, align: "left" },
      { id: "status", label: "STATUS", visible: true, width: 0.18, align: "center" },
      { id: "votes", label: "VOTES", visible: true, width: 0.16, align: "right" },
      { id: "share", label: "SHARE", visible: true, width: 0.14, align: "right" },
    ],
    rowHeight, headerHeight,
    candidateNameStyle: { family: theme.fonts.serif, size: font(k, 14), weight: 700, color: theme.colors.ink },
    dataStyle: { family: theme.fonts.data, size: font(k, 13), color: theme.colors.ink },
    alternating: true, showTotal: true, voteDecimals: 0, percentDecimals: 2,
    ramp: { visible: false, segments: 10, min: 0, max: 0.6, width: size(k, 180), height: size(k, 8), ticks: [] },
  };
}

function legendBlock(ctx: Ctx, cell: Cell, dataset: ElementDataset, orientation: "horizontal" | "vertical"): LegendElement {
  const { theme, k } = ctx;
  return {
    id: dataset === "comparison" ? "legend-comparison" : "legend", name: dataset === "comparison" ? "Comparison legend" : "Legend",
    type: "legend", dataset, frame: roundFrame(cell), visible: true, locked: false, zIndex: 35, opacity: 1,
    legendType: "winner-margin", title: "{{metadata.office}} winner margin", orientation,
    columns: orientation === "horizontal" ? Math.max(1, (datasetProject(ctx.project, dataset)?.data.candidates ?? []).filter(candidate => candidate.visible).length) : 1,
    style: { family: theme.fonts.sans, size: font(k, 10), color: theme.colors.ink },
  };
}

function textBlock(ctx: Ctx, cell: Cell, dataset: ElementDataset, text: string, align: "left" | "right"): TextElement {
  return {
    id: dataset === "comparison" ? "source-comparison" : "source", name: dataset === "comparison" ? "Comparison source" : "Source",
    type: "text", dataset, frame: roundFrame(cell), visible: true, locked: false, zIndex: 40, opacity: 1, text, wrap: true,
    style: { family: ctx.theme.fonts.serif, size: font(ctx.k, 9.5), color: ctx.theme.colors.muted, align },
  };
}

function datasetKeyBlock(ctx: Ctx, cell: Cell): SelectorElement {
  return {
    id: "dataset-key", name: "Dataset key", type: "selector", frame: roundFrame(cell), visible: true, locked: false,
    zIndex: 45, opacity: 1, label: "DATASET", orientation: "vertical", swatchSize: size(ctx.k, 11), active: "primary",
    style: { family: ctx.theme.fonts.sans, size: font(ctx.k, 11), weight: 700, color: ctx.theme.colors.ink },
  };
}

function insetBlock(ctx: Ctx, cell: Cell, dataset: ElementDataset, name: string, extent: Bounds, aspect: number | undefined): InsetElement {
  const { theme, k } = ctx;
  return {
    id: `inset-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, name: name, type: "inset", dataset, frame: roundFrame(shapeFrame(cell, aspect)),
    visible: true, locked: false, zIndex: 25, opacity: 1, label: name, center: [(extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2],
    geographicExtent: extent, scaleGroup: "insets", scaleMode: "identical",
    mapStyle: { precinctStrokeWidth: 0.4, exteriorStrokeWidth: 1.6 },
    labelStyle: { family: theme.fonts.sans, size: font(k, 10), weight: 700, color: theme.colors.ink },
    labelBackground: theme.colors.page, labelPadding: size(k, 3),
  };
}

/* ----------------------------------------------------------------- p resets */

function statewide(ctx: Ctx): StudioElement[] {
  const { box } = ctx;
  const gap = size(ctx.k, 14);
  const [header, body, legendArea, foot] = splitY(box, gap, [1.4, 7.4, 1.1, 0.3]);
  const panelWidth = Math.min(body.width * 0.34, 460 * ctx.k);
  const results = { x: body.x + body.width - panelWidth - gap, y: body.y + gap, width: panelWidth, height: Math.min(body.height * 0.52, 420 * ctx.k) };
  const legendWidth = box.width * 0.72;
  return [
    headerBlock(ctx, header, "primary", { band: "dark", name: "Header", title: 30, subtitle: 14 }),
    mapBlock(ctx, body, { id: "main-map", name: "Main map", dataset: "primary" }),
    resultsBlock(ctx, results, "primary"),
    legendBlock(ctx, { x: box.x + (box.width - legendWidth) / 2, y: legendArea.y, width: legendWidth, height: legendArea.height }, "primary", "horizontal"),
    textBlock(ctx, foot, "primary", "{{metadata.source}}", "left"),
  ];
}

function results(ctx: Ctx): StudioElement[] {
  const { box } = ctx;
  const gap = size(ctx.k, 16);
  const [header, body, footer] = splitY(box, gap, [1.5, 7.4, 0.3]);
  const [mapCell, sideCell] = splitX(body, gap, [6, 3.6]);
  const [mapArea, legendArea] = splitY(mapCell, gap, [7.6, 0.9]);
  const panel = { x: sideCell.x, y: sideCell.y + size(ctx.k, 6), width: sideCell.width, height: Math.min(sideCell.height * 0.62, 560 * ctx.k) };
  const legend = { x: box.x + box.width * 0.10, y: legendArea.y, width: box.width * 0.8, height: legendArea.height };
  return [
    headerBlock(ctx, header, "primary", { band: "page", name: "Header", title: 38, subtitle: 16 }),
    mapBlock(ctx, mapArea, { id: "main-map", name: "Main map", dataset: "primary" }),
    resultsBlock(ctx, panel, "primary"),
    legendBlock(ctx, legend, "primary", "horizontal"),
    textBlock(ctx, footer, "primary", "{{metadata.source}} · {{metadata.notes}}", "left"),
  ];
}

function insets(ctx: Ctx): StudioElement[] {
  const { box } = ctx;
  const gap = size(ctx.k, 14);
  const [header, body, footer] = splitY(box, gap, [1.3, 8.4, 0.3]);
  const [mapCell, sideCell] = splitX(body, gap, [5.6, 4.4]);
  const candidates = ctx.project.data.candidates.filter(candidate => candidate.visible).length;
  const [resultsCell, legendCell, gridCell] = splitY(sideCell, gap, [2.6, Math.max(.9, Math.ceil(candidates / 2) * .4), 4.2]);
  const output: StudioElement[] = [
    headerBlock(ctx, header, "primary", { band: "dark", name: "Header", title: 28, subtitle: 13 }),
    mapBlock(ctx, mapCell, { id: "main-map", name: "Main map", dataset: "primary" }),
    resultsBlock(ctx, resultsCell, "primary"),
    legendBlock(ctx, legendCell, "primary", "vertical"),
    textBlock(ctx, footer, "primary", "{{metadata.source}}", "left"),
  ];
  const plan = insetCandidates(ctx.project, 4);
  if (!plan.length) return output;
  const columns = plan.length === 1 ? 1 : 2;
  const rows = Math.max(1, Math.ceil(plan.length / columns));
  const grid = splitY(gridCell, gap, Array.from({ length: rows }, () => 1));
  const cells = grid.flatMap(row => splitX(row, gap, Array.from({ length: columns }, () => 1))).slice(0, plan.length);
  const widths = plan.map(item => item.extent[2] - item.extent[0]);
  const heights = plan.map(item => item.extent[3] - item.extent[1]);
  const comparable = Math.max(...widths) / Math.min(...widths) <= 2.5 && Math.max(...heights) / Math.min(...heights) <= 2.5;
  const aspect = Math.max(...widths) / Math.max(...heights);
  plan.forEach((item, index) => {
    const inset = insetBlock(ctx, cells[index], "primary", item.label, item.extent, comparable ? aspect : widths[index] / heights[index]);
    if (!comparable) {
      inset.scaleMode = "independent";
      inset.scaleGroup = undefined;
    }
    output.push(inset);
  });
  return output;
}

function comparison(ctx: Ctx): StudioElement[] {
  const { box } = ctx;
  const gap = size(ctx.k, 16);
  const [headers, body, footer] = splitY(box, gap, [1.3, 6.6, 1.1]);
  const [primaryHeader, comparisonHeader] = splitX(headers, gap, [1, 1]);
  const [primaryColumn, comparisonColumn] = splitX(body, gap, [1, 1]);
  const [primaryCells, comparisonCells] = [splitY(primaryColumn, gap, [4.4, 3.0]), splitY(comparisonColumn, gap, [4.4, 3.0])];
  const [legendArea, keyRow] = splitY(footer, gap, [1.2, 1]);
  const [primaryLegend, comparisonLegend] = splitX(legendArea, gap, [1, 1]);
  const [keyCell, sourcePrimary, sourceComparison] = splitX(keyRow, gap, [1.2, 1.6, 1.6]);
  const sharedExtent = (() => {
    const [a, b] = [ctx.bounds, ctx.comparisonBounds];
    if (!a || !b) return undefined;
    const union = boundsUnion(a, b), larger = boundsArea(a) >= boundsArea(b) ? a : b;
    return boundsArea(union) <= boundsArea(larger) * 1.35 ? union : undefined;
  })();
  return [
    headerBlock(ctx, primaryHeader, "primary", { band: "page", name: "Header", title: 26, subtitle: 13 }),
    headerBlock(ctx, comparisonHeader, "comparison", { band: "page", name: "Comparison header", title: 26, subtitle: 13 }),
    mapBlock(ctx, primaryCells[0], { id: "map-primary", name: "Primary map", dataset: "primary", extent: sharedExtent, purpose: "choropleth" }),
    mapBlock(ctx, comparisonCells[0], { id: "map-comparison", name: "Comparison map", dataset: "comparison", extent: sharedExtent, purpose: "choropleth" }),
    resultsBlock(ctx, primaryCells[1], "primary"),
    resultsBlock(ctx, comparisonCells[1], "comparison"),
    legendBlock(ctx, primaryLegend, "primary", "horizontal"),
    legendBlock(ctx, comparisonLegend, "comparison", "horizontal"),
    datasetKeyBlock(ctx, keyCell),
    textBlock(ctx, sourcePrimary, "primary", "{{metadata.source}}", "left"),
    textBlock(ctx, sourceComparison, "comparison", "{{metadata.source}}", "left"),
  ];
}

function detail(ctx: Ctx): StudioElement[] {
  const { box } = ctx;
  const gap = size(ctx.k, 14);
  const [header, body, footer] = splitY(box, gap, [1.2, 8.0, 0.3]);
  const [detailCell, sideCell] = splitX(body, gap, [6.6, 3.4]);
  const [locatorCell, legendCell, resultsCell] = splitY(sideCell, gap, [2.6, 1.2, 3.4]);
  return [
    headerBlock(ctx, header, "primary", { band: "page", name: "Header", title: 30, subtitle: 14 }),
    mapBlock(ctx, detailCell, { id: "main-map", name: "Detail map", dataset: "primary", extent: ctx.bounds }),
    mapBlock(ctx, locatorCell, { id: "locator-map", name: "Locator overview", dataset: "primary", purpose: "locator" }),
    legendBlock(ctx, legendCell, "primary", "vertical"),
    resultsBlock(ctx, resultsCell, "primary"),
    textBlock(ctx, footer, "primary", "{{metadata.source}} · {{metadata.notes}}", "left"),
  ];
}

const PRESETS: Record<LayoutId, (ctx: Ctx) => StudioElement[]> = { statewide, results, insets, comparison, detail };

/* --------------------------------------------------------------- layouts API */

export function isLayoutId(value: unknown): value is LayoutId {
  return typeof value === "string" && (LAYOUT_IDS as readonly string[]).includes(value);
}

export function applyLayoutReport(project: Project, id: LayoutId): Report {
  if (!isLayoutId(id)) return { project, notices: [] };
  const ctx = context(project);
  const elements = PRESETS[id](ctx);
  const notices: Notice[] = [];
  if (id === "comparison" && !project.comparison) notices.push({
    code: "COMPARISON_DATASET_MISSING", level: "warning",
    message: "Comparison layout applied without a second election; its panels show a placeholder until one is loaded.",
  });
  return { project: { ...project, layoutId: id, design: undefined, elements }, notices };
}

/** Apply one of the {@link LAYOUTS} presets to a project, keeping its election data untouched. */
export function applyLayout(project: Project, id: LayoutId): Project {
  return applyLayoutReport(project, id).project;
}

/* --------------------------------------------------------------- designs API */

function designId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `design-${slug || "untitled"}`;
}

/**
 * Capture the current page as a portable, election-independent design: styles,
 * frames and metadata *bindings* only.
 */
export function createDesign(project: Project, name: string): Design {
  const projects = project.comparison ? [project, project.comparison] : [project];
  const elements = structuredClone(project.elements);
  for (const element of elements) tokenizeElement(element, projects);
  const candidateStyles: NonNullable<Design["candidateStyles"]> = {};
  for (const key of ["primary", "comparison"] as const) {
    const source = datasetProject(project, key);
    if (source) candidateStyles[key] = [...source.data.candidates].sort((a, b) => a.order - b.order)
      .map(({ color, lightColor, darkColor }, slot) => ({ slot, color, lightColor, darkColor }));
  }
  return {
    kind: "design", schemaVersion: 1, id: designId(name), name,
    createdAt: new Date().toISOString(), page: structuredClone(project.page), theme: structuredClone(project.theme),
    elements, layoutId: isLayoutId(project.layoutId) ? project.layoutId : undefined, themeId: project.themeId,
    candidateStyles,
  };
}


const ELEMENT_TYPES: Record<string, true> = { header: true, map: true, results: true, inset: true, text: true, legend: true, shape: true, selector: true };

function number(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }

/** Fill missing fields so hand-written and legacy files still open. */
function normalizeElement(raw: unknown, theme: Theme, index: number): StudioElement | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  const element = { ...source } as Record<string, unknown>;
  const type = String(element.type ?? "");
  if (!(type in ELEMENT_TYPES)) return undefined;
  const frame = (source.frame ?? {}) as Record<string, unknown>;
  element.id = typeof element.id === "string" && element.id ? element.id : `element-${index + 1}`;
  element.name = typeof element.name === "string" ? element.name : type;
  element.frame = {
    x: number(frame.x, 0), y: number(frame.y, 0),
    width: Math.max(1, number(frame.width, 200)), height: Math.max(1, number(frame.height, 120)),
  };
  element.visible = element.visible !== false;
  element.locked = element.locked === true;
  element.zIndex = number(element.zIndex, index + 1);
  element.opacity = Math.min(1, Math.max(0, number(element.opacity, 1)));
  element.dataset = element.dataset === "comparison" ? "comparison" : element.dataset === "primary" ? "primary" : undefined;
  if (type === "header") {
    element.title ??= "{{metadata.title}}"; element.subtitle ??= "{{metadata.subtitle}}";
    element.kicker ??= "{{metadata.jurisdiction}} · {{year}}"; element.identifier ??= "{{metadata.electionType}}";
    element.padding = number(element.padding, 20);
    element.titleStyle ??= { family: theme.fonts.serif, size: 28, weight: 700 };
    element.subtitleStyle ??= { family: theme.fonts.serif, size: 14 };
    element.kickerStyle ??= { family: theme.fonts.sans, size: 11 };
    element.identifierStyle ??= { family: theme.fonts.sans, size: 11 };
  }
  if (type === "map") {
    element.projection ??= { type: "albers" };
    element.zoom = number(element.zoom, 1);
    element.pan = Array.isArray(element.pan) ? element.pan : [0, 0];
    element.style = { ...mapStyle(theme, [0, 0.6]), ...((element.style ?? {}) as object) };
    element.extent = normalizeExtent(element.extent as number[] | undefined);
  }
  if (type === "results") {
    element.officeTitle ??= "{{metadata.office}}"; element.electionLabel ??= "{{metadata.electionType}} · {{year}}";
    element.columns ??= [];
    element.rowHeight = number(element.rowHeight, 44); element.headerHeight = number(element.headerHeight, 64);
    element.candidateNameStyle ??= { family: theme.fonts.serif, size: 14, weight: 700 };
    element.dataStyle ??= { family: theme.fonts.data, size: 13 };
    element.alternating = element.alternating !== false; element.showTotal = element.showTotal !== false;
    element.voteDecimals = number(element.voteDecimals, 0); element.percentDecimals = number(element.percentDecimals, 2);
    element.ramp = { visible: false, segments: 10, min: 0, max: 0.6, width: 180, height: 8, ticks: [], ...((element.ramp ?? {}) as object) };
  }
  if (type === "inset") {
    element.label ??= "INSET";
    element.center = Array.isArray(element.center) ? element.center : [0, 0];
    element.scaleMode = element.scaleMode === "identical" ? "identical" : "independent";
    element.geographicExtent = normalizeExtent(element.geographicExtent as number[] | undefined);
    element.labelStyle ??= { family: theme.fonts.sans, size: 10, weight: 700 };
    element.labelBackground ??= theme.colors.page;
    element.labelPadding = number(element.labelPadding, 3);
  }
  if (type === "text") {
    element.text ??= ""; element.style ??= { family: theme.fonts.serif, size: 12 }; element.wrap = element.wrap !== false;
  }
  if (type === "legend") {
    element.legendType ??= "winner-margin"; element.title ??= "{{metadata.office}} winner margin";
    element.orientation = element.orientation === "vertical" ? "vertical" : "horizontal";
    element.columns = number(element.columns, 3);
    element.style ??= { family: theme.fonts.sans, size: 10 };
  }
  if (type === "shape") {
    element.shape ??= "rect"; element.fill ??= "transparent";
    element.stroke ??= theme.colors.ink; element.strokeWidth = number(element.strokeWidth, 1);
  }
  if (type === "selector") {
    element.label ??= "DATASET";
    element.orientation = element.orientation === "vertical" ? "vertical" : "horizontal";
    element.swatchSize = number(element.swatchSize, 11);
    element.style ??= { family: theme.fonts.sans, size: 11, weight: 700 };
    element.active = element.active === "comparison" ? "comparison" : "primary";
  }
  return element as unknown as StudioElement;
}

/**
 * New element of any supported type with the preset defaults, for the layers panel.
 * Text-ish elements are seeded with metadata tokens so they re-bind per election.
 */
export function createElement(type: StudioElement["type"], project: Project, overrides: Partial<Frame> = {}): StudioElement {
  const frame: Frame = {
    x: project.page.safeMargin + 40, y: project.page.safeMargin + 120,
    width: Math.round(project.page.width * 0.34), height: Math.round(project.page.height * 0.16), ...overrides,
  };
  const labels: Record<string, string> = { header: "Header", map: "Map", results: "Results", inset: "Inset", text: "Text", legend: "Legend", shape: "Shape", selector: "Dataset key" };
  const raw = { type, id: `element-${Date.now()}`, name: labels[type] ?? type, frame };
  if (type === "text") Object.assign(raw, { text: "New annotation" });
  if (type === "legend") Object.assign(raw, { title: "{{metadata.office}} winner margin" });
  if (type === "inset") Object.assign(raw, { label: "INSET" });
  const element = normalizeElement(raw, project.theme, project.elements.length) ?? normalizeElement({ type: "text", id: `element-${Date.now()}`, name: "Text", frame, text: "New annotation" }, project.theme, 0) as StudioElement;
  element.zIndex = Math.max(0, ...project.elements.map(candidate => candidate.zIndex)) + 1;
  return element;
}

/**
 * Normalize hand-written files: current `kind: "design"` documents, legacy
 * `kind: "template"` files, or bare `{ elements }` objects. Missing page/theme
 * fall back to the project the design is being applied to.
 */
export function normalizeDesign(raw: unknown, project: Project): Design {
  const source = (raw ?? {}) as Record<string, unknown>;
  const theme = (source.theme && typeof source.theme === "object" ? source.theme : project.theme) as Theme;
  const page = (source.page && typeof source.page === "object" ? { ...project.page, ...(source.page as object) } : project.page);
  const list = Array.isArray(source.elements) ? source.elements : [];
  const elements = list.map((element, index) => normalizeElement(element, theme, index)).filter((element): element is StudioElement => Boolean(element));
  const name = typeof source.name === "string" && source.name ? source.name : "Untitled design";
  return {
    kind: "design", schemaVersion: 1,
    id: typeof source.id === "string" && source.id ? source.id : designId(name),
    name, createdAt: typeof source.createdAt === "string" ? source.createdAt : new Date().toISOString(),
    page, theme, elements,
    layoutId: isLayoutId(source.layoutId) ? source.layoutId : undefined,
    themeId: typeof source.themeId === "string" ? source.themeId : theme.id,
    candidateStyles: source.candidateStyles as Design["candidateStyles"],
  };
}

/**
 * Reconcile saved geographic windows with the incoming election. A window is only
 * kept when it actually covers incoming geography; otherwise it is dropped and the
 * map re-fits. Insets are re-focused to a place with the same name when the
 * incoming election has one, and removed (with a notice) when it does not — stale
 * windows from another jurisdiction are never silently retained.
 */
function reconcileGeography(elements: StudioElement[], project: Project, notices: Notice[]): StudioElement[] {
  return elements.filter(element => {
    const target = datasetProject(project, element.dataset);
    if (!target) return true;
    const bounds = dataBounds(target);
    if (element.type === "map" && element.extent) {
      const extent = normalizeExtent(element.extent);
      if (!extent || !bounds || !boundsContain(bounds, extent)) {
        delete element.extent;
        notices.push({
          code: "MAP_EXTENT_RESET", level: "info", elementId: element.id,
          message: `${element.name} framed geography that this election does not cover; the map now fits the loaded data.`,
        });
      }
      return true;
    }
    if (element.type !== "inset") return true;
    const extent = normalizeExtent(element.geographicExtent);
    if (extent && bounds && boundsContain(bounds, extent)) return true;
    const resolved = labelBounds(target, element.label);
    if (resolved) {
      element.geographicExtent = padBounds(resolved, 0.30, bounds);
      element.center = [(element.geographicExtent[0] + element.geographicExtent[2]) / 2, (element.geographicExtent[1] + element.geographicExtent[3]) / 2];
      notices.push({
        code: "INSET_REFOCUSED", level: "info", elementId: element.id,
        message: `Inset ${element.label} was re-framed to the ${element.label} geography in this election.`,
      });
      return true;
    }
    notices.push({
      code: "INSET_DROPPED", level: "warning", elementId: element.id,
      message: `Inset ${element.label} was removed: this election has no matching place, and keeping another jurisdiction's window would misrepresent the map.`,
    });
    return false;
  });
}

export function applyDesignReport(project: Project, raw: unknown): Report {
  const design = normalizeDesign(raw, project);
  const checked = validateDesign(design);
  if (!checked.success) throw new Error(checked.error.issues.map(issue => issue.message).join("; "));
  if (!design.elements.length) throw new Error("A design must contain at least one page element");
  const notices: Notice[] = [];
  const applied = reconcileGeography(structuredClone(design.elements), project, notices);
  const styleCandidates = (source: Project, slots: NonNullable<Design["candidateStyles"]>["primary"]): Project => {
    if (!slots?.length) return source;
    const ordered = [...source.data.candidates].sort((a, b) => a.order - b.order);
    const byId = new Map(slots.filter(slot => ordered[slot.slot]).map(slot => [ordered[slot.slot].id, slot]));
    return { ...source, data: { ...source.data, candidates: source.data.candidates.map(candidate => {
      const style = byId.get(candidate.id);
      return style ? { ...candidate, color: style.color, lightColor: style.lightColor, darkColor: style.darkColor } : candidate;
    }) } };
  };
  const styled = styleCandidates(project, design.candidateStyles?.primary);
  const styledComparison = project.comparison ? styleCandidates(project.comparison, design.candidateStyles?.comparison) : undefined;
  if (design.candidateStyles) notices.push({ code: "DESIGN_COLOR_SLOTS", level: "info", message: "Design colors follow candidate display-order slots. Verify the colors assigned to this election's candidates." });
  return {
    project: {
      ...styled, comparison: styledComparison, page: structuredClone(design.page), theme: structuredClone(design.theme), elements: applied,
      design: { ...design, elements: structuredClone(design.elements) }, layoutId: design.layoutId ?? project.layoutId,
      themeId: design.themeId ?? project.themeId,
    },
    notices,
  };
}

/** Apply a saved design to a project: rebinding every metadata token, never copying election data. */
export function applyDesign(project: Project, raw: unknown): Project {
  return applyDesignReport(project, raw).project;
}

function sameDataset(a?: Project, b?: Project): boolean {
  if (!a || !b) return false;
  return (a.dataset?.id ?? a.id) === (b.dataset?.id ?? b.id);
}

export function switchElectionReport(current: Project, incoming: Project, preserveDesign: boolean): Report {
  const notices: Notice[] = [];
  const comparison = sameDataset(current.comparison, incoming) ? undefined : current.comparison;
  if (current.comparison && !comparison) notices.push({
    code: "COMPARISON_CLEARED", level: "info",
    message: "The comparison election matched the election being opened, so comparing an election with itself was prevented.",
  });
  const base: Project = { ...incoming, comparison };
  if (!preserveDesign) return { project: base, notices };
  const report = applyDesignReport(base, createDesign(current, "Preserved design"));
  // The carried-over design is transient: keep only the design the user actually saved with this project.
  return { project: { ...report.project, design: current.design }, notices: [...notices, ...report.notices] };
}

/**
 * Open another election. With `preserveDesign`, the current page design and styling
 * carry over (re-bound to the new election) while votes, geometry, provenance and
 * metadata come from `incoming`; geographic windows that the new election does not
 * cover are reset instead of silently cropping to stale coordinates.
 */
export function switchElection(current: Project, incoming: Project, preserveDesign: boolean): Project {
  return switchElectionReport(current, incoming, preserveDesign).project;
}

/* ------------------------------------------------------- candidate palettes */

export type CandidatePaletteEntry = {
  id: string; slot: number; color: string; lightColor?: string; darkColor?: string; visible?: boolean;
};
export type CandidatePalette = { kind: "candidate-palette"; schemaVersion: 1; name: string; candidates: CandidatePaletteEntry[] };
export type PaletteReport = {
  project: Project; applied: Array<{ id: string; displayName: string; matchedBy: "id" | "slot" }>; unmatched: CandidatePaletteEntry[];
};

/** Styling-only palette: identity + colors, never votes or election labels. */
export function paletteFromProject(project: Project, name = `${project.name} palette`): CandidatePalette {
  return {
    kind: "candidate-palette", schemaVersion: 1, name,
    candidates: project.data.candidates.map((candidate, slot) => ({
      id: candidate.id, slot, color: candidate.color, lightColor: candidate.lightColor, darkColor: candidate.darkColor, visible: candidate.visible,
    })),
  };
}

/**
 * Transfer a palette onto another election by stable candidate id, falling back to
 * the explicit slot only when no id matches. Display names, votes and ordering of
 * the incoming election are never overwritten.
 */
export function applyPalette(project: Project, raw: unknown): PaletteReport {
  const palette = (raw ?? {}) as Partial<CandidatePalette>;
  const entries = Array.isArray(palette.candidates) ? palette.candidates : [];
  const ordered = [...project.data.candidates].sort((a, b) => a.order - b.order);
  const claimed = new Set<string>();
  const applied: PaletteReport["applied"] = [];
  const unmatched: CandidatePaletteEntry[] = [];
  const candidates = project.data.candidates.map(candidate => ({ ...candidate }));
  for (const entry of entries) {
    if (!entry || typeof entry.color !== "string") continue;
    const byId = candidates.find(candidate => candidate.id === entry.id && !claimed.has(candidate.id));
    const bySlot = byId ? undefined : ordered[entry.slot ?? -1];
    const target = byId ?? (bySlot && bySlot.id !== entry.id ? candidates.find(candidate => candidate.id === bySlot.id) : undefined);
    if (!target) { unmatched.push(entry); continue; }
    claimed.add(target.id);
    target.color = entry.color;
    if (entry.lightColor) target.lightColor = entry.lightColor;
    if (entry.darkColor) target.darkColor = entry.darkColor;
    if (typeof entry.visible === "boolean") target.visible = entry.visible;
    applied.push({ id: target.id, displayName: target.displayName, matchedBy: byId ? "id" : "slot" });
  }
  return { project: { ...project, data: { ...project.data, candidates } }, applied, unmatched };
}

/* --------------------------------------------------------------- comparison */

/**
 * Load a second election for comparison. Returns the project with `comparison` set,
 * plus notices when the two elections cannot share a geographic window (different
 * jurisdictions), so the comparison panels each fit their own data.
 */
export function withComparison(project: Project, incoming?: Project): Report {
  if (!incoming) return { project: { ...project, comparison: undefined }, notices: [] };
  const notices: Notice[] = [];
  if (sameDataset(project, incoming)) notices.push({
    code: "COMPARISON_SELF", level: "warning",
    message: "The comparison election is the same dataset as the primary election; pick a different race.",
  });
  const [a, b] = [dataBounds(project), dataBounds(incoming)];
  if (a && b) {
    const union = boundsUnion(a, b);
    if (boundsArea(union) > boundsArea(a) * 1.35 || !boundsContain(union, b)) notices.push({
      code: "COMPARISON_EXTENT_INDEPENDENT", level: "info",
      message: "The two elections cover different geography; each comparison map fits its own election instead of sharing one window.",
    });
  }
  return { project: { ...project, comparison: incoming }, notices };
}

/** True when the two elections can share a single map window (same/extending geography). */
export function sharedComparisonExtent(project: Project): Bounds | undefined {
  const compare = project.comparison && dataBounds(project.comparison);
  const primary = dataBounds(project);
  if (!compare || !primary) return undefined;
  const union = boundsUnion(primary, compare);
  const larger = boundsArea(primary) >= boundsArea(compare) ? primary : compare;
  return boundsArea(union) <= boundsArea(larger) * 1.35 ? union : undefined;
}

/** Progress/coverage summary of a dataset, used by exports and diagnostics. */
export type DatasetSummary = {
  id: string; label: string; jurisdiction: string; electionDate: string; matchStatus?: string;
  geometryVintage?: string; features: number; records: number; withVotes: number;
  /** Features carrying drawable geometry; a feature with `null`/empty geometry counts in `features` only. */
  drawableFeatures: number;
  /** Records whose join key has no drawable feature: votes the map cannot place. */
  unmappedRecords: number; unmappedVotes: number;
  candidateTotals: Record<string, number>; diagnostics: Array<{ severity: string; code: string; count?: number }>;
  sourceHashes: Record<string, string>; bounds?: Bounds;
};

/** The record-aggregation half of {@link DatasetSummary}: the O(records) work the renderer and panels repeat. */
type DatasetCoverage = {
  candidateTotals: Record<string, number>; withVotes: number; drawableFeatures: number;
  unmappedRecords: number; unmappedVotes: number;
};

const coverageCache = new WeakMap<RenderData, { signature: string; coverage: DatasetCoverage }>();

/**
 * Totals, vote coverage and mapping coverage in one pass over the records.
 *
 * Cached per immutable dataset plus the candidate ids it counts, so an edit that only moves or
 * restyles elements reuses the scan instead of walking every record again. `unmappedRecords`
 * counts records the map cannot draw (no feature, or a feature with no usable geometry), which
 * is coverage the old record-only count hid: an unmatched precinct still carries its votes.
 */
function datasetCoverage(project: Project): DatasetCoverage {
  const data = project.renderData;
  const candidates = [...project.data.candidates].sort((a, b) => a.order - b.order);
  const signature = candidates.map(candidate => candidate.id).join("\u0000");
  const cached = coverageCache.get(data);
  if (cached && cached.signature === signature) return cached.coverage;
  const { boundsByKey, drawableFeatures } = featureIndex(data);
  const candidateTotals = Object.fromEntries(candidates.map(candidate => [candidate.id, 0]));
  let withVotes = 0, unmappedRecords = 0, unmappedVotes = 0;
  for (const record of data.records) {
    if (record.totalVotes > 0) withVotes += 1;
    for (const candidate of candidates) candidateTotals[candidate.id] += record.candidateVotes[candidate.id] ?? 0;
    if (!boundsByKey.has(record.key)) {
      unmappedRecords += 1;
      unmappedVotes += record.totalVotes;
    }
  }
  const coverage: DatasetCoverage = { candidateTotals, withVotes, drawableFeatures, unmappedRecords, unmappedVotes };
  coverageCache.set(data, { signature, coverage });
  return coverage;
}

export function datasetSummary(project: Project | undefined): DatasetSummary | undefined {
  if (!project) return undefined;
  const coverage = datasetCoverage(project);
  return {
    id: project.dataset?.id ?? project.id, label: project.dataset?.label ?? project.name,
    jurisdiction: project.metadata.jurisdiction, electionDate: project.metadata.electionDate,
    matchStatus: project.dataset?.matchStatus, geometryVintage: project.dataset?.geometryVintage,
    features: project.renderData.features.length, records: project.renderData.records.length, withVotes: coverage.withVotes,
    drawableFeatures: coverage.drawableFeatures, unmappedRecords: coverage.unmappedRecords, unmappedVotes: coverage.unmappedVotes,
    candidateTotals: coverage.candidateTotals,
    diagnostics: project.renderData.diagnostics.map(diagnostic => ({ severity: diagnostic.severity, code: diagnostic.code, count: diagnostic.count })),
    sourceHashes: project.renderData.sourceHashes ?? {}, bounds: dataBounds(project),
  };
}
