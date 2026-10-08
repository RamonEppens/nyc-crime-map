"""Small pure helpers of 08_streets.py: house numbers, blocks, display names."""
import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location("streets", HERE / "08_streets.py")
streets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(streets)


def test_house_numbers():
    assert streets.parse_hn("1234") == 1234
    assert streets.parse_hn("37-012") == 1_037_012
    assert streets.parse_hn("0") == -1 and streets.parse_hn(None) == -1 and streets.parse_hn("") == -1
    assert streets.block_of(357) == 300
    assert streets.block_of(1_037_012) == 1_037_000
    assert streets.block_of(-1) == -1


def test_display_names():
    assert streets.display_name("W 42 ST") == "West 42nd Street"
    assert streets.display_name("AVE OF THE AMERICAS") == "Avenue of the Americas"
    assert streets.display_name("ST MARKS PL") == "St Marks Place"
    assert streets.display_name("AVE S") == "Avenue S"
    assert streets.display_name("PARK AVE S") == "Park Avenue South"
    assert streets.display_name("FDR DR VIADUCT") == "FDR Drive Viaduct"
    assert streets.display_name("BCH 116 ST") == "Beach 116th Street"
    assert streets.display_name("E 111 ST") == "East 111th Street"
