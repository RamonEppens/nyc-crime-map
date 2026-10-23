# NYC Crime Map

An interactive map of the complaints reported to the NYPD from 2016 to 2025, built on
[NYPD Complaint Data Historic](https://data.cityofnewyork.us/d/qgea-i56i) from
[NYC Open Data](https://opendata.cityofnewyork.us/).

**Live map:** https://ramoneppens.github.io/nyc-crime-map/

Search an address, a street, a neighborhood or a precinct and see what was reported there, how it
compares with the rest of the city and how it changed over ten years. Filter by dates and by 18
types of offense. Zoom in to see each location where the NYPD placed complaints.

## Why
I built this as a personal project, but it started two years ago. For a university project, I made a
scrollytelling piece about New York's 311 complaints, the things New Yorkers call the city about. It
was the first time I looked at a whole city through what its people report. What stayed with me was
how plainly it showed inequality: counted per resident, some parts of the city reported far more
problems than others. A few simple numbers made the city's social divides hard to ignore. I was left
wanting more than a story you scroll through once.

This year I started working on a newspaper's data team in Buenos Aires, where I've been building
maps of my own city's complaints, block by block, with a search by address. That work changed how I
think about data. On a map you start from your own street, and the numbers stop being abstract. What
better and more reliable way to understand data than a map?

I'm finishing my degree in data science, and this is the project I wanted to close it with: going
back to New York, now with ten years of NYPD complaints and everything I've learned since. I want
people to understand where they live, how they live and how it changes through time.

Ramón Eppens

## What the map is careful about
- **Complaints, not crimes.** A complaint is a report taken by the NYPD, not an arrest or a
  conviction. The map never calls a place safe or dangerous.
- **Locations are rounded** by the NYPD to the middle of the block or the nearest intersection.
- **Withheld locations.** Rape and other sex crimes are placed at the precinct station house by the
  NYPD; they are counted in precinct, borough and city totals but never drawn on the map.
- **Rates per resident** use the 2020 Census; places with fewer than 2,000 residents are not rated.
- **No suspect or victim demographics** anywhere.

The full explanation is on the map's [About this data](https://ramoneppens.github.io/nyc-crime-map/about.html) page.

## Checked against the NYPD
The data is compared with the NYPD's CompStat figures for the seven major felonies. Citywide totals
are within 0.7% of CompStat in every year from 2016 to 2025, and 97% of precinct-years are within 2%.
Details: [`docs/validation/VALIDATION.md`](docs/validation/VALIDATION.md).

## Data
All from NYC Open Data, plus 2020 Census population (U.S. Census Bureau API):

| Dataset | Used for |
|---|---|
| [NYPD Complaint Data Historic](https://data.cityofnewyork.us/d/qgea-i56i) (`qgea-i56i`) | The complaints (snapshot of April 28, 2026) |
| [2020 Neighborhood Tabulation Areas](https://data.cityofnewyork.us/d/9nt8-h7nd) (`9nt8-h7nd`) | Neighborhoods |
| [Police Precincts](https://data.cityofnewyork.us/d/y76i-bdw7) (`y76i-bdw7`) | Precincts |
| [NYC Street Centerline (CSCL)](https://data.cityofnewyork.us/d/inkn-q76z) (`inkn-q76z`) | Streets, blocks, address search |
| [2020 Census Blocks](https://data.cityofnewyork.us/d/wmsu-5muw) (`wmsu-5muw`) | Residents per precinct |
| [2020 Census Tracts](https://data.cityofnewyork.us/d/63ge-mke6) (`63ge-mke6`) | Residents per neighborhood |

## How it works
| Folder | Contents |
|---|---|
| `pipeline/` | Python scripts that download, clean, check and summarize the data |
| `web/` | The map: Vite, MapLibre GL, deck.gl and DuckDB-WASM, which runs every query in the browser |
| `docs/` | [Decision log](docs/DECISIONS.md), [data notes](docs/DATA_NOTES.md), the data audit and the validation |

Every choice (what to count, how offenses are grouped, how places are compared, colors, layout) is
written down with its reason in [`docs/DECISIONS.md`](docs/DECISIONS.md).

I wrote the code with the help of Claude Code, an AI coding assistant. The decisions are mine, and
each one is in the decision log.

## Reproduce
Requires [uv](https://docs.astral.sh/uv/) and Node.js.
```
cd pipeline
uv sync
uv run scripts/01_download.py          # ~10M rows from the SODA API; resumable
uv run scripts/02_audit.py
uv run scripts/03_clean.py
uv run scripts/04_reference.py
uv run scripts/05_geography.py
uv run scripts/06_validate.py
uv run scripts/07_web_data.py
uv run scripts/08_download_streets.py  # network: street centerline, census blocks
uv run scripts/08_streets.py
uv run scripts/09_charts.py
uv run pytest

cd ../web
npm install
npm run fetch:duckdb-ext
npm run dev                            # http://localhost:5173
```
Tests (from `web/`, with `npm run dev` and `python tests/sql_server.py ../data/web 8765` running):
`npm run test:smoke`, `node tests/a11y.mjs` (accessibility) and `node tests/sweep.mjs depth`
(every kind of selection, period and offense filter, checked for wrong values, overflowing text and
overlapping labels).

## Credit
Data: NYC Open Data / NYPD. Base map © [CARTO](https://carto.com/attributions), map data ©
[OpenStreetMap](https://www.openstreetmap.org/copyright) contributors. Fonts: Newsreader and
Schibsted Grotesk (SIL Open Font License).

This is an independent project, not affiliated with or endorsed by the City of New York or the NYPD.

## License
Code: MIT (see `LICENSE`).
