# Roadmap

Studio now provides a library-first editor, reusable designs, five layout presets,
independent comparison elections, saved palettes, and batch SVG generation.
The renderer supports winner color and winner-by-margin shading; the additional
encodings below remain unavailable in project files.

## High priority

- Guided column-mapping wizard with CSV previews and automatic type suggestions
- Theme inheritance diff views and a dedicated palette library manager
- Multi-selection distribution, visible guide dragging, and percentage inputs
- Interactive “draw inset extent” tool linked to the main map
- Installed-system-font discovery endpoint and missing-font substitution UI
- Column drag/reorder and arbitrary custom fields in results panels
- County-boundary and label layer import separate from precinct geometry
- GeoPackage layer chooser and multi-file Shapefile drop zone
- TopoJSON backend processing and configurable topology-preserving simplification
- Project migration registry, recovery browser, named snapshots, and autosave versions

## Cartographic expansion

- Additional county, legislative, and congressional publication templates
- Swing, turnout, residual/overperformance, and bivariate encodings
- Synchronized small multiples beyond the two-election comparison layout
- Collision-aware county/city/precinct labels with halos and scale thresholds
- Symbol, dot-density, proportional-marker, route, and callout layers
- Image/logo insertion and custom SVG shape library
- Election-night data refresh with immutable timestamped snapshots
- Animation timeline and video/SVG animation export

## Production hardening

- Worker-based browser geometry parsing and viewport-level path virtualization
- Configurable preview simplification with original-geometry export
- Font embedding/licensing checks and text-to-path export
- PDF preflight, bleed/crop marks, CMYK profiles, and print presets
- Plugin API for custom expressions, derived variables, importers, and components
- Visual SVG snapshot corpus across browsers and OS font environments
- Signed project bundles containing data, fonts metadata, and provenance manifests
