from __future__ import annotations

import json
import struct
from pathlib import Path

import pytest

from server.audio_worker.framing import (
    FrameDecoder, FrameError, FrameKind, decode_u64_decimal, encode_frame, encode_u64_decimal,
)


def test_python_u64_codec_matches_handwritten_golden():
    path = Path(__file__).parent / "fixtures/worker-protocol-u64-golden.json"
    for case in json.loads(path.read_text("utf-8")):
        assert encode_u64_decimal(int(case["value"])) == case["wire"]
        assert decode_u64_decimal(case["wire"]) == int(case["value"])


@pytest.mark.parametrize("value", [1, -1, "+1", "01", "1e3", "1.0", " 1", "", "18446744073709551616"])
def test_u64_rejects_noncanonical_or_overflow(value):
    with pytest.raises(FrameError):
        decode_u64_decimal(value)


def test_partial_and_consecutive_frames_decode_without_declared_allocation():
    wire = encode_frame(FrameKind.JSON, {"type": "one"}) + encode_frame(FrameKind.PCM_MASTER, b"pcm")
    decoder = FrameDecoder()
    frames = []
    for byte in wire:
        frames.extend(decoder.feed(bytes([byte])))
    assert [frame.kind for frame in frames] == [FrameKind.JSON, FrameKind.PCM_MASTER]
    assert json.loads(frames[0].body) == {"type": "one"}
    assert frames[1].body == b"pcm"


def test_oversized_length_is_rejected_before_body_arrives():
    decoder = FrameDecoder()
    with pytest.raises(FrameError, match="IPC_FRAME_TOO_LARGE"):
        decoder.feed(struct.pack(">I", 0xFFFFFFFF) + bytes([FrameKind.JSON]))


@pytest.mark.parametrize("wire,reason", [(b"\0", "IPC_TRUNCATED_HEADER"),
                                           (struct.pack(">IB", 2, FrameKind.JSON) + b"x", "IPC_TRUNCATED_BODY")])
def test_eof_rejects_partial_header_or_body(wire, reason):
    decoder = FrameDecoder()
    decoder.feed(wire)
    with pytest.raises(FrameError, match=reason):
        decoder.eof()


def test_kind_and_per_kind_limits_are_enforced():
    with pytest.raises(FrameError, match="IPC_FRAME_KIND_INVALID"):
        FrameDecoder().feed(struct.pack(">IB", 0, 99))
    with pytest.raises(FrameError, match="IPC_FRAME_TOO_LARGE"):
        FrameDecoder(max_pcm_bytes=1).feed(struct.pack(">IB", 2, FrameKind.PCM_SPLIT))
