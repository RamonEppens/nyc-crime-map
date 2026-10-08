"""The pipeline's street-name key must match the browser's (web/tests/streetnames.test.mjs) for
every shared case in config/street_name_cases.json."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from streetnames import clave  # noqa: E402

CASES = json.loads((Path(__file__).resolve().parents[2] / "config" / "street_name_cases.json").read_text(encoding="utf-8"))["cases"]


def test_shared_cases():
    bad = [(i, clave(i), w) for i, w in CASES if clave(i) != w]
    assert not bad, bad
