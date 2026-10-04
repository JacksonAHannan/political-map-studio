# Political Map project schema

`*.pmap.json` is a self-contained election project. `schemaVersion` is currently `1`; `*.design.json` is a separate reusable visual document. Unknown extension fields are preserved by the project validator.

## Top-level separation

| Key | Purpose |
|---|---|
| `metadata` | Election labels, date, jurisdiction, source, notes |
| `dataset` | Library identity, source paths/hashes, matching method/status, geometry vintage, optional audit and provenance |
| `page` | Export dimensions, units, DPI, background, bleed, grid |
| `data` | Source references, join mapping, field mapping, candidates |
| `theme` | Layout-default color, typography, and border tokens |
| `elements` | Ordered deterministic page-layer documents |
| `renderData` | Matched features, derived records, optional county outlines, diagnostics, source hashes, optional library reconciliation |
| `comparison` | Optional independent election project; comparison-bound elements draw from its data |
| `design` | Applied reusable design snapshot; current page/theme/elements hold subsequent project overrides |
| `export` | SVG metadata policy and legacy export preferences; GUI format buttons select the actual output |

External `layoutId` and `themeId` identify reusable assets; resolved values are also stored in a project so reopening remains deterministic.

## Reusable designs

A design contains `kind: "design"`, `schemaVersion: 1`, identity/name/date, page, theme,
elements, optional layout/theme IDs, and optional `candidateStyles`. Candidate styles
contain zero-based display-order slots and color endpoints for `primary` and
`comparison`; they never carry candidate names or vote records. A transfer notice
asks the editor to verify slot assignments for the incoming election.

Applying a design does not replace election metadata, source references, matched
records, geometry, or provenance. Crop/inset extents are checked against the
element’s assigned dataset. Incompatible windows are reset with a notice.

Text tokens such as `{{metadata.title}}`, `{{metadata.office}}`, `{{year}}`,
`{{metadata.source}}`, and `{{metadata.notes}}` are retained in the design and bound
when rendering. Literal text is intentionally retained as written.

## Coordinates

Page dimensions and element frames use pixel coordinates, not CSS percentages. Every frame has `x`, `y`, `width`, and `height`; dragging, resizing, and alignment commit exact coordinates. PNG retains the pixel canvas. PDF uses CairoSVG’s default 96 CSS pixels per inch, independently of project DPI. Legacy `unit` and `bleed` fields do not expand or convert the canvas.

## Candidates

Candidate IDs are stable internal keys. `sourceNames` contains import aliases; `displayName` can change without breaking joins. Color endpoints, order, visibility, and metadata travel with the candidate definition.

## Render data

Each feature receives a normalized `properties.__joinKey`. Derived records contain
a unique `key`, per-candidate votes, total, winner, runner-up, and margin. Matched
records use the corresponding feature key. Unresolved source records can exist
without a feature; collision-safe synthetic keys preserve their original
`sourceKey`. These records contribute to candidate totals, not drawable coverage.

`renderData` is immutable after loading. Visual edits retain its reference, allowing
validation, rendering, history, and persistence to reuse geometry safely. Reimport
replaces it only after diagnostics are produced. IndexedDB privately stores datasets
separately from snapshots; this does not change the self-contained public project
format or `schemaVersion`.

Missing/empty geometry records remain in the dataset and vote totals. Invalid
geometry is reported rather than repaired during library loading. County outlines
are derived only from an explicit source county field. A rendering-only spherical
ring adapter accommodates GeoJSON winding without modifying matched coordinates.

Optional `renderData.library` metadata records the matching method, results and
crosswalk paths, provenance, audit counts/confidence, and reconciliation. Each
candidate’s reconciliation distinguishes source-reference, recovered, mapped, and
unmatched votes. `sourceLabel` identifies the reference; `incompleteElection` marks
incomplete recovered returns. A shortfall against certified totals is not filled
with invented votes, and recovered-box totals are not presented as certified.

SVG metadata can include both elections’ identities, candidate totals, drawable
feature and unmapped-record/vote counts, diagnostics, source hashes, geometry
vintages, matching provenance, and reconciliation. Cairo conversion does not carry
this metadata into PNG/PDF; keep the SVG or project for provenance.

## Elements

All elements share identity, frame, visibility, lock, opacity, z-index, background, border, and optional `dataset: "primary" | "comparison"` assignment. Omitted dataset means primary. Typed extensions configure:

- `header`: four independent text roles and styles
- `map`: projection, extent, pan/zoom, and cartographic style; schema version 1 accepts `winner` and `winner-margin` modes
- `results`: columns, formatting, rows, typography, and mini ramps
- `inset`: geographic extent, scale mode/group, label, and style overrides
- `legend`: categorical/continuous/binned/winner-margin/manual grammar
- `text`: arbitrary source, note, label, or annotation text
- `shape`: lines, rectangles, ellipses, and arrows
- `selector`: primary/comparison jurisdiction/date key and interactive dataset selection

Inset extents are geographic coordinate windows. `scaleMode: "identical"` and a
shared `scaleGroup` use one fitting scale across the group, including unequal
frames. Presets use independent fitting for differently shaped windows. A map with
`purpose: "locator"` draws an overview and the detail map’s extent.

## Validation and migration

The GUI validates with Zod before applying raw JSON. Geometry validation checks
type-directed coordinate nesting and finite values without cloning coordinates;
subsequent validation still detects mutated invalid geometry. Python validates API
inputs, preserves declared source keys, rejects malformed votes, and never mutates
source files. Future schema versions will be upgraded by explicit pure migration
functions and retain the pre-migration file for recovery.
