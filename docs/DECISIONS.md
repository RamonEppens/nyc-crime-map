# Decisions

Each entry: what was decided, why, and when. Newest last.

| # | Date | Decision | Why |
|---|---|---|---|
| 1 | 2026-10-07 | Source: NYPD Complaint Data Historic (`qgea-i56i`), pulled by script through the SODA API into raw Parquet. The browser never calls the API. | Reproducible snapshot; 10M rows are too many for live API use. |
| 2 | 2026-10-07 | Window: report years 2016–2025 (confirmed after audit). Current YTD dataset (`5uac-w243`) maybe later as a labeled preliminary layer. | Before 2016, thousands of rows/year lack an offense description; complete years make fair comparisons. |
| 3 | 2026-10-07 | No suspect/victim demographics shown. | Risk of stigmatizing communities; not needed for the resident use case. |
| 4 | 2026-10-07 | Write the code from scratch; reuse methodology ideas from the Buenos Aires map. | Clean, purpose-built codebase. |
| 5 | 2026-10-07 | No NYC logo or nyc.gov look-alike branding. Credit line + dataset links instead. | The logo signals official City content; this is an independent project. |
| 6 | 2026-10-07 | Tools: VS Code + Claude Code for code; GitHub (public) for the repo. | Gallery rubric values open, understandable source code. |
| 7 | 2026-10-07 | Hosting: app on GitHub Pages; large data files on Cloudflare R2. | GitHub's 100 MB file limit; R2 supports HTTP Range requests with free egress. |
| 8 | 2026-10-07 | Positioning: the honest guide to this dataset. Primary audience residents, secondary journalists. | Rubric rewards value added to the dataset and uniqueness; no crime map is in the gallery yet. |
| 9 | 2026-10-07 | English only; WCAG 2.1 AA. | Gallery requirement / public-sector expectation. |
| 10 | 2026-10-07 | No fixed submission date; quality first. | — |
| 11 | 2026-10-07 | Count complaints by report date; use occurrence time only for time-of-day views. | Report date is complete and is how the dataset is published. |
| 12 | 2026-10-07 | Rape/sex crimes, sexual-exploitation offenses and everything on the same station-house points → `precinct_only`: counted in precinct/borough/city totals, never drawn as a place. | NYPD places these at the precinct station house (128 points, each 100% one precinct); drawing them would mislead. |
| 13 | 2026-10-07 | Own offense categories (18) built on the stable key code `ky_cd` (`pipeline/config/`), grouped into person / property / enforcement-driven / other. | Labels changed in 2024; enforcement-driven counts reflect police activity. |
| 14 | 2026-10-07 | Map unit is the snapped location (sized by count), not one dot per incident. | ~500k complaints/year sit on ~70k points. |
| 15 | 2026-10-07 | Duplicate complaint IDs: keep one row (earliest report). | 1,106 IDs (0.01%), only 2 inside the window. |
| 16 | 2026-10-07 | Precinct statistics use NYPD's precinct field; neighborhood statistics use the 2020 NTA polygon containing each point. | The field is what CompStat uses (validated); polygons give stable neighborhoods. |
| 17 | 2026-10-07 | Validate every release against NYPD CompStat (seven major felonies, citywide and by precinct). | Proves the pipeline reproduces official numbers; differences are documented. |
| 18 | 2026-10-07 | ~~Hex grid: H3 resolution 9 with resolution-8 parents.~~ Superseded by #24. | Standard grid (joins other datasets), native in deck.gl; size close to the Buenos Aires grid. |
| 19 | 2026-10-07 | Web data = static Parquet + GeoJSON in `data/web/`, spatially sorted (Hilbert) with 16k-row groups; served from R2. | DuckDB-WASM reads only the row groups it needs via HTTP Range requests. |
| 20 | 2026-10-07 | Visual identity: Ramón's own Statue of Liberty logo; brand green #42A872 for interface only (text #2A7D53 in light mode for contrast); data palette from the project chart. | Green on a crime map would read as "safe"; WCAG AA. |
| 21 | 2026-10-07 | Points (zoomed in) colored by 4 offense groups, not 18 categories. (The original sky → pink hexagon ramp is superseded by #25.) | 18 colors cannot be told apart. |
| 22 | 2026-10-07 | ~~Superseded by #26.~~ Basemap: OpenFreeMap "Liberty" (light) and the same style recolored to navy (dark), both tilted in 3D; decluttered (no shields, arrows, POI icons). | Matches the chosen references; free, no API key. Self-hosted NYC tiles on R2 later for resilience. |
| 23 | 2026-10-07 | Fonts self-hosted (Public Sans only, chosen 2026-10-07); DuckDB Parquet extension self-hosted. | No third-party requests at runtime (privacy, reliability). |
| 24 | 2026-10-07 | Hex grid: own 180 m pointy-top axial grid in local meters (origin -73.95, 40.73; `pipeline/scripts/hexgrid.py`), parameters shipped in `meta.json`; drawn with deck.gl ColumnLayer (radius = side, angle 90, coverage 1). Only hexagons with complaints exist. | Hexagons tile edge to edge with no gaps; same recipe as the Buenos Aires map; grid and data can never disagree. |
| 25 | 2026-10-07 | Hexagon color: single-hue blue ramp, 6 classes, quantile breaks over the hexagons in view (recomputed on every move, legend follows). Dark: #10263d → #2f78b3; light: #cfe0f0 → #154f80. Height linear in n / max (tallest 2.2 km). | Sequential single hue reads as "more"; viewport breaks keep contrast at every zoom. |
| 26 | 2026-10-07 | Basemap: CARTO dark-matter (dark) and positron (light), unmodified. View: pitch 45, bearing -12, zoom 11 on Manhattan/Brooklyn. | Chosen to match the Buenos Aires map. Check CARTO's basemap terms before launch. |
| 27 | 2026-10-07 | Zoom 12.5 → 13.7: columns sink ((1-m)^1.6) and fade ((1-m)^1.3) while complaint locations fade in (one dot per snapped location, area by count, color by most frequent offense group). | Smooth hand-off from density to locations; dots are locations, not individual complaints (#14). |
| 28 | 2026-10-08 | Controls as separate blocks floating over the map (left: brand, Date range, Offense types; top right: legend), each with Hide/Show. Night/Light switch as a pill at the bottom left. | Ramón's reference layout; the map gets the full width. |
| 29 | 2026-10-08 | Date modes: single year, single month, same month every year (seasonality), year range, month range. "vs" compares a year or month with the same period one year earlier and a range with the range right before it. | Comparing with the previous month would mix seasonality into the change. |
| 30 | 2026-10-08 | Offense filter per category (18), grouped under their 4 groups, with "only", All and None. | Residents look for a specific offense; groups keep the list readable. |
