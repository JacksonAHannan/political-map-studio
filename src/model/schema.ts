import { z } from "zod";
import { LAYOUT_IDS, SUPPORTED_MAP_MODES } from "./types";

const hexColor = z.string().regex(/^#[0-9a-f]{6}$/i, "Expected a six-digit hex color");
const frame = z.object({ x:z.number(), y:z.number(), width:z.number().positive(), height:z.number().positive() });
const baseElement = z.object({ id:z.string().min(1), name:z.string(), frame, visible:z.boolean(), locked:z.boolean(), zIndex:z.number(), opacity:z.number().min(0).max(1), dataset:z.enum(["primary","comparison"]).optional() });
const fontStyle = z.object({ family:z.string().optional(), size:z.number().positive().optional(), weight:z.union([z.number(),z.string()]).optional(), color:hexColor.optional() }).passthrough();
const mapStyle = z.object({ mode:z.enum(SUPPORTED_MAP_MODES), minStrength:z.number(), maxStrength:z.number(), domain:z.tuple([z.number(),z.number()]), reverse:z.boolean(), noDataColor:hexColor }).passthrough();
const geographicExtent = z.tuple([z.number(),z.number(),z.number(),z.number()]);
const textBinding = z.string();

export const mapElementSchema = baseElement.extend({
  type:z.literal("map"),
  projection:z.object({type:z.enum(["identity","albers","mercator"])}).passthrough(),
  extent:geographicExtent.optional(),
  zoom:z.number(),
  pan:z.tuple([z.number(),z.number()]),
  purpose:z.enum(["choropleth","locator"]).optional(),
  style:mapStyle,
}).passthrough();
export const selectorElementSchema = baseElement.extend({
  type:z.literal("selector"), label:textBinding, orientation:z.enum(["horizontal","vertical"]),
  swatchSize:z.number().nonnegative(), active:z.enum(["primary","comparison"]), style:fontStyle,
}).passthrough();
export const studioElementSchema = z.discriminatedUnion("type", [
  baseElement.extend({ type:z.literal("header"), title:textBinding, subtitle:textBinding, kicker:textBinding, identifier:textBinding }).passthrough(),
  mapElementSchema,
  baseElement.extend({ type:z.literal("results"), officeTitle:textBinding, electionLabel:textBinding }).passthrough(),
  baseElement.extend({ type:z.literal("inset"), label:textBinding, center:z.tuple([z.number(),z.number()]), geographicExtent:geographicExtent.optional(), scaleMode:z.enum(["independent","identical"]), labelStyle:fontStyle }).passthrough(),
  baseElement.extend({ type:z.literal("text"), text:textBinding, style:fontStyle, wrap:z.boolean() }).passthrough(),
  baseElement.extend({ type:z.literal("legend"), legendType:z.enum(["categorical","continuous","binned","winner-margin","manual","dataset"]), title:textBinding }).passthrough(),
  baseElement.extend({ type:z.literal("shape"), shape:z.enum(["line","rect","ellipse","arrow"]), fill:z.string(), stroke:z.string(), strokeWidth:z.number().nonnegative() }).passthrough(),
  selectorElementSchema,
]);

/** Optional value that may also arrive as JSON `null` (Python `None`); normalized to `undefined`. */
const optional = <T extends z.ZodTypeAny>(schema: T) => schema.nullish().transform(value => value ?? undefined);
const coordinateDepth: Record<string, number> = { Point:0, MultiPoint:1, LineString:1, MultiLineString:2, Polygon:2, MultiPolygon:3 };

function validCoordinates(value: unknown, depth: number): boolean {
  if (!Array.isArray(value)) return false;
  if (depth === 0) {
    if (value.length < 2) return false;
    for (const number of value) if (typeof number !== "number" || !Number.isFinite(number)) return false;
  } else {
    for (const child of value) if (!validCoordinates(child, depth - 1)) return false;
  }
  return true;
}

function validGeometry(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const geometry = value as Record<string, unknown>;
  if (geometry.type === "GeometryCollection") {
    if (Object.keys(geometry).some(key => key !== "type" && key !== "geometries" && key !== "bbox")) return false;
    if ("bbox" in geometry && (!Array.isArray(geometry.bbox) || geometry.bbox.some(value => typeof value !== "number" || !Number.isFinite(value)))) return false;
    return Array.isArray(geometry.geometries) && geometry.geometries.every(validGeometry);
  }
  if (typeof geometry.type !== "string" || typeof coordinateDepth[geometry.type] !== "number") return false;
  if (Object.keys(geometry).some(key => key !== "type" && key !== "coordinates")) return false;
  return (Array.isArray(geometry.coordinates) && geometry.coordinates.length === 0)
    || validCoordinates(geometry.coordinates, coordinateDepth[geometry.type]);
}

// Validate immutable coordinate arrays in place: recursive Zod unions created failed
// branches and copied millions of coordinates even when callers only needed validity.
const geometry = z.custom<unknown>(validGeometry, "Invalid GeoJSON geometry or coordinate nesting");
export const renderFeatureSchema = z.object({ type:z.literal("Feature"), id:z.union([z.string(),z.number()]).optional(), properties:z.record(z.string(),z.unknown()), geometry:geometry.nullable() }).strict();
export const countyBoundariesSchema = z.object({ type:z.literal("FeatureCollection"), features:z.array(renderFeatureSchema) }).passthrough();
export const derivedRecordSchema = z.object({ key:z.string(), totalVotes:z.number().nonnegative(), winnerId:optional(z.string()), runnerUpId:optional(z.string()), margin:optional(z.number()), values:z.record(z.string(),z.union([z.string(),z.number(),z.null()])), candidateVotes:z.record(z.string(),z.number().nonnegative()) }).passthrough();
export const diagnosticSchema = z.object({ severity:z.enum(["error","warning","info"]), code:z.string().min(1), message:z.string().min(1), count:z.number().nonnegative().optional(), records:z.array(z.record(z.string(),z.unknown())).optional(), fix:z.string().optional() }).strict();

const pageSchema = z.object({ width:z.number().positive(), height:z.number().positive(), unit:z.enum(["px","in","mm"]), dpi:z.number().positive(), background:z.string(), bleed:z.number().nonnegative(), safeMargin:z.number().nonnegative(), grid:z.object({enabled:z.boolean(),size:z.number().positive(),snap:z.boolean()}) });
const themeSchema = z.object({id:z.string(),name:z.string()}).passthrough();
const voteTotalsSchema = z.record(z.string(),z.number().nonnegative());
const auditCountsSchema = z.record(z.string(),z.number().int().nonnegative());
const provenanceSchema = z.array(z.object({path:z.string(),role:z.string(),sha256:z.string().regex(/^[0-9a-f]{64}$/i)}).passthrough());
const libraryMetadataSchema = z.object({
  matchMethod:optional(z.string()), provenance:provenanceSchema.optional(),
  results:z.object({path:z.string(),rows:z.number().int().nonnegative(),joined:z.number().int().nonnegative(),unmatched:z.number().int().nonnegative()}).passthrough().optional(),
  crosswalk:z.object({path:z.string(),rows:z.number().int().nonnegative(),accepted:z.number().int().nonnegative(),unmatched:z.number().int().nonnegative(),methods:auditCountsSchema.optional(),confidence:auditCountsSchema.optional(),relationships:auditCountsSchema.optional()}).passthrough().optional(),
  reconciliation:z.object({source:voteTotalsSchema,mapped:voteTotalsSchema,unmatched:voteTotalsSchema,preserved:voteTotalsSchema,coverage:z.record(z.string(),z.number().nonnegative().nullable()),note:optional(z.string()),sourceLabel:optional(z.string()),incompleteElection:z.boolean().optional()}).passthrough().optional(),
}).passthrough();
export const renderDataSchema = z.object({
  type:z.literal("FeatureCollection"),features:z.array(renderFeatureSchema),records:z.array(derivedRecordSchema),
  diagnostics:z.array(diagnosticSchema),bounds:z.tuple([z.number(),z.number(),z.number(),z.number()]).optional(),crs:z.string().optional(),
  sourceHashes:z.record(z.string(),z.string().regex(/^[0-9a-f]{64}$/i)).optional(),
  countyBoundaries:countyBoundariesSchema.optional(),
  library:libraryMetadataSchema.optional(),
}).passthrough();
export const datasetRefSchema = z.object({
  id:z.string(), label:z.string(), sourcePath:z.string(), matchStatus:z.string(), geometryVintage:z.string(),
  matchAudit:optional(z.string()), sourceHash:z.string(),
  matchMethod:optional(z.string()), resultsPath:optional(z.string()), crosswalkPath:optional(z.string()), provenance:provenanceSchema.optional(),
}).passthrough();

/** Election-independent design document: styles, frames and metadata bindings only. */
export const designSchema = z.object({
  kind:z.literal("design"), schemaVersion:z.literal(1), id:z.string().min(1), name:z.string().min(1), createdAt:z.string(),
  page:pageSchema, theme:themeSchema, elements:z.array(studioElementSchema),
  layoutId:z.enum(LAYOUT_IDS).optional(), themeId:z.string().optional(),
  candidateStyles:z.object({
    primary:z.array(z.object({slot:z.number().int().nonnegative(),color:hexColor,lightColor:hexColor.optional(),darkColor:hexColor.optional()})).optional(),
    comparison:z.array(z.object({slot:z.number().int().nonnegative(),color:hexColor,lightColor:hexColor.optional(),darkColor:hexColor.optional()})).optional(),
  }).optional(),
}).passthrough();

export const projectSchema: z.ZodType<unknown> = z.lazy(()=>z.object({
  schemaVersion:z.literal(1), id:z.string(), name:z.string(), modifiedAt:z.string(),
  metadata:z.object({ title:z.string(), subtitle:z.string(), office:z.string(), electionDate:z.string(), electionType:z.string(), jurisdiction:z.string(), source:z.string(), notes:z.array(z.string()) }),
  page:pageSchema,
  data:z.object({ candidates:z.array(z.object({id:z.string(),sourceNames:z.array(z.string()),displayName:z.string(),color:hexColor,lightColor:optional(hexColor),darkColor:optional(hexColor),visible:z.boolean(),order:z.number(),metadata:z.record(z.string(),z.union([z.string(),z.number(),z.boolean()])).optional()}).passthrough()) }).passthrough(),
  theme:themeSchema, elements:z.array(studioElementSchema),
  layoutId:z.string().optional(), themeId:z.string().optional(),
  dataset:datasetRefSchema.optional(),
  comparison:projectSchema.optional(),
  design:designSchema.optional(),
  renderData:renderDataSchema,
  export:z.object({formats:z.array(z.enum(["svg","png","pdf"])),textAsPaths:z.boolean(),embedMetadata:z.boolean()})
}).passthrough());

export function validateProject(value: unknown) { return projectSchema.safeParse(value); }
export function validateDesign(value: unknown) { return designSchema.safeParse(value); }
