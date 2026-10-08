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
