from __future__ import annotations

import json
from pathlib import Path
import pytest

from server.audio_worker.jungle import jungle_edit_plan, jungle_grain_plan, jungle_slice_for_cell

FIXTURE = Path(__file__).parent / "fixtures/jungle_v1.json"


@pytest.mark.parametrize("case", json.loads(FIXTURE.read_text())["cases"])
def test_python_jungle_matches_frozen_browser_case(case):
    assert jungle_slice_for_cell(**case["input"]) == case["slice"]
    assert jungle_grain_plan(case["slice"], **case["grainOptions"]) == case["grains"]


@pytest.mark.parametrize("case", json.loads(FIXTURE.read_text())["edits"])
def test_python_edit_plan_matches_frozen_browser_case(case):
    aliases = {"onset_count": case["input"]["onsetCount"],
               "conflict_ratio": case["input"]["conflictRatio"],
               "pattern_similarity": case["input"]["patternSimilarity"]}
    assert jungle_edit_plan(day=case["input"]["day"], tension=case["input"]["tension"], **aliases) == case["output"]
