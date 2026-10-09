# NYC Crime Map

An interactive map for exploring crimes reported to the NYPD, built on
[NYPD Complaint Data Historic](https://data.cityofnewyork.us/Public-Safety/NYPD-Complaint-Data-Historic/qgea-i56i)
from [NYC Open Data](https://opendata.cityofnewyork.us/).

> **Status:** early development (data audit phase).

## Goals
- Help New Yorkers see what has been reported around them, at the scale of a block, a street or a neighborhood.
- Be honest about the data: what a complaint is, what is missing, and where locations are approximate.
- Keep everything open: code, methodology and every design decision.

## Repository
| Folder | Contents |
|---|---|
| `pipeline/` | Python scripts that download, audit and process the data |
| `web/` | The map (coming soon) |
| `docs/` | Decisions, data notes and the generated data audit |

## Reproduce
Requires [uv](https://docs.astral.sh/uv/).
```
cd pipeline
uv sync
uv run scripts/01_download.py
uv run scripts/02_audit.py
uv run scripts/03_clean.py
uv run scripts/04_reference.py
uv run scripts/05_geography.py
uv run scripts/06_validate.py
uv run scripts/07_web_data.py
uv run scripts/08_download_streets.py   # network: street centerline, census blocks
uv run scripts/08_streets.py
uv run scripts/09_charts.py
```

## Data & credit
Data: NYC Open Data / NYPD. This is an independent project and is not affiliated with or endorsed
by the City of New York or the NYPD.

## License
Code: MIT (see `LICENSE`).
