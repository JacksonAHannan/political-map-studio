# Public snapshot verification

Checked October 3, 2026 in an isolated publication copy.

| Command/check | Result |
| --- | --- |
| `npm ci` | Lockfile install succeeded |
| `uv sync --extra test --locked` | Python environment installed |
| `npm test` | 16 frontend tests passed |
| `uv run --extra test python -m pytest tests/backend -q` | 16 passed; 3 external-archive integration tests skipped |
| `npm run build` | TypeScript, Vite production and shared CLI renderer builds succeeded |
| `npm audit --audit-level=high` | 0 reported vulnerabilities after updating locked undici |
| `uv run political-map render-template … --output docs/demo.png` | Synthetic PNG exported successfully |
| Live Chromium check via Playwright | Opened bundled library, selected Results spread design, opened editor, drew 9 SVG paths, downloaded SVG; no browser page errors |

The build reports a JavaScript bundle larger than 500 kB; no load-time or performance
claim is made. Original ten-election archive inputs remain excluded. The three
integration tests retain their assertions and run only when that archive catalog
and datasets are present; temporary-fixture tests still exercise vote conservation,
unmatched records, malformed returns, CRS handling, previews and cache invalidation.

Publication adaptations: source root defaults to this checkout with an optional
`ELECTION_MAPS_ROOT` override; bundled library uses fictional data; Pillow is an
explicit dependency; synthetic template margin ticks use fractions consistently
with the renderer; demo titles/candidates are labeled synthetic. Original working
project files were not modified. Real source paths and integration instructions
remain documented in `archive-catalog.json` and `ARCHIVE_WORKFLOW.md`.
