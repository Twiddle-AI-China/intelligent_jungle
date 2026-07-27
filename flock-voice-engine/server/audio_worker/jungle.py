"""Frozen Python port of the browser Jungle address/grain planner."""
from __future__ import annotations

import math
from typing import Any

JUNGLE_PITCH_SEMITONES = (-7, -3, 0, 3, 7)
AMEN_TRANSIENT_STEPS = (0, 2, 4, 6, 7, 8, 10, 12, 14, 15, 16, 18, 20, 22, 24, 28)


def _number(value: Any, fallback: float) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return fallback
    return result if math.isfinite(result) else fallback


def reverse_amen_offset(duration: float, forward_offset: float, source_duration: float) -> float:
    total = max(0.001, _number(duration, 0.001))
    end = (_number(forward_offset, 0.0) + max(0.0, _number(source_duration, 0.0))) % total
    return (total - end) % total


def jungle_edit_plan(day=0, tension=0, onset_count=0, conflict_ratio=0,
                     pattern_similarity=0) -> dict[str, Any]:
    dense = _number(onset_count, 0) >= 8
    conflict = _number(conflict_ratio, 0) >= 0.05
    stale = _number(pattern_similarity, 0) >= 0.82
    t = _number(tension, 0)
    break_edit = "dropout" if dense and conflict else "repeat4" if stale and t >= .7 else \
        "repeat2" if stale or (dense and t >= .5) else "hold"
    tone_edit = "filter" if conflict else "reverse" if stale and t >= .75 else \
        "crush" if dense and t >= .6 else "dub" if int(_number(day, 0)) % 4 == 0 and t >= .4 else "clean"
    return {"breakEdit": break_edit, "toneEdit": tone_edit,
            "evidence": {"onsetCount": _number(onset_count, 0),
                         "conflictRatio": _number(conflict_ratio, 0),
                         "patternSimilarity": _number(pattern_similarity, 0), "tension": t}}


def jungle_slice_for_cell(pitch_branch_id=0, role_id=None, step_index=0, tension=.3,
                          master_bpm=60, tempo_multiplier=2,
                          amen_duration_seconds=2.742857142857143, amen_native_beats=8,
                          **aliases) -> dict[str, Any]:
    pitch_branch_id = aliases.get("pitchBranchId", pitch_branch_id)
    role_id = aliases.get("roleId", role_id)
    step_index = aliases.get("stepIndex", step_index)
    tension = aliases.get("tension", tension)
    master_bpm = aliases.get("masterBpm", master_bpm)
    tempo_multiplier = aliases.get("tempoMultiplier", tempo_multiplier)
    amen_duration_seconds = aliases.get("amenDurationSeconds", amen_duration_seconds)
    amen_native_beats = aliases.get("amenNativeBeats", amen_native_beats)
    requested = _number(pitch_branch_id, _number(role_id, 0))
    pitch_index = max(0, min(len(JUNGLE_PITCH_SEMITONES) - 1, math.trunc(requested)))
    step = max(0, math.trunc(_number(step_index, 0)))
    semitones = JUNGLE_PITCH_SEMITONES[pitch_index]
    jungle_bpm = max(1, _number(master_bpm, 60)) * max(1, _number(tempo_multiplier, 2))
    output_seconds = 60 / jungle_bpm
    native_beat_seconds = max(.001, _number(amen_duration_seconds, 2.742857142857143)) / max(
        1, _number(amen_native_beats, 8))
    pitch_rate = 2 ** (semitones / 12)
    tempo_rate = native_beat_seconds / output_seconds
    return {"amenStep": AMEN_TRANSIENT_STEPS[step % len(AMEN_TRANSIENT_STEPS)],
            "pitchIndex": pitch_index, "semitones": semitones, "jungleBpm": jungle_bpm,
            "nativeBeatSeconds": native_beat_seconds, "tempoRate": tempo_rate,
            "pitchRate": pitch_rate, "playbackRate": pitch_rate, "outputSeconds": output_seconds,
            "velocity": .92 + max(0, min(1, _number(tension, 0))) * .08}


def jungle_grain_plan(slice_value: dict[str, Any], grain_seconds=.1, overlap=.5, **aliases) -> list[dict[str, float]]:
    grain_seconds = aliases.get("grainSeconds", grain_seconds)
    total = max(.001, _number(slice_value.get("outputSeconds"), .5))
    grain = max(.02, min(total, _number(grain_seconds, .1)))
    overlap_ratio = max(.1, min(.8, _number(overlap, .5)))
    hop = grain * (1 - overlap_ratio)
    tempo_rate = max(.001, _number(slice_value.get("tempoRate"), 1))
    pitch_rate = max(.001, _number(slice_value.get("pitchRate"), 1))
    output = []
    offset = 0.0
    while offset < total - 1e-6:
        duration = min(grain, total - offset)
        output.append({"outputOffset": offset, "outputDuration": duration,
                       "sourceOffset": offset * tempo_rate,
                       "sourceTimelineDuration": duration * tempo_rate,
                       "sourceDuration": duration * pitch_rate, "playbackRate": pitch_rate})
        offset += hop
    return output
