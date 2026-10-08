"""Street-name key (clave): the ONE normalization used for official street names (pipeline) and
for what people type (browser, web/src/streetnames.js). Both must give the same key for every case
in config/street_name_cases.json (tested on both sides).

Steps: strip accents and anything in parentheses; uppercase; 42ND -> 42, FIFTH -> 5; punctuation
-> space (apostrophes vanish: MARK'S -> MARKS); expand abbreviations (some depend on position:
ST is SAINT first and STREET last, DR is DOCTOR first and DRIVE elsewhere, a leading E/W/N/S is a
direction but AVENUE S stays a letter); drop OF and THE.
"""
from __future__ import annotations

import re
import unicodedata

ORDINAL_WORDS = {
    "FIRST": "1", "SECOND": "2", "THIRD": "3", "FOURTH": "4", "FIFTH": "5", "SIXTH": "6",
    "SEVENTH": "7", "EIGHTH": "8", "NINTH": "9", "TENTH": "10", "ELEVENTH": "11", "TWELFTH": "12",
}
ABBREV = {
    "AVE": "AVENUE", "AV": "AVENUE", "AVENU": "AVENUE", "BLVD": "BOULEVARD", "BL": "BOULEVARD",
    "PL": "PLACE", "PKWY": "PARKWAY", "PKY": "PARKWAY", "EXPY": "EXPRESSWAY", "EXPWY": "EXPRESSWAY",
    "EXWY": "EXPRESSWAY", "HWY": "HIGHWAY", "TPKE": "TURNPIKE", "TPK": "TURNPIKE", "RD": "ROAD",
    "LN": "LANE", "CT": "COURT", "TER": "TERRACE", "TERR": "TERRACE", "SQ": "SQUARE", "CIR": "CIRCLE",
    "HTS": "HEIGHTS", "MT": "MOUNT", "FT": "FORT", "JR": "JUNIOR", "BRG": "BRIDGE", "PLZ": "PLAZA",
    "CRES": "CRESCENT", "STS": "STREETS", "WY": "WAY", "CONC": "CONCOURSE",
    "TUNL": "TUNNEL", "TNNL": "TUNNEL", "ALY": "ALLEY", "DRV": "DRIVE", "GDNS": "GARDENS", "BRDG": "BRIDGE", "BDWK": "BOARDWALK", "BCH": "BEACH",
}
DIRECTIONS = {"E": "EAST", "W": "WEST", "N": "NORTH", "S": "SOUTH"}
FILLER = {"OF", "THE"}
_ORD = re.compile(r"^(\d+)(ST|ND|RD|TH)$")


def clave(text: str) -> str:
    s = unicodedata.normalize("NFD", text)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = re.sub(r"\([^)]*\)", " ", s).upper()
    s = re.sub(r"['’]", "", s)
    words = re.sub(r"[^A-Z0-9]+", " ", s).split()
    out = []
    last = len(words) - 1
    for i, w in enumerate(words):
        m = _ORD.match(w)
        if m:
            w = m.group(1)
        elif w in ORDINAL_WORDS:
            w = ORDINAL_WORDS[w]
        elif w == "ST":
            w = "STREET" if i == last and i > 0 else "SAINT"
        elif w == "DR":
            w = "DOCTOR" if i == 0 and last > 0 else "DRIVE"
        elif w in DIRECTIONS and ((i == 0 and last > 0) or (i == last and i >= 2)):
            w = DIRECTIONS[w]               # W 42 ST, PARK AVE S; but AVENUE S stays a letter
        else:
            w = ABBREV.get(w, w)
        if w not in FILLER:
            out.append(w)
    return " ".join(out)
