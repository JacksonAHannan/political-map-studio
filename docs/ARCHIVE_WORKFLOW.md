# Political Map Studio

Political Map Studio is a layout editor and generator for **pre-matched election
results and precinct geography**. Matching and reconciliation happen upstream;
the editor changes presentation without rewriting votes, precinct records, or
source files.

Start with a published election, choose a reusable design, arrange and style the
page, then export. The library links existing publication previews to their
matched vector datasets; previews are references, not editable substitutes for
precinct geometry.

## Install and start

Requirements: Node 20+, Python 3.11+, `uv`, and system Cairo libraries.

```bash
cd political-map-studio
npm install
uv sync --extra test
```

Development uses two local processes:

```bash
uv run python -m uvicorn political_map_studio.app:app --reload --port 8000
npm run dev
```

Open <http://127.0.0.1:4173>. Studio starts with the matched-election library.
An existing autosave is offered for explicit recovery, never silently substituted
for your selection. Production:

```bash
npm run build
uv run python -m uvicorn political_map_studio.app:app --host 127.0.0.1 --port 8000
```

FastAPI serves the compiled `dist/` application when it exists.

## Editor workflow

1. **Election:** search by race, state, year, or matching status. Inspect the
   published preview, source, and geometry vintage, then open the matched data.
2. **Design:** choose a statewide, map/results, inset, comparison, or detail
   layout—or apply one of your saved designs. Comparison pages require a second
   actual library election.
3. **Edit:** use Design for page dimensions, appearance, saved designs, and
   metadata bindings. Use Element for precise frames, alignment, map styling,
   candidate colors, results panels, legends, and inset extents.
4. **Export:** download SVG, PNG, PDF, a portable design, or a self-contained map
   project. Batch SVG export applies one design to selected library elections.

Changing elections preserves the current design by default. Geography-specific
crops and insets are checked against the incoming dataset; compatibility notices
explain resets rather than silently retaining a crop of the wrong state.

Dataset information shows totals, coverage, matching diagnostics, source hashes,
and geometry vintage. Styling, layouts, and comparison views do not rematch data.
Records without drawable geometry remain in totals and are reported. Invalid
source geometries remain unchanged with a warning; repair them upstream.

The old GIS join tools remain under **Advanced → GIS import**, separate from the
normal layout workflow. To import a new race manually:

1. Open Advanced → GIS import.
2. Choose a local GeoJSON, GeoPackage, or zipped Shapefile and a CSV result file.
3. Enter the geography and result join-field names and select wide or long results.
4. Process the join. The original files are not modified. Processed geometry, derived values, hashes, CRS, and diagnostics are written into the current project.
5. Inspect every failed join in Diagnostics. No failed join is silently discarded.
6. Select candidates in the inspector to change names, visibility, ordering, or colors.
7. Select the map to control its encoding, shade range, no-data color, projection, clipping, and boundaries.
8. Drag and resize layers on the page. Reorder, lock, or hide them in Layers.
9. Select each inset to edit its extent, label, dimensions, and identical-scale group.
10. Save the project or export SVG, PNG, or PDF.

The canvas is the export page. Drag/resize positions are stored as exact document coordinates. Visual changes update SVG immediately and do not rerun the geospatial pipeline.

The current renderer supports winner color and winner-by-margin shading. Additional encodings listed in the roadmap are not accepted by the project validator until their renderers are implemented.

## Results formats

Wide format has one row per geography and one column per candidate. Candidate `sourceNames` or candidate IDs select vote columns.

```csv
precinct_id,Jones,Boyd,Flowers
001,120,80,20
```

Long format uses mapped candidate and vote fields:

```csv
precinct_id,candidate,votes
001,Jones,120
001,Boyd,80
```

## Datasets, reusable designs, and projects

- **Dataset:** matched geometry, candidate vote records, source SHA-256, matching
  status, and geometry vintage. Library entries supply this independently of the
  design.
- **Design (`*.design.json`):** page, theme, layout, metadata bindings, and visual
  style settings. It does not embed election records or geometry. Save designs
  in the browser or download them for reuse elsewhere.
- **Project (`*.pmap.json`):** dataset, resolved design, project-specific visual
  overrides, and an optional independent comparison election. It remains
  self-contained for reopening.
- **Candidate palette:** color settings transferred by stable candidate identity,
  then display-order slot when no identity matches. Designs use slots only.
  Verify the assigned colors after a transfer; names and votes are not replaced.

Use metadata bindings for titles, dates, offices, and sources that should follow
the selected election. Literal annotations remain deliberate project/design text.
SVG exports can embed dataset identities, source hashes, totals, coverage counts,
and diagnostics for the primary and comparison elections.

Page dimensions and element frames are pixel coordinates. Bleed expansion and
physical-unit conversion are not editor controls. Existing legacy templates and
theme assets remain available to the rendering tools.

Download the current project or design from Export. A project includes its matched
data; a design can be applied to a different election without replacing that data.

## Pre-matched election library

The local catalog in `library/catalog.json` contains 10 elections from Alabama,
Pennsylvania, and Tennessee across 2000–2026. It reuses the archive’s existing
precinct matching and allocation work, including:

- Alabama 2000 Amendment 2 and presidential returns allocated to Census 2000 VTDs.
- Alabama 2026 Democratic and Republican U.S. Senate primaries, using the existing
  crosswalk to 2024 congressional-split precinct geometry.
- Alabama 2006 Agriculture Commissioner, now retaining 13 unresolved source boxes
  and their 6,670 votes alongside the mapped returns.

Source GeoPackages, processed returns, and crosswalks remain authoritative.
Unmapped records remain in totals and diagnostics; display-inferred fills are not
imported as votes. Reconciliation distinguishes certified references from recovered
source totals: Alabama 2006 covers recovered boxes from 66 counties, not a complete
certified statewide result. Major-party-only entries are labeled accordingly.
Generated `.pmap.json` caches live under `.cache/library/`.

```bash
# Show available races and source availability
uv run political-map library-list

# Build serialized project caches before first use
uv run political-map library-warm
```

To register another pre-matched pair, add a catalog entry containing its state,
year, election, source GeoPackage/layer, unique precinct key, candidate vote
columns, geometry vintage, matching status, and optional audit. Separate processed
results and crosswalk CSVs use explicitly declared keys and columns; opening an
entry does not guess a schema or perform new fuzzy/spatial matching. Source paths,
hashes, matching provenance, coverage, and unresolved votes travel with the project.
An optional `preview` names a repository-relative published PNG/JPEG/WebP;
`previewLabel` distinguishes a multi-election reference from a single-race image.

The library serves cached JSON directly and uses 640-pixel thumbnails instead of
decoding publication-size previews. Cache invalidation is per entry and its source
files, including shapefile sidecars. First-time materialization still processes the
source geography. The renderer reuses bounded path/projection caches across visual
edits without simplifying source geometry; planar views omit only paths provably
outside the padded frame.

Layouts materialize theme defaults into element styles. Edit element typography and colors to change the current page without resetting its arrangement; reapply a layout to use new theme defaults.

## Keyboard shortcuts

- `Ctrl/Cmd+Z`: undo
- `Ctrl/Cmd+Shift+Z`: redo
- `Ctrl/Cmd+S`: save project
- `Ctrl/Cmd+D`: duplicate selected layer
- `Delete`: delete selected layer
- `Ctrl/Cmd++` / `Ctrl/Cmd+-`: canvas zoom

Autosave uses IndexedDB with immutable datasets stored separately from lightweight
project snapshots. Visual edits do not rewrite statewide geometry. Recovery checks
read only snapshot metadata; geometry loads after explicit Resume. Snapshot and
dataset updates are atomic, and legacy IndexedDB/localStorage autosaves migrate
safely. Explicit Save still downloads a self-contained project file; the browser
controls duplicate-file naming.

## Export and CLI

SVG is the canonical renderer output and retains paths and text. PNG and PDF are converted from the exact SVG through CairoSVG—not screenshots.

PNG dimensions equal the pixel canvas. PDF uses CairoSVG’s default 96 CSS pixels
per inch; changing project DPI does not change its physical page size.
Fonts resolve in the browser for preview and on the server for PNG/PDF, so use
fonts available in both environments. Text-to-path export, font embedding, and
bleed/crop marks are not implemented. SVG metadata is not retained by Cairo’s
PNG/PDF conversion; preserve the SVG or project alongside publication outputs.
Full-resolution conversion remains CPU-heavy: a large two-election comparison
took approximately 25 seconds for PNG and 31 seconds for PDF locally. API
conversions run off the request event loop and are serialized to bound memory use,
so library and health requests remain responsive.

```bash
uv run political-map render public/examples/alabama_demo.pmap.json \
  --output output/governor-primary.svg

uv run political-map render public/examples/alabama_demo.pmap.json \
  --output output/governor-primary.png
```

Template materialization uses the same import processor and renderer:

```bash
uv run political-map render-template public/templates/alabama_editorial.json \
  --results sample-data/results-wide.csv \
  --geography sample-data/precincts.geojson \
  --metadata sample-data/election.json \
  --output output/example.pdf
```

## Tests

```bash
npm test
uv run --extra test python -m pytest tests/backend -q
```

Tests cover election derivation, candidate totals, color interpolation, project validation and history, join diagnostics, geographic bounds/CRS, API health, and export behavior. SVG output is checked through the shared command-line renderer.

See [docs/PROJECT_SCHEMA.md](docs/PROJECT_SCHEMA.md) for the document contract and [ROADMAP.md](ROADMAP.md) for deliberately deferred work.
