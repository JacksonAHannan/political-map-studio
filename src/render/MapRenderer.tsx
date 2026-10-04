import React from "react";
import { geoAlbers, geoArea, geoIdentity, geoMercator, geoPath } from "d3-geo";
import type { FeatureCollection, Geometry, Position } from "geojson";
import type { Candidate, DerivedRecord, ElementDataset, FontStyle, Frame, InsetElement, LegendElement, MainMapElement, Project, RenderData, RenderFeature, ResultsPanelElement, SelectorElement, ShapeElement, StudioElement, TextElement } from "../model/types";
import { candidateTotals, interpolate } from "../model/derive";
import { bindText, dataBounds, datasetProject, datasetSummary, elementExtent, extentGeometry, featureIndex, featureKey, identicalInsetScale, marginDomain, normalizeExtent, type Bounds } from "../model/design";

type Props = {
  project: Project; selectedId?: string; onSelect?: (id: string) => void;
  /** Called when the dataset key of a comparison layout is clicked. */
  onDatasetSelect?: (dataset: ElementDataset) => void;
};

type LayerContext = {
  project: Project; candidates: Candidate[]; candidateById: Record<string, Candidate>;
  recordByKey: Record<string, DerivedRecord>; features: RenderFeature[]; boundaries?: FeatureCollection;
  bounds?: [number, number, number, number]; domain: [number, number];
};

const contextCache = new WeakMap<Project, LayerContext>();

/** Per-dataset lookup tables, built once per project object instead of per feature/element. */
function layerContext(project: Project): LayerContext {
  const cached = contextCache.get(project);
  if (cached) return cached;
  const context: LayerContext = {
    project,
    candidates: [...project.data.candidates].sort((a, b) => a.order - b.order),
    candidateById: Object.fromEntries(project.data.candidates.map(candidate => [candidate.id, candidate])),
    recordByKey: Object.fromEntries(project.renderData.records.map(record => [record.key, record])),
    features: project.renderData.features,
    boundaries: project.renderData.countyBoundaries,
    bounds: dataBounds(project),
    domain: marginDomain(project),
  };
  contextCache.set(project, context);
  return context;
}

// RFC 7946 and d3's spherical stream use opposite polygon winding conventions.
// Adapt ring traversal once per immutable data cache, never the matched source.
const sphericalDataCache = new WeakMap<RenderData, RenderData>();
function sphericalRings(rings: Position[][]): Position[][] {
  return rings.map((ring, index) => {
    const complement = geoArea({ type: "Polygon", coordinates: [ring] }) > 2 * Math.PI;
    return complement === (index === 0) ? [...ring].reverse() : ring;
  });
}
function sphericalGeometry(geometry: Geometry): Geometry {
  if (geometry.type === "Polygon") return { ...geometry, coordinates: sphericalRings(geometry.coordinates) };
  if (geometry.type === "MultiPolygon") return { ...geometry, coordinates: geometry.coordinates.map(sphericalRings) };
  if (geometry.type === "GeometryCollection") return { ...geometry, geometries: geometry.geometries.map(sphericalGeometry) };
  return geometry;
}
function sphericalData(data: RenderData): RenderData {
  const cached = sphericalDataCache.get(data);
  if (cached) return cached;
  const adapted: RenderData = {
    ...data,
    features: data.features.map(feature => ({ ...feature, geometry: feature.geometry ? sphericalGeometry(feature.geometry) : null })),
    countyBoundaries: data.countyBoundaries ? {
      ...data.countyBoundaries,
      features: data.countyBoundaries.features.map(feature => ({ ...feature, geometry: sphericalGeometry(feature.geometry) })),
    } : undefined,
  };
  sphericalDataCache.set(data, adapted);
  return adapted;
}

const textStyle = (style: FontStyle, fallback: string): React.CSSProperties => ({
  fontFamily: style.family || fallback, fontSize: style.size || 12, fontWeight: style.weight, color: style.color, fill: style.color,
  letterSpacing: style.letterSpacing, textTransform: style.transform === "none" ? undefined : style.transform as React.CSSProperties["textTransform"],
});

function anchorFor(align?: FontStyle["align"]): "start" | "middle" | "end" {
  return align === "right" ? "end" : align === "center" ? "middle" : "start";
}

/** Approximate word wrap: SVG has no measure API in the export path, so width comes from the font size. */
function wrapLines(text: string, frame: Frame, style: FontStyle): string[] {
  const size = style.size || 12;
  const lineHeight = (style.lineHeight || 1.25) * size;
  const maxChars = Math.max(6, Math.floor(frame.width / (size * 0.52)));
  const maxLines = Math.max(1, Math.floor(frame.height / lineHeight));
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (!line.length) line = word;
      else if (line.length + 1 + word.length <= maxChars) line += ` ${word}`;
      else { lines.push(line); line = word; }
      if (lines.length >= maxLines) break;
    }
    if (line && lines.length < maxLines) lines.push(line);
    if (lines.length >= maxLines) break;
  }
  return lines.length ? lines : [text];
}

/* -------------------------------------------------------------- projections */

/** The projection calls this renderer makes, shared by d3's conical and identity transforms. */
type AdjustableProjection = {
  (point: [number, number]): [number, number] | null;
  scale(): number;
  scale(value: number): AdjustableProjection;
  translate(): [number, number];
  translate(value: [number, number]): AdjustableProjection;
  invert(point: [number, number]): [number, number] | null;
  fitExtent(extent: [[number, number], [number, number]], object: never): AdjustableProjection;
};

type ProjectionTransform = { scale: number; translate: [number, number] };

/** Projection kinds a layer can resolve to: the map's own choice, or identity for insets. */
type ProjectionKind = MainMapElement["projection"]["type"] | "identity";

/** The projection d3 transform a layer draws with; conics for maps, reflected identity otherwise. */
function createProjection(kind: ProjectionKind): AdjustableProjection {
  return (kind === "albers" ? geoAlbers() : kind === "mercator" ? geoMercator() : geoIdentity().reflectY(true)) as unknown as AdjustableProjection;
}

const fittedTransformCache = new WeakMap<RenderData, Map<string, ProjectionTransform>>();
/** Fitted transforms kept per dataset. A drag walks through many frames; the newest few suffice. */
const FITTED_TRANSFORM_ENTRIES = 16;

/**
 * Scale/translate `fitExtent` would produce for this frame, cached per dataset.
 *
 * Fitting streams the whole collection through the projection's bounds stream: on a statewide
 * precinct file that is the single most expensive step of a render, and it changes only when
 * the frame, padding or projection kind does — never when a style, color or selection does.
 * The stored numbers are the projection's own output, so reuse is exact rather than approximate.
 */
function datasetFitTransform(kind: ProjectionKind, frame: Frame, pad: number, data: RenderData): ProjectionTransform {
  const key = `${kind}|${frame.width}x${frame.height}|${pad}`;
  const cache = fittedTransformCache.get(data) ?? new Map<string, ProjectionTransform>();
  const cached = cache.get(key);
  if (cached) return cached;
  if (!fittedTransformCache.has(data)) fittedTransformCache.set(data, cache);
  const transform = fitTransform(createProjection(kind), frame, pad, sphericalData(data));
  while (cache.size >= FITTED_TRANSFORM_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  cache.set(key, transform);
  return transform;
}

/** Fit a projection to the frame's inner rectangle, returning the transform it settled on. */
function fitTransform(projection: AdjustableProjection, frame: Frame, pad: number, source: object): ProjectionTransform {
  try {
    projection.fitExtent([[pad, pad], [Math.max(pad + 1, frame.width - pad), Math.max(pad + 1, frame.height - pad)]], source as never);
  } catch {
    // Degenerate geometry: d3's fit has already reset scale/translate before it streams, so leave
    // the projection exactly where a throwing fitExtent would, rather than at constructor defaults.
    projection.scale(150);
    projection.translate([0, 0]);
  }
  const [tx, ty] = projection.translate();
  return { scale: projection.scale(), translate: [tx, ty] };
}

function makeProjection(frame: Frame, element: MainMapElement | InsetElement, context: LayerContext, sharedScale?: number): AdjustableProjection {
  const kind: ProjectionKind = element.type === "map" ? element.projection.type : "identity";
  const projection = createProjection(kind);
  const extent = elementExtent(element);
  const pad = Math.min(6, Math.min(frame.width, frame.height) * 0.02);
  const window: [number, number, number, number] | undefined = extent ?? context.bounds;
  // geoIdentity (and identical-scale insets) place an explicit window arithmetically; conics fit the window rectangle.
  const arithmetic = element.type === "inset" || kind === "identity";
  if (arithmetic && window) {
    const [x0, y0, x1, y1] = window;
    const fit = Math.min((frame.width - pad * 2) / (x1 - x0), (frame.height - pad * 2) / (y1 - y0));
    const scale = sharedScale ?? fit;
    projection.scale(scale);
    projection.translate([frame.width / 2 - scale * (x0 + x1) / 2, frame.height / 2 + scale * (y0 + y1) / 2]);
  } else {
    const transform = extent
      ? fitTransform(projection, frame, pad, extentGeometry(extent))
      : datasetFitTransform(kind, frame, pad, context.project.renderData);
    projection.scale(transform.scale);
    projection.translate(transform.translate);
  }
  if (element.type !== "map") return projection;
  const { zoom, pan } = element;
  if (zoom !== 1 || pan[0] !== 0 || pan[1] !== 0) {
    const centerX = frame.width / 2, centerY = frame.height / 2;
    const [tx, ty] = projection.translate();
    projection.scale(projection.scale() * zoom)
      .translate([centerX + (tx - centerX) * zoom + pan[0], centerY + (ty - centerY) * zoom + pan[1]]);
  }
  return projection;
}

/* ------------------------------------------------------------------- fills */

/** Bucket edges: explicit ascending thresholds (one or more), else even buckets across the margin domain. */
function bucketEdges(style: MainMapElement["style"]): number[] {
  const domain = style.domain[1] || 1;
  const thresholds = [...style.thresholds].filter(Number.isFinite).sort((a, b) => a - b);
  if (thresholds.length >= 1) return thresholds;
  const buckets = Math.max(2, Math.round(style.buckets));
  return Array.from({ length: buckets - 1 }, (_unused, index) => domain * (index + 1) / buckets);
}

function fillFor(record: DerivedRecord | undefined, style: MainMapElement["style"], context: LayerContext, edges: number[]): string {
  if (!record || !record.totalVotes || !record.winnerId) return style.noDataColor;
  const candidate = context.candidateById[record.winnerId];
  if (!candidate) return style.noDataColor;
  if (style.mode === "winner") return candidate.color;
  const margin = Math.abs(record.margin ?? 0);
  const binned = !style.continuous || style.thresholds.length >= 1;
  const strength = !binned
    ? Math.min(1, Math.max(0, margin / (style.domain[1] || 1)))
    : (() => {
      let index = 0;
      while (index < edges.length && margin >= edges[index]) index += 1;
      return (index + 0.5) / (edges.length + 1);
    })();
  const level = style.minStrength + (style.maxStrength - style.minStrength) * strength;
  return interpolate(candidate.color, style.reverse ? 1 - level : level, candidate.lightColor);
}

/* ------------------------------------------------------- prepared geometry */

type PreparedPath = { index: number; key: string; d: string };
/** Projected paths of one layer, plus the character total held for cache accounting. */
type PreparedPaths = { precincts: PreparedPath[]; counties: PreparedPath[]; chars: number };
type PathCache = { entries: Map<string, PreparedPaths>; chars: number };

const preparedPathCache = new WeakMap<RenderData, PathCache>();
/** Path text kept for reuse. Beyond this the oldest projections of a dataset are dropped. */
const PATH_CACHE_CHARS = 64 * 1024 * 1024;
const PATH_CACHE_ENTRIES = 6;

/**
 * Everything a projected `d` string depends on: the projection kind, the resolved
 * scale/translate d3 will use, the local frame the coordinates land in, and the stroke
 * padding the visible window is widened by (0 when the layer paints unclipped, which is the
 * one case where off-frame geometry stays visible). Equal signatures project to equal
 * geometry, which is what makes reuse safe.
 *
 * Element identity cannot key this: the editor re-clones every element on each commit while
 * the `RenderData` behind them stays the same object.
 */
function pathSignature(kind: ProjectionKind, projection: AdjustableProjection, frame: Frame, pad: number): string {
  const [tx, ty] = projection.translate();
  return `${kind}|${projection.scale()}|${tx}|${ty}|${frame.width}x${frame.height}|${pad}`;
}

/** Exact inverse of the padded frame for identity projections, whose edges stay straight. */
function frameWindow(projection: AdjustableProjection, frame: Frame, pad: number): Bounds | undefined {
  const first = projection.invert([-pad, -pad]);
  const last = projection.invert([frame.width + pad, frame.height + pad]);
  if (!first || !last || ![...first, ...last].every(Number.isFinite)) return undefined;
  return [Math.min(first[0], last[0]), Math.min(first[1], last[1]), Math.max(first[0], last[0]), Math.max(first[1], last[1])];
}

/**
 * Path data for one layer, reused until the projection changes.
 *
 * Insets over statewide precincts otherwise project and emit every precinct of the state and
 * throw the rest away at the SVG clipPath. A feature whose bounds miss the padded visible
 * window cannot paint inside the frame, so it is never projected; partially visible features
 * are projected in full, exactly as before, and the clipPath still decides the final edge.
 */
function preparedPaths(kind: ProjectionKind, data: RenderData, origin: RenderData, projection: AdjustableProjection, frame: Frame, pad: number): PreparedPaths {
  const signature = pathSignature(kind, projection, frame, pad);
  const cache = preparedPathCache.get(data);
  const cached = cache?.entries.get(signature);
  if (cache && cached) {
    cache.entries.delete(signature);
    cache.entries.set(signature, cached); // keep the working projection most-recent
    return cached;
  }
  // Spherical arcs can enter a frame outside their vertex bounds; only planar bounds prove invisibility.
  const window = pad > 0 && kind === "identity" ? frameWindow(projection, frame, pad) : undefined;
  const built = projectPaths(data, origin, projection, window);
  if (built.chars > PATH_CACHE_CHARS) return built;
  const target = cache ?? { entries: new Map<string, PreparedPaths>(), chars: 0 };
  if (!cache) preparedPathCache.set(data, target);
  for (const key of target.entries.keys()) {
    if (target.entries.size < PATH_CACHE_ENTRIES && target.chars + built.chars <= PATH_CACHE_CHARS) break;
    const evicted = target.entries.get(key);
    target.entries.delete(key);
    if (evicted) target.chars -= evicted.chars;
  }
  target.entries.set(signature, built);
  target.chars += built.chars;
  return built;
}

function projectPaths(data: RenderData, origin: RenderData, projection: AdjustableProjection, window: Bounds | undefined): PreparedPaths {
  const path = geoPath(projection as never);
  const index = window ? featureIndex(origin) : undefined;
  const visible = (bounds: Bounds | undefined): boolean => {
    if (!window) return true;
    if (!bounds) return false;
    return bounds[0] <= window[2] && bounds[2] >= window[0] && bounds[1] <= window[3] && bounds[3] >= window[1];
  };
  const precincts: PreparedPath[] = [];
  const counties: PreparedPath[] = [];
  let chars = 0;
  data.features.forEach((feature, position) => {
    if (index && !visible(index.boundsByKey.get(featureKey(feature)))) return;
    const d = path(feature as never);
    if (!d) return;
    precincts.push({ index: position, key: featureKey(feature), d });
    chars += d.length;
  });
  data.countyBoundaries?.features.forEach((feature, position) => {
    if (index && !visible(index.boundaryBounds[position])) return;
    const d = path(feature as never);
    if (!d) return;
    counties.push({ index: position, key: `county-${position}`, d });
    chars += d.length;
  });
  return { precincts, counties, chars };
}

const preparedFillCache = new WeakMap<RenderData, { signature: string; fills: string[] }>();

/**
 * Fill of every precinct in dataset order, keyed by the style and candidate colors that
 * decide it, so a projection change (drag, resize, zoom) reuses colors and vice versa.
 * Reads only immutable records, which is why the dataset itself is a safe cache key.
 */
function preparedFills(data: RenderData, style: MainMapElement["style"], context: LayerContext): string[] {
  const signature = `${style.mode}|${style.continuous}|${style.buckets}|${style.thresholds.join(",")}|${style.domain[0]},${style.domain[1]}|${style.minStrength}|${style.maxStrength}|${style.reverse}|${style.noDataColor}|${context.candidates.map(candidate => `${candidate.id}:${candidate.color}:${candidate.lightColor ?? ""}`).join(",")}`;
  const cached = preparedFillCache.get(data);
  if (cached && cached.signature === signature) return cached.fills;
  const edges = bucketEdges(style);
  const fills = data.features.map(feature => fillFor(context.recordByKey[featureKey(feature)], style, context, edges));
  preparedFillCache.set(data, { signature, fills });
  return fills;
}

/** Stroke width a dropped feature may reach back into the frame with, plus antialiasing room. */
function strokePadding(style: MainMapElement["style"]): number {
  return Math.max(8, Math.max(style.precinctStrokeWidth, style.countyStrokeWidth) * 3);
}

/**
 * Precinct paths of one layer. Memoised: while the projection and the style stand still the
 * props are reference-equal, so React skips the whole precinct subtree at this one boundary
 * instead of walking thousands of `<path>` children.
 */
const PrecinctPaths = React.memo(function PrecinctPaths({ prepared, fills, locator, noDataColor, stroke, strokeWidth, strokeOpacity }: {
  prepared: PreparedPaths; fills: string[]; locator: boolean; noDataColor: string; stroke: string; strokeWidth: number; strokeOpacity: number;
}) {
  return <>{prepared.precincts.map(item => <path key={`${item.key}-${item.index}`} d={item.d}
    fill={locator ? noDataColor : fills[item.index]} stroke={stroke}
    strokeWidth={locator ? 0 : strokeWidth} strokeOpacity={strokeOpacity} vectorEffect="non-scaling-stroke"/>)}</>;
});

/** County outlines of one layer, memoised on the same prepared projection as the precincts. */
const CountyPaths = React.memo(function CountyPaths({ prepared }: { prepared: PreparedPaths }) {
  return <>{prepared.counties.map(item => <path key={item.key} d={item.d}/>)}</>;
});

/* ------------------------------------------------------------------ layers */

/** Palette used by insets in a design that has no main map to inherit from. */
const DEFAULT_INSET_STYLE: MainMapElement["style"] = {
  mode: "winner-margin", continuous: true, buckets: 12, thresholds: [], minStrength: 0.45, maxStrength: 1, domain: [0, 0.6],
  reverse: false, noDataColor: "#D7D9D7", unopposedColor: "#A6AAAB", precinctStroke: "#FFFFFF", precinctStrokeWidth: 0.55,
  precinctStrokeOpacity: 0.8, countyStroke: "#27343C", countyStrokeWidth: 1.1, countyStrokeOpacity: 0.8, exteriorStroke: "#101A20",
  exteriorStrokeWidth: 2.5, background: "transparent", antialias: true, clip: true,
};

function MapLayer({ element, project }: { element: MainMapElement | InsetElement; project: Project }) {
  const source = datasetProject(project, element.dataset);
  if (!source) return <MissingDataset element={element} project={project} />;
  return <MapLayerBody element={element} project={project} source={source} />;
}

/**
 * The map body: resolves the projection, then renders the prepared paths.
 *
 * The `d` strings come from a per-dataset cache, and the element arrays below are memoised on
 * those cached arrays and on the style primitives they read. An edit that does not move or
 * restyle this layer therefore keeps the very same element objects, which React reconciles
 * without touching a single precinct node.
 */
function MapLayerBody({ element, project, source }: { element: MainMapElement | InsetElement; project: Project; source: Project }) {
  const frame = element.frame;
  const context = layerContext(source);
  const renderData = element.type === "map" && element.projection.type !== "identity" ? sphericalData(source.renderData) : source.renderData;
  const main = project.elements.find(candidate => candidate.type === "map" && candidate.purpose !== "locator"
    && (candidate.dataset ?? "primary") === (element.dataset ?? "primary")) as MainMapElement | undefined;
  const style: MainMapElement["style"] = element.type === "map" ? element.style : { ...(main?.style ?? DEFAULT_INSET_STYLE), ...element.mapStyle };
  const shared = element.type === "inset" && element.scaleMode === "identical" && element.scaleGroup
    ? identicalInsetScale(project.elements).get(element.scaleGroup) : undefined;
  const kind: ProjectionKind = element.type === "map" ? element.projection.type : "identity";
  const extent = elementExtent(element);
  const projection = makeProjection(frame, element, context, shared);
  // Off-frame geometry is only hidden when the layer is clipped; unclipped layers keep it all.
  const pad = style.clip ? strokePadding(style) : 0;
  const prepared = preparedPaths(kind, renderData, source.renderData, projection, frame, pad);
  const fills = preparedFills(renderData, style, context);
  const locator = element.type === "map" && element.purpose === "locator";
  const { noDataColor, precinctStroke, precinctStrokeWidth, precinctStrokeOpacity } = style;
  const detailExtent = locator ? normalizeExtent(main?.extent) : undefined;
  const detailCorners = detailExtent
    ? [projection([detailExtent[0], detailExtent[3]]), projection([detailExtent[2], detailExtent[1]])]
    : undefined;
  const label = element.type === "inset" ? bindText(element.label, source) : "";
  const labelPadding = element.type === "inset" ? Math.max(0, element.labelPadding) : 0;
  const labelSize = element.type === "inset" ? element.labelStyle.size ?? 12 : 0;
  return <g transform={`translate(${frame.x} ${frame.y})`} opacity={element.opacity} data-dataset={element.dataset ?? "primary"}
    data-layer={element.type} data-frame={`${frame.width}x${frame.height}`} data-extent={extent?.join(",") ?? "auto"}>
    <rect width={frame.width} height={frame.height} fill={element.background || style.background || "transparent"}/>
    <defs><clipPath id={`clip-${element.id}`}><rect width={frame.width} height={frame.height}/></clipPath></defs>
    <g clipPath={style.clip ? `url(#clip-${element.id})` : undefined}>
      <PrecinctPaths prepared={prepared} fills={fills} locator={locator} noDataColor={noDataColor}
        stroke={precinctStroke} strokeWidth={precinctStrokeWidth} strokeOpacity={precinctStrokeOpacity}/>
      {renderData.countyBoundaries && renderData.countyBoundaries.features.length > 0 && <g fill="none" stroke={style.countyStroke} strokeWidth={style.countyStrokeWidth} strokeOpacity={style.countyStrokeOpacity} vectorEffect="non-scaling-stroke">
        <CountyPaths prepared={prepared}/>
      </g>}
      {detailCorners && detailCorners[0] && detailCorners[1] && <rect
        x={Math.min(detailCorners[0][0], detailCorners[1][0])} y={Math.min(detailCorners[0][1], detailCorners[1][1])}
        width={Math.abs(detailCorners[1][0] - detailCorners[0][0])} height={Math.abs(detailCorners[1][1] - detailCorners[0][1])}
        fill="none" stroke={style.exteriorStroke} strokeWidth={Math.max(1.5, style.exteriorStrokeWidth)} vectorEffect="non-scaling-stroke"/>}
    </g>
    <rect width={frame.width} height={frame.height} fill="none" stroke={element.border?.color ?? style.exteriorStroke} strokeWidth={element.border?.width ?? style.exteriorStrokeWidth} rx={element.border?.radius}/>
    {locator && <text x={4} y={frame.height - 6} style={textStyle({ family: project.theme.fonts.sans, size: 9, color: project.theme.colors.muted }, project.theme.fonts.sans)}>{element.name}</text>}
    {element.type === "inset" && <g><rect x={4} y={4} width={Math.max(46, label.length * labelSize * .65 + labelPadding * 2)} height={labelSize * 1.25 + labelPadding * 2} fill={element.labelBackground}/><text x={4 + labelPadding} y={4 + labelPadding + labelSize} style={textStyle(element.labelStyle, project.theme.fonts.sans)}>{label}</text></g>}
  </g>;
}

function MissingDataset({ element, project }: { element: StudioElement; project: Project }) {
  const { frame } = element;
  return <g transform={`translate(${frame.x} ${frame.y})`} opacity={element.opacity} data-missing-dataset="comparison">
    <rect width={frame.width} height={frame.height} fill={project.theme.colors.panel} stroke={project.theme.colors.muted} strokeDasharray="6 4"/>
    <text x={frame.width / 2} y={frame.height / 2 - 6} textAnchor="middle" style={{ fontFamily: project.theme.fonts.sans, fontSize: 12, fontWeight: 700, fill: project.theme.colors.ink }}>Comparison election not loaded</text>
    <text x={frame.width / 2} y={frame.height / 2 + 12} textAnchor="middle" style={{ fontFamily: project.theme.fonts.serif, fontSize: 10, fill: project.theme.colors.muted }}>Load a second election to populate this panel.</text>
  </g>;
}

/* ----------------------------------------------------------------- content */

function Header({ element, project }: { element: Extract<StudioElement, { type: "header" }>; project: Project }) {
  const source = datasetProject(project, element.dataset) ?? project;
  const { frame } = element;
  const title = bindText(element.title, source), subtitle = bindText(element.subtitle, source);
  const titleLines = wrapLines(title, { ...frame, width: frame.width - element.padding * 2, height: Infinity }, element.titleStyle);
  const titleLineHeight = (element.titleStyle.size ?? 12) * (element.titleStyle.lineHeight ?? 1.25);
  return <g transform={`translate(${frame.x} ${frame.y})`} opacity={element.opacity} data-dataset={element.dataset ?? "primary"}>
    <rect width={frame.width} height={frame.height} fill={element.background || project.theme.colors.header}/>
    <text x={element.padding} y={frame.height * .34} style={textStyle(element.titleStyle, project.theme.fonts.serif)}>
      {titleLines.map((line, index) => <tspan key={index} x={element.padding} dy={index ? titleLineHeight : 0}>{line}</tspan>)}
    </text>
    <text x={element.padding} y={frame.height * .74} style={textStyle(element.subtitleStyle, project.theme.fonts.serif)}>{subtitle}</text>
    <text x={frame.width - element.padding} y={frame.height * .16} textAnchor="end" style={textStyle(element.kickerStyle, project.theme.fonts.sans)}>{bindText(element.kicker, source)}</text>
    <text x={frame.width - element.padding} y={frame.height * .93} textAnchor="end" style={textStyle(element.identifierStyle, project.theme.fonts.sans)}>{bindText(element.identifier, source)}</text>
  </g>;
}

type ColumnLayout = { id: ResultsPanelElement["columns"][number]["id"]; label: string; x: number; align: "left" | "center" | "right" };

function columnLayouts(columns: ResultsPanelElement["columns"], width: number, padding: number): ColumnLayout[] {
  const visible = columns.filter(column => column.visible !== false);
  const total = visible.reduce((sum, column) => sum + Math.max(0.01, column.width || 0.1), 0) || 1;
  const usable = Math.max(1, width - padding * 2);
  let x = padding;
  return visible.map(column => {
    const span = usable * Math.max(0.01, column.width || 0.1) / total;
    const cell = { id: column.id, label: column.label, x: column.align === "right" ? x + span : column.align === "center" ? x + span / 2 : x, align: column.align ?? "left" };
    x += span;
    return cell;
  });
}

function Results({ element, project }: { element: ResultsPanelElement; project: Project }) {
  const source = datasetProject(project, element.dataset);
  const { frame } = element;
  if (!source) return <MissingDataset element={element} project={project} />;
  const context = layerContext(source);
  const candidates = context.candidates.filter(candidate => candidate.visible);
  const totals = candidateTotals(source.renderData.records, context.candidates);
  const grand = source.renderData.records.reduce((sum, record) => sum + record.totalVotes, 0);
  // When the matched source carries more votes for a candidate than the preserved precinct rows do
  // (absentee/provisional ballots with no precinct unit), the drawn rows are a recovery, not the
  // certified result, and the panel says so rather than implying a complete election total.
  const reconciliation = source.renderData.library?.reconciliation;
  const recovered = Boolean(reconciliation && (reconciliation.incompleteElection || Object.entries(reconciliation.source)
    .some(([id, votes]) => votes > (reconciliation.preserved[id] ?? totals[id] ?? 0))));
  const best = context.candidates.reduce<{ id?: string; votes: number }>((leader, candidate) => totals[candidate.id] > leader.votes ? { id: candidate.id, votes: totals[candidate.id] } : leader, { votes: -1 });
  const padding = 18, columns = columnLayouts(element.columns ?? [], frame.width, padding);
  const columnX = (id: ColumnLayout["id"], fallback: number) => columns.find(column => column.id === id)?.x ?? fallback;
  const columnAnchor = (id: ColumnLayout["id"]) => anchorFor(columns.find(column => column.id === id)?.align);
  const headerHeight = Math.max(24, element.headerHeight || 64), titleHeight = headerHeight * 0.5, labelHeight = headerHeight * 0.5;
  const rowTop = headerHeight + 10;
  const rowArea = frame.height - rowTop - (element.showTotal ? 34 : 10);
  const rowHeight = Math.min(element.rowHeight, rowArea / Math.max(1, candidates.length));
  return <g transform={`translate(${frame.x} ${frame.y})`} opacity={element.opacity} data-dataset={element.dataset ?? "primary"}>
    <rect width={frame.width} height={frame.height} fill={element.background || project.theme.colors.panel} stroke={element.border?.color || project.theme.colors.border} strokeWidth={element.border?.width || 1}/>
    <rect width={frame.width} height={titleHeight} fill={project.theme.colors.header}/>
    <text x={frame.width / 2} y={titleHeight * 0.65} textAnchor="middle" fill="white" fontFamily={project.theme.fonts.sans} fontWeight="700" fontSize="13">{bindText(element.officeTitle, source)}</text>
    <rect y={titleHeight} width={frame.width} height={labelHeight} fill="#eef1f2"/>
    <text x={frame.width / 2} y={titleHeight + labelHeight * 0.68} textAnchor="middle" fill={project.theme.colors.ink} fontFamily={project.theme.fonts.sans} fontWeight="700" fontSize="10">{bindText(element.electionLabel, source)}</text>
    {columns.map(column => <text key={column.id} x={column.x} y={headerHeight + 8} textAnchor={anchorFor(column.align)} style={textStyle({ ...element.dataStyle, size: Math.max(8, (element.dataStyle?.size || 12) - 2), weight: 700, color: project.theme.colors.muted }, project.theme.fonts.sans)}>{column.label}</text>)}
    {candidates.map((candidate, index) => <CandidateRow key={candidate.id} candidate={candidate} index={index} y={rowTop + index * rowHeight} height={rowHeight} element={element}
      votes={totals[candidate.id]} grand={grand} winner={best.id === candidate.id && best.votes > 0}
      nameX={columnX("candidate", padding)} votesX={columnX("votes", frame.width - padding)} shareX={columnX("share", frame.width - padding)} statusX={columnX("status", frame.width - padding)} anchors={{ votes: columnAnchor("votes"), share: columnAnchor("share"), status: columnAnchor("status") }} project={project}/>) }
    {element.showTotal && <g><rect y={frame.height - 34} width={frame.width} height={34} fill="#eef1f2"/><text x={padding} y={frame.height - 13} fontFamily={project.theme.fonts.sans} fontSize="10" fontWeight="700">{recovered ? "RECOVERED TOTAL" : "TOTAL"}</text><text x={frame.width - padding} y={frame.height - 13} textAnchor="end" fontFamily={project.theme.fonts.data} fontSize="11" fontWeight="700">{grand.toLocaleString()}</text></g>}
  </g>;
}

function CandidateRow({ candidate, index, y, height, element, votes, grand, winner, nameX, votesX, shareX, statusX, anchors, project }: {
  candidate: Candidate; index: number; y: number; height: number; element: ResultsPanelElement; votes: number; grand: number; winner: boolean;
  nameX: number; votesX: number; shareX: number; statusX: number; anchors: { votes: "start" | "middle" | "end"; share: "start" | "middle" | "end"; status: "start" | "middle" | "end" }; project: Project;
}) {
  const ramp = element.ramp ?? { visible: false, segments: 10, min: 0, max: 0.6, width: 180, height: 8, ticks: [] }, share = grand ? votes / grand : 0;
  const textLimit = height * (ramp.visible ? .36 : .65);
  const nameStyle = { ...element.candidateNameStyle, size: Math.min(element.candidateNameStyle.size ?? 14, textLimit) };
  const dataStyle = { ...element.dataStyle, size: Math.min(element.dataStyle.size ?? 12, textLimit) };
  const nameY = y + Math.max(Math.min(height * .45, height - 6), nameStyle.size), rampY = y + height * .70;
  const rampHeight = Math.min(ramp.height, height * .16);
  const tickSize = Math.min(Math.max(7, (element.dataStyle.size ?? 12) - 4), height * .12);
  return <g><rect y={y} width={element.frame.width} height={height} fill={element.alternating && index % 2 ? "#f2f0eb" : "#fbfaf6"} stroke="#c7cbcc" strokeWidth=".5"/><rect y={y} width={7} height={height} fill={candidate.color}/>
    <text x={nameX} y={nameY} style={textStyle(nameStyle, project.theme.fonts.serif)}>{candidate.displayName}</text>
    {winner && <text x={statusX} y={nameY} textAnchor={anchors.status} style={textStyle({ ...dataStyle, weight: 700, size: Math.min(textLimit, Math.max(8, (element.dataStyle.size ?? 12) - 1)) }, project.theme.fonts.sans)}>✓ WINNER</text>}
    <text x={votesX} y={nameY} textAnchor={anchors.votes} style={textStyle(dataStyle, project.theme.fonts.data)}>{votes.toLocaleString(undefined, { minimumFractionDigits: element.voteDecimals, maximumFractionDigits: element.voteDecimals })}</text>
    <text x={shareX} y={nameY} textAnchor={anchors.share} style={textStyle(dataStyle, project.theme.fonts.data)}>{(share * 100).toFixed(element.percentDecimals)}%</text>
    {ramp.visible && <g>{Array.from({ length: Math.max(2, ramp.segments) }, (_unused, segment) => <rect key={segment} x={nameX + segment * (ramp.width / Math.max(2, ramp.segments))} y={rampY}
      width={ramp.width / Math.max(2, ramp.segments) - 1} height={rampHeight} fill={interpolate(candidate.color, ramp.min + (ramp.max - ramp.min) * segment / Math.max(1, ramp.segments - 1), candidate.lightColor)}/>)}
      {ramp.ticks.map((tick, tickIndex) => <text key={`tick-${tickIndex}`} x={nameX + ramp.width * (tick - ramp.min) / Math.max(1e-6, ramp.max - ramp.min)} y={rampY + rampHeight + tickSize} textAnchor="middle" style={textStyle({ ...element.dataStyle, size: tickSize, color: project.theme.colors.muted }, project.theme.fonts.sans)}>{Math.round(tick * 100)}%</text>)}</g>}
  </g>;
}

/* ------------------------------------------------------------------ legend */

function Legend({ element, project }: { element: LegendElement; project: Project }) {
  const source = datasetProject(project, element.dataset) ?? project;
  const { frame } = element;
  const context = layerContext(source);
  const candidates = context.candidates.filter(candidate => candidate.visible);
  const map = project.elements.find(candidate => candidate.type === "map" && candidate.dataset === element.dataset) as MainMapElement | undefined;
  const style = map?.style;
  const domain = style?.domain?.[1] || context.domain[1];
  const edges = style ? bucketEdges(style) : [domain * 0.5];
  const continuous = style?.continuous !== false;
  const items = element.items?.length ? element.items : candidates.map(candidate => ({ label: candidate.displayName, color: candidate.color }));
  const vertical = element.orientation === "vertical";
  const titleHeight = element.title ? 16 : 0;
  const startY = titleHeight + (element.subtitle ? 16 : 0) + 6;
  const flat = style?.mode === "winner";
  const categorical = element.legendType === "manual" || element.legendType === "categorical" || flat;
  const slots = categorical ? items.length : candidates.length;
  const desiredHeight = categorical ? 22 : 40;
  const availableHeight = Math.max(1, frame.height - startY);
  const widestLabel = Math.max(1, ...items.map(item => bindText(item.label, source).length));
  const minimumWidth = Math.max(100, widestLabel * (element.style.size ?? 12) * .65 + 26);
  const widthCapacity = Math.max(1, Math.floor(frame.width / minimumWidth));
  const rowCapacity = Math.max(1, Math.floor((availableHeight + 4) / desiredHeight));
  const columns = Math.max(1, Math.min(slots || 1, widthCapacity, Math.max(element.columns || 1, Math.ceil(slots / rowCapacity))));
  const cellWidth = frame.width / columns, cellHeight = availableHeight / Math.max(1, Math.ceil(slots / columns));
  const contentScale = Math.min(1, cellHeight / desiredHeight);
  const barWidth = Math.max(1, cellWidth / contentScale - (vertical ? 60 : 18));
  const segments = continuous ? Math.max(2, style?.buckets ?? 8) : Math.max(2, edges.length + 1);
  const rampOf = (color: string, light?: string) => Array.from({ length: segments }, (_unused, segment) =>
    <rect key={segment} x={segment * (barWidth / segments)} width={barWidth / segments - (vertical ? 6 : 1)} height={vertical ? 10 : 12}
      fill={interpolate(color, segment / Math.max(1, segments - 1), light)}/>);
  return <g transform={`translate(${frame.x} ${frame.y})`} opacity={element.opacity} data-dataset={element.dataset ?? "primary"}>
    {element.background && <rect width={frame.width} height={frame.height} fill={element.background} stroke={element.border?.color} strokeWidth={element.border?.width}/>}
    {element.title && <text x="0" y="12" style={textStyle({ ...element.style, weight: 700 }, project.theme.fonts.sans)}>{bindText(element.title, source)}</text>}
    {element.subtitle && <text x="0" y={titleHeight + 12} style={textStyle({ ...element.style, size: Math.max(8, (element.style.size || 12) - 2), color: project.theme.colors.muted }, project.theme.fonts.sans)}>{bindText(element.subtitle, source)}</text>}
    {categorical
      ? items.map((item, index) => {
        const column = index % columns, row = Math.floor(index / columns);
        return <g key={`${item.label}-${index}`} transform={`translate(${column * cellWidth} ${startY + row * cellHeight}) scale(${contentScale})`}>
          <rect width="18" height="12" fill={item.color}/><text x="26" y="11" style={textStyle(element.style, project.theme.fonts.sans)}>{bindText(item.label, source)}</text>
        </g>;
      })
      : candidates.map((candidate, index) => {
        const column = index % columns, row = Math.floor(index / columns);
        const x = column * cellWidth, y = startY + row * cellHeight;
        const ticks = continuous ? [0, domain / 2, domain] : edges;
        return <g key={candidate.id} transform={`translate(${x} ${y}) scale(${contentScale})`}>
          <text x="0" y="10" style={textStyle({ ...element.style, weight: 700 }, project.theme.fonts.sans)}>{candidate.displayName}</text>
          <g transform={`translate(0 14)`}>{rampOf(candidate.color, candidate.lightColor)}</g>
          {ticks.map((tick, tickIndex) => <text key={`t-${tickIndex}`} x={barWidth * tick / Math.max(1e-6, domain)} y="38"
            textAnchor={tickIndex === 0 ? "start" : tickIndex === ticks.length - 1 ? "end" : "middle"} style={textStyle({ ...element.style, size: Math.max(7, (element.style.size || 12) - 3), color: project.theme.colors.muted }, project.theme.fonts.sans)}>{Math.round(tick * 100)}%</text>)}
        </g>;
      })}
  </g>;
}

/* ---------------------------------------------------------- dataset selector */

function datasetLabel(project: Project | undefined, fallback: string): string {
  return project ? `${project.metadata.jurisdiction} · ${project.metadata.electionDate}` : fallback;
}

function Selector({ element, project, onDatasetSelect }: { element: SelectorElement; project: Project; onDatasetSelect?: Props["onDatasetSelect"] }) {
  const { frame } = element;
  const entries: Array<{ dataset: ElementDataset; label: string; color: string }> = [
    { dataset: "primary", label: datasetLabel(project, project.name), color: project.data.candidates.find(candidate => candidate.visible)?.color ?? project.theme.colors.muted },
    { dataset: "comparison", label: project.comparison ? datasetLabel(project.comparison, project.comparison.name) : "Comparison election: not loaded",
      color: project.comparison?.data.candidates.find(candidate => candidate.visible)?.color ?? project.theme.colors.muted },
  ];
  const vertical = element.orientation === "vertical";
  const cellWidth = vertical ? frame.width : frame.width / entries.length;
  const cellHeight = vertical ? Math.max(0, frame.height - 14) / entries.length : frame.height;
  return <g transform={`translate(${frame.x} ${frame.y})`} opacity={element.opacity} data-dataset-selector="">
    <text x="0" y="10" style={textStyle({ ...element.style, size: Math.max(7, (element.style.size || 12) - 2), color: project.theme.colors.muted }, project.theme.fonts.sans)}>{element.label}</text>
    {entries.map((entry, index) => {
      const x = vertical ? 0 : index * cellWidth, y = (vertical ? index * cellHeight : 0) + 14;
      const active = element.active === entry.dataset;
      const unavailable = entry.dataset === "comparison" && !project.comparison;
      return <g key={entry.dataset} transform={`translate(${x} ${y})`} data-dataset-key={entry.dataset} data-active={active ? "true" : "false"}
        onClick={onDatasetSelect ? event => { event.stopPropagation(); onDatasetSelect(entry.dataset); } : undefined}
        style={onDatasetSelect ? { cursor: "pointer" } : undefined}>
        {active && <rect width={Math.min(cellWidth, frame.width) - 6} height={16} rx={2} fill={project.theme.colors.page} stroke={project.theme.colors.border}/>}
        <rect x="4" y="4" width={element.swatchSize} height={element.swatchSize} fill={entry.color} stroke={project.theme.colors.border} strokeWidth=".5" opacity={unavailable ? 0.4 : 1}/>
        <text x={4 + element.swatchSize + 6} y={element.swatchSize} style={textStyle({ ...element.style, color: unavailable ? project.theme.colors.muted : element.style.color, weight: active ? 700 : 400 }, project.theme.fonts.sans)}>{entry.label}</text>
      </g>;
    })}
  </g>;
}

/* ------------------------------------------------------------ misc elements */

function TextBlock({ element, project }: { element: TextElement; project: Project }) {
  const source = datasetProject(project, element.dataset) ?? project;
  const { frame } = element;
  const text = bindText(element.text, source);
  const anchor = anchorFor(element.style.align);
  const x = element.style.align === "right" ? frame.width : element.style.align === "center" ? frame.width / 2 : 0;
  const lines = element.wrap ? wrapLines(text, frame, element.style) : [text];
  const lineHeight = (element.style.lineHeight || 1.25) * (element.style.size || 12);
  return <g transform={`translate(${frame.x} ${frame.y})`} opacity={element.opacity} data-dataset={element.dataset ?? "primary"}>
    <text x={x} y={element.style.size || 12} textAnchor={anchor} style={textStyle(element.style, project.theme.fonts.serif)}>
      {lines.map((line, index) => <tspan key={index} x={x} dy={index ? lineHeight : 0}>{line}</tspan>)}
    </text>
  </g>;
}

function ShapeBlock({ element }: { element: ShapeElement }) {
  const { frame } = element;
  return <g transform={`translate(${frame.x} ${frame.y})`} opacity={element.opacity}>
    {element.shape === "ellipse" ? <ellipse cx={frame.width / 2} cy={frame.height / 2} rx={frame.width / 2} ry={frame.height / 2} fill={element.fill} stroke={element.stroke} strokeWidth={element.strokeWidth}/>
      : element.shape === "line" || element.shape === "arrow" ? <>
        {element.shape === "arrow" && <defs><marker id={`arrow-${element.id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 Z" fill={element.stroke}/></marker></defs>}
        <line x1={0} y1={0} x2={frame.width} y2={frame.height} stroke={element.stroke} strokeWidth={element.strokeWidth} markerEnd={element.shape === "arrow" ? `url(#arrow-${element.id})` : undefined}/>
      </> : <rect width={frame.width} height={frame.height} rx={element.border?.radius ?? 0} fill={element.fill} stroke={element.stroke} strokeWidth={element.strokeWidth}/>}
  </g>;
}

function GenericElement({ element, project, onDatasetSelect }: { element: StudioElement; project: Project; onDatasetSelect?: Props["onDatasetSelect"] }) {
  if (element.type === "header") return <Header element={element} project={project}/>;
  if (element.type === "map" || element.type === "inset") return <MapLayer element={element} project={project}/>;
  if (element.type === "results") return <Results element={element} project={project}/>;
  if (element.type === "legend") return <Legend element={element} project={project}/>;
  if (element.type === "selector") return <Selector element={element} project={project} onDatasetSelect={onDatasetSelect}/>;
  if (element.type === "text") return <TextBlock element={element} project={project}/>;
  if (element.type === "shape") return <ShapeBlock element={element}/>;
  return null;
}

/* --------------------------------------------------------------- document */

type ExportMetadata = {
  generator: string; schemaVersion: number; projectId: string; name: string;
  page: { width: number; height: number; unit: string; dpi: number };
  layoutId?: string; design?: { id: string; name: string; layoutId?: string };
  datasets: Record<string, unknown>;
  elements: Array<{ id: string; type: string; name: string; dataset?: string }>;
};

/** Export/QA metadata: dataset provenance, coverage and totals, without duplicating geometry. */
export function projectMetadata(project: Project): ExportMetadata {
  const summary = (dataset?: Project) => {
    const data = datasetSummary(dataset);
    if (!data) return undefined;
    const library = dataset?.renderData.library;
    return {
      ...data,
      countyBoundaries: dataset?.renderData.countyBoundaries ? dataset.renderData.countyBoundaries.features.length : 0,
      // Matching lineage travels with the export: which crosswalk matched the source results to
      // this geometry, and how the preserved precinct rows reconcile with the certified totals.
      matchMethod: library?.matchMethod, results: library?.results, crosswalk: library?.crosswalk,
      reconciliation: library?.reconciliation, geometryProvenance: library?.provenance,
    };
  };
  return {
    generator: "Political Map Studio", schemaVersion: project.schemaVersion, projectId: project.id, name: project.name,
    page: { width: project.page.width, height: project.page.height, unit: project.page.unit, dpi: project.page.dpi },
    layoutId: project.layoutId, design: project.design ? { id: project.design.id, name: project.design.name, layoutId: project.design.layoutId } : undefined,
    datasets: { primary: summary(project), comparison: summary(project.comparison) },
    elements: project.elements.map(element => ({ id: element.id, type: element.type, name: element.name, dataset: element.dataset })),
  };
}

/**
 * The canvas. Memoised on its props so editor state that does not touch the project — the
 * autosave stamp, notices, the active tab, canvas zoom, selection overlay bookkeeping while
 * `project` is unchanged — does not walk the element tree again. `App` keeps `setSelected`
 * stable, so props compare equal across those renders.
 */
export const MapRenderer = React.memo(function MapRenderer({ project, selectedId, onSelect, onDatasetSelect }: Props) {
  const metadata = project.export?.embedMetadata ? JSON.stringify(projectMetadata(project)) : undefined;
  return <svg id="studio-canvas-svg" xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${project.page.width} ${project.page.height}`} width="100%" height="100%" style={{ background: project.page.background, display: "block" }}>
    <metadata>{metadata ?? JSON.stringify({ generator: "Political Map Studio", schemaVersion: project.schemaVersion, projectId: project.id })}</metadata>
    <rect width={project.page.width} height={project.page.height} fill={project.page.background}/>
    {[...project.elements].filter(element => element.visible).sort((a, b) => a.zIndex - b.zIndex).map(element => <g key={element.id}
      onMouseDown={event => { event.stopPropagation(); onSelect?.(element.id); }} data-element-id={element.id} data-element-type={element.type}>
      <GenericElement element={element} project={project} onDatasetSelect={onDatasetSelect}/>
      {selectedId === element.id && <rect data-editor-overlay="selection" x={element.frame.x} y={element.frame.y} width={element.frame.width} height={element.frame.height} fill="none" stroke="#2F80ED" strokeWidth="2" strokeDasharray="6 4" pointerEvents="none"/>}
    </g>)}
  </svg>;
});
