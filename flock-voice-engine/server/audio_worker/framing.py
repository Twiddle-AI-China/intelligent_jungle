"""私有 UDS IPC v1 framing 与 canonical u64 codec。"""
from __future__ import annotations

import json
import struct
from dataclasses import dataclass
from enum import IntEnum

MAX_JSON_BYTES = 1_048_576
MAX_PCM_BYTES = 4_194_304
U64_MAX = (1 << 64) - 1


class FrameKind(IntEnum):
    JSON = 1
    PCM_MASTER = 2
    PCM_SPLIT = 3


class FrameError(RuntimeError):
    pass


@dataclass(frozen=True)
class Frame:
    kind: FrameKind
    body: bytes


def encode_u64_decimal(value: int) -> str:
    if type(value) is not int or not 0 <= value <= U64_MAX:
        raise FrameError("U64_OUT_OF_RANGE")
    return str(value)


def decode_u64_decimal(value: object) -> int:
    if not isinstance(value, str) or not value or (value != "0" and (value.startswith("0") or not value.isascii())):
        raise FrameError("U64_DECIMAL_INVALID")
    if not value.isdigit():
        raise FrameError("U64_DECIMAL_INVALID")
    decoded = int(value)
    if decoded > U64_MAX:
        raise FrameError("U64_OUT_OF_RANGE")
    return decoded


def encode_frame(kind: FrameKind | int, body: object) -> bytes:
    try:
        frame_kind = FrameKind(kind)
    except ValueError as exc:
        raise FrameError("IPC_FRAME_KIND_INVALID") from exc
    if frame_kind is FrameKind.JSON:
        payload = json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    elif isinstance(body, (bytes, bytearray, memoryview)):
        payload = bytes(body)
    else:
        raise FrameError("IPC_FRAME_BODY_INVALID")
    limit = MAX_JSON_BYTES if frame_kind is FrameKind.JSON else MAX_PCM_BYTES
    if len(payload) > limit:
        raise FrameError("IPC_FRAME_TOO_LARGE")
    return struct.pack(">IB", len(payload), frame_kind) + payload


def encode_pcm_body(render_frame: int, frame_count: int, channels: int, payload: bytes) -> bytes:
    encode_u64_decimal(render_frame)
    if not 0 < frame_count <= 0xFFFFFFFF or not 0 < channels <= 0xFFFF:
        raise FrameError("IPC_PCM_HEADER_INVALID")
    expected = frame_count * channels * 4
    if len(payload) != expected:
        raise FrameError("IPC_PCM_PAYLOAD_SIZE_MISMATCH")
    return struct.pack("<QIHH", render_frame, frame_count, channels, 1) + payload


class FrameDecoder:
    def __init__(self, max_json_bytes: int = MAX_JSON_BYTES, max_pcm_bytes: int = MAX_PCM_BYTES):
        self._buffer = bytearray()
        self._max_json = max_json_bytes
        self._max_pcm = max_pcm_bytes

    def feed(self, data: bytes) -> list[Frame]:
        self._buffer.extend(data)
        frames: list[Frame] = []
        while len(self._buffer) >= 5:
            length, raw_kind = struct.unpack_from(">IB", self._buffer)
            try:
                kind = FrameKind(raw_kind)
            except ValueError as exc:
                raise FrameError("IPC_FRAME_KIND_INVALID") from exc
            limit = self._max_json if kind is FrameKind.JSON else self._max_pcm
            if length > limit:
                raise FrameError("IPC_FRAME_TOO_LARGE")
            if len(self._buffer) < 5 + length:
                break
            body = bytes(self._buffer[5:5 + length])
            del self._buffer[:5 + length]
            frames.append(Frame(kind, body))
        return frames

    def eof(self) -> None:
        if self._buffer:
            reason = "IPC_TRUNCATED_HEADER" if len(self._buffer) < 5 else "IPC_TRUNCATED_BODY"
            raise FrameError(reason)
