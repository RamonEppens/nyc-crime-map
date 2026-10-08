# CLAUDE.md — NYC Crime Map

Context for Claude Code working in this repo. Read before making changes.

## What this is
An interactive, resident-focused map of NYPD complaint data (NYC Open Data dataset
`qgea-i56i`), built to be submitted to the NYC Open Data Project Gallery. Secondary audience:
journalists. Solo project by Ramón Eppens. English only.

Positioning: **the honest guide to this dataset**. The map is the hook; the value is making
the data understandable, including its limits (coordinate jitter, withheld locations,
report vs occurrence dates, category changes, gaps vs CompStat).

## Non-negotiables
- **Reports, not risk.** Counts are complaints reported to NYPD. Never label places "dangerous"
  or "safe". No severity weighting.
- **No suspect/victim demographics** anywhere in the UI, rankings or exports.
- **No NYC logo and no imitation of nyc.gov branding.** Credit: "Data: NYC Open Data / NYPD",
  with links to the dataset.
- **Show the uncertainty.** Incidents without coordinates count in totals and are shown as
  "N without location". Stacked/snapped coordinates are explained, not hidden.
- **Clean-room code.** Do not copy code from other projects; methodology ideas are fine.
- **Accessibility:** WCAG 2.1 AA (contrast, keyboard, screen-reader labels, colorblind-safe palettes).
- **Ramón decides.** Explain trade-offs and propose; don't silently make product or
  methodology decisions. Log decisions in `docs/DECISIONS.md`.

## Layout
- `pipeline/` — Python (uv). Numbered scripts in `pipeline/scripts/`, tests in `pipeline/tests/`.
- `web/` — frontend (Vite, vanilla JS, MapLibre + deck.gl + DuckDB-WASM). Not started yet.
- `docs/` — DECISIONS.md, DATA_NOTES.md (interpretation), audit/ (generated report).
- `data/` — never committed. `data/raw/` is the untouched snapshot; derived files go elsewhere.

## Commands
```
cd pipeline
uv sync                              # install deps
uv run scripts/01_download.py        # snapshot from the SODA API (~10M rows; resumable)
uv run scripts/02_audit.py           # writes docs/audit/AUDIT_REPORT.md
uv run scripts/03_clean.py           # data/clean/complaints.parquet (rules in DATA_NOTES.md)
uv run pytest                        # tests
```

## Data conventions
- Raw snapshot keeps every column as text, untouched. All parsing/cleaning happens downstream
  and is documented in DATA_NOTES.md.
- Record the dataset `rowsUpdatedAt` with every derived output.
- Analysis window: report years 2016–2025, counted by report date.
- `location_type = 'precinct_only'` rows are never drawn on the map or used in small-area stats.
- Offense categories come only from `pipeline/config/` (keyed on `ky_cd`).
- Every number shown in the UI must be reproducible from the pipeline.
