from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np


SPECIES = ("pulse", "resonance", "texture")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


@dataclass
class VoiceControl:
    object_id: int
    species: str
    chart_position: np.ndarray
    pitch_semitones: float
    trigger_serial: int
    trigger_strength: float
    pan: float
    energy: float
    muted: bool
    solo: bool


@dataclass
class ClientState:
    voices: list[VoiceControl] = field(default_factory=list)
    previous_offsets: dict[int, np.ndarray] = field(default_factory=dict)
    latent_means: dict[int, list[float]] = field(default_factory=dict)
    pitch_shifters: dict[int, "StreamingPitchShifter"] = field(default_factory=dict)
    envelopes: dict[int, float] = field(default_factory=dict)
    last_triggers: dict[int, int] = field(default_factory=dict)
    revision: int = 0
    buffered_frames: int = 0
    underruns: int = 0


class StreamingPitchShifter:
    """Low-latency dual-read-head delay pitch shifter for the playable MVP."""

    def __init__(self, buffer_size: int = 8192, delay_range: int = 2048, minimum_delay: int = 128) -> None:
        self.history = np.zeros(buffer_size, dtype=np.float32)
        self.phase = 0.0
        self.delay_range = delay_range
        self.minimum_delay = minimum_delay

    def process(self, audio: np.ndarray, semitones: float) -> np.ndarray:
        factor = 2.0 ** (float(np.clip(semitones, -6.0, 6.0)) / 12.0)
        count = len(audio)
        source = np.concatenate((self.history, np.asarray(audio, dtype=np.float32)))
        write_positions = len(self.history) + np.arange(count, dtype=np.float64)
        if abs(factor - 1.0) < 1e-4:
            read_positions = write_positions - (self.minimum_delay + self.delay_range * 0.5)
            output = np.interp(read_positions, np.arange(len(source)), source)
        else:
            increment = abs(factor - 1.0) / self.delay_range
            phases = (self.phase + increment * (np.arange(count, dtype=np.float64) + 1.0)) % 1.0
            phases_b = (phases + 0.5) % 1.0
            if factor > 1.0:
                delays_a = self.minimum_delay + (1.0 - phases) * self.delay_range
                delays_b = self.minimum_delay + (1.0 - phases_b) * self.delay_range
            else:
                delays_a = self.minimum_delay + phases * self.delay_range
                delays_b = self.minimum_delay + phases_b * self.delay_range
            samples_a = np.interp(write_positions - delays_a, np.arange(len(source)), source)
            samples_b = np.interp(write_positions - delays_b, np.arange(len(source)), source)
            weights_a = np.sin(np.pi * phases) ** 2
            weights_b = np.sin(np.pi * phases_b) ** 2
            output = samples_a * weights_a + samples_b * weights_b
            self.phase = float((self.phase + increment * count) % 1.0)
        self.history = source[-len(self.history):].copy()
        return output.astype(np.float32, copy=False)


class BraveRealtimeDecoder:
    def __init__(self, streaming_model: Path, offline_model: Path, corpus: Path, frames: int = 8) -> None:
        import soundfile as sf
        import torch
        import torchaudio

        torch.set_num_threads(2)
        self.torch = torch
        self.frames = frames
        self.sample_rate = 44_100
        self.model_path = streaming_model
        self.model_sha = sha256(streaming_model)
        self.model = torch.jit.load(str(streaming_model), map_location="cpu").eval()
        self.sample_rate = int(self.model.sr)
        self.latent_size = int(self.model.latent_size)
        if self.latent_size != 4:
            raise RuntimeError(f"expected 4D BRAVE latent, got {self.latent_size}")

        encoder = torch.jit.load(str(offline_model), map_location="cpu").eval()
        self.anchors: dict[str, object] = {}
        self.chart_bases: dict[str, object] = {}
        self.chart_scales: dict[str, object] = {}
        with torch.inference_mode():
            for species in SPECIES:
                audio, source_rate = sf.read(corpus / f"{species}.wav", dtype="float32")
                audio = np.asarray(audio)
                if audio.ndim > 1:
                    audio = audio.mean(axis=1)
                tensor = torch.from_numpy(audio)[None, :]
                if source_rate != self.sample_rate:
                    tensor = torchaudio.functional.resample(tensor, source_rate, self.sample_rate)
                # Two seconds provide a non-static latent trajectory while keeping
                # local startup fast enough for an instrument workflow.
                tensor = tensor[:, : self.sample_rate * 2]
                latent = encoder.encode(tensor[None, :]).squeeze(0).contiguous()
                if latent.shape[0] != self.latent_size or latent.shape[-1] < self.frames * 2:
                    raise RuntimeError(f"invalid latent path for {species}: {tuple(latent.shape)}")
                self.anchors[species] = latent.mean(dim=-1)
                centered = latent - self.anchors[species][:, None]
                basis, _singular_values, _right = torch.linalg.svd(centered, full_matrices=False)
                chart_basis = basis[:, :2].contiguous()
                projected = chart_basis.T @ centered
                chart_scale = torch.quantile(projected.abs(), 0.9, dim=1).clamp_min(0.05)
                self.chart_bases[species] = chart_basis
                self.chart_scales[species] = chart_scale
        del encoder

    def new_session(self) -> "BraveRealtimeDecoder":
        session = object.__new__(BraveRealtimeDecoder)
        session.torch = self.torch
        session.frames = self.frames
        session.sample_rate = self.sample_rate
        session.model_path = self.model_path
        session.model_sha = self.model_sha
        session.latent_size = self.latent_size
        session.anchors = self.anchors
        session.chart_bases = self.chart_bases
        session.chart_scales = self.chart_scales
        session.model = self.torch.jit.load(str(self.model_path), map_location="cpu").eval()
        return session

    def _voice_latent(self, control: VoiceControl, state: ClientState) -> object:
        torch = self.torch
        anchor = self.anchors.get(control.species, self.anchors["texture"])
        basis = self.chart_bases.get(control.species, self.chart_bases["texture"])
        scale = self.chart_scales.get(control.species, self.chart_scales["texture"])
        position = np.pad(control.chart_position.astype(np.float32), (0, max(0, 2 - len(control.chart_position))), constant_values=0.5)[:2]
        # Each Species exposes a data-derived 2D chart inside the full 4D
        # checkpoint distribution. Both canvas axes move all four latent axes.
        normalized = np.clip(position, 0.0, 1.0) * 2.0 - 1.0
        coordinates = torch.from_numpy(normalized).to(dtype=anchor.dtype) * scale * 1.35
        target_offset = basis @ coordinates
        previous = state.previous_offsets.get(control.object_id)
        if previous is None:
            previous = target_offset.detach().cpu().numpy()
        ramp = np.linspace(0.0, 1.0, self.frames, dtype=np.float32)[None, :]
        offset = torch.from_numpy(previous[:, None] * (1.0 - ramp) + target_offset.cpu().numpy()[:, None] * ramp)
        state.previous_offsets[control.object_id] = target_offset.detach().cpu().numpy()
        latent = anchor[:, None] + offset.to(dtype=anchor.dtype)
        state.latent_means[control.object_id] = latent.mean(dim=-1).detach().cpu().tolist()
        return latent

    def decode(self, state: ClientState) -> tuple[np.ndarray, list[dict[str, float]], float]:
        torch = self.torch
        started = time.perf_counter()
        controls = state.voices[:6]
        if not controls:
            samples = self.frames * 128
            return np.zeros((samples, 2), dtype=np.float32), [], 0.0
        latent = torch.stack([self._voice_latent(control, state) for control in controls])
        with torch.inference_mode():
            decoded = self.model.decode(latent).detach().cpu().numpy()[:, 0]

        any_solo = any(control.solo for control in controls)
        mix = np.zeros((decoded.shape[-1], 2), dtype=np.float32)
        levels: list[dict[str, float]] = []
        for audio, control in zip(decoded, controls, strict=True):
            raw_rms = float(np.sqrt(np.mean(np.square(audio, dtype=np.float64))))
            shifter = state.pitch_shifters.setdefault(control.object_id, StreamingPitchShifter())
            audio = shifter.process(audio, control.pitch_semitones)
            shifted_rms = float(np.sqrt(np.mean(np.square(audio, dtype=np.float64))))
            # Calibrate after pitch shifting but before the musical envelope so
            # transposition and source identity cannot dominate the mix by level.
            calibration = float(np.clip(0.08 / max(shifted_rms, 1e-5), 0.15, 12.0))
            audio = audio * calibration
            envelope = state.envelopes.get(control.object_id, 0.0)
            last_trigger = state.last_triggers.get(control.object_id, -1)
            if control.trigger_serial != last_trigger:
                envelope = max(envelope, float(np.clip(control.trigger_strength, 0.0, 1.0)))
                state.last_triggers[control.object_id] = control.trigger_serial
            decay = math.exp(-1.0 / (self.sample_rate * 0.11))
            envelope_curve = 0.015 + 0.985 * envelope * np.power(decay, np.arange(len(audio), dtype=np.float32))
            envelope *= decay ** len(audio)
            state.envelopes[control.object_id] = envelope
            audio = audio * envelope_curve
            rms = float(np.sqrt(np.mean(np.square(audio, dtype=np.float64))))
            levels.append({"rms": rms, "rawRms": raw_rms, "calibrationGain": calibration, "pitchSemitones": control.pitch_semitones, "envelope": envelope})
            audible = not control.muted and (not any_solo or control.solo)
            if not audible:
                continue
            # Slow musical energy remains in the control mapping; the limiter only
            # protects the output and does not synthesize or replace model audio.
            level = 0.35 + float(np.clip(control.energy, 0.0, 1.0)) * 0.65
            pan = float(np.clip(control.pan, -1.0, 1.0))
            left = math.cos((pan + 1.0) * math.pi * 0.25)
            right = math.sin((pan + 1.0) * math.pi * 0.25)
            mix[:, 0] += audio * level * left
            mix[:, 1] += audio * level * right
        mix = np.tanh(mix * (0.9 / math.sqrt(max(1, len(controls))))).astype(np.float32)
        render_ms = (time.perf_counter() - started) * 1000.0
        return mix, levels, render_ms


def parse_controls(payload: dict) -> list[VoiceControl]:
    controls = []
    for index, item in enumerate(payload.get("voices", [])[:6]):
        controls.append(VoiceControl(
            object_id=int(item.get("objectId", index)),
            species=str(item.get("species", "texture")),
            chart_position=np.asarray(item.get("chartPosition", [0.5] * 2), dtype=np.float32)[:2],
            pitch_semitones=float(np.clip(item.get("pitchSemitones", 0.0), -6.0, 6.0)),
            trigger_serial=max(0, int(item.get("triggerSerial", 0))),
            trigger_strength=float(np.clip(item.get("triggerStrength", 0.0), 0.0, 1.0)),
            pan=float(item.get("pan", 0.0)),
            energy=float(item.get("energy", 0.5)),
            muted=bool(item.get("muted", False)),
            solo=bool(item.get("solo", False)),
        ))
    return controls


async def run_server(args: argparse.Namespace) -> None:
    from aiohttp import WSMsgType, web

    root = args.root.resolve()
    print(f"Loading BRAVE streaming decoder: {args.model}", flush=True)
    decoder = BraveRealtimeDecoder(args.model, args.offline_model, args.corpus, args.frames)
    print(f"BRAVE ready: {decoder.model_sha[:8]} · {decoder.sample_rate} Hz · {decoder.latent_size}D", flush=True)

    async def status(_request: web.Request) -> web.Response:
        return web.json_response({
            "engine": "brave-streaming-decoder",
            "modelSha256": decoder.model_sha,
            "sampleRate": decoder.sample_rate,
            "latentSize": decoder.latent_size,
            "framesPerDecode": decoder.frames,
            "samplesPerDecode": decoder.frames * 128,
            "liveDecoder": True,
            "latentMapping": "checkpoint-svd-2d-to-4d",
            "pitchControl": "post-decoder-streaming",
            "pulseTrigger": True,
        })

    async def index(_request: web.Request) -> web.FileResponse:
        return web.FileResponse(root / "index.html")

    async def favicon(_request: web.Request) -> web.FileResponse:
        return web.FileResponse(root / "favicon.svg")

    async def websocket(request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=15.0, max_msg_size=64 * 1024)
        await ws.prepare(request)
        state = ClientState()
        session_model = decoder.new_session()
        await ws.send_json({
            "type": "ready",
            "engine": "brave-streaming-decoder",
            "modelSha256": session_model.model_sha,
            "sampleRate": session_model.sample_rate,
            "latentSize": session_model.latent_size,
            "framesPerDecode": session_model.frames,
        })

        async def receive() -> None:
            async for message in ws:
                if message.type == WSMsgType.TEXT:
                    try:
                        payload = json.loads(message.data)
                        if payload.get("type") == "control":
                            state.voices = parse_controls(payload)
                            state.revision += 1
                        elif payload.get("type") == "buffer":
                            state.buffered_frames = max(0, int(payload.get("bufferedFrames", 0)))
                            state.underruns = max(0, int(payload.get("underruns", 0)))
                    except (ValueError, TypeError):
                        await ws.send_json({"type": "error", "message": "invalid control frame"})
                elif message.type in (WSMsgType.CLOSE, WSMsgType.ERROR):
                    break

        receiver = asyncio.create_task(receive())
        block_seconds = session_model.frames * 128 / session_model.sample_rate
        block_index = 0
        try:
            while not ws.closed:
                if not state.voices:
                    await asyncio.sleep(0.005)
                    continue
                started = time.perf_counter()
                audio, levels, render_ms = session_model.decode(state)
                await ws.send_bytes(audio.astype("<f4", copy=False).tobytes())
                block_index += 1
                if block_index % 8 == 0:
                    await ws.send_json({
                        "type": "telemetry",
                        "renderMs": render_ms,
                        "voices": [
                            {
                                **value,
                                "db": 20 * math.log10(max(value["rms"], 1e-7)),
                                "latentMean": state.latent_means.get(control.object_id, []),
                            }
                            for value, control in zip(levels, state.voices[:6], strict=True)
                        ],
                        "revision": state.revision,
                        "bufferedFrames": state.buffered_frames,
                        "underruns": state.underruns,
                    })
                elapsed = time.perf_counter() - started
                if state.buffered_frames < 4096:
                    pacing = 0.35
                elif state.buffered_frames > 12288:
                    pacing = 1.2
                else:
                    pacing = 0.97
                await asyncio.sleep(max(0.0, block_seconds * pacing - elapsed))
        finally:
            receiver.cancel()
            try:
                await receiver
            except asyncio.CancelledError:
                pass
        return ws

    app = web.Application()
    app.router.add_get("/", index)
    app.router.add_get("/index.html", index)
    app.router.add_get("/favicon.svg", favicon)
    app.router.add_get("/api/decoder-status", status)
    app.router.add_get("/decoder", websocket)
    app.router.add_static("/src/", root / "src", show_index=False)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, args.host, args.port)
    await site.start()
    print(f"Realtime MVP: http://{args.host}:{args.port}", flush=True)
    try:
        await asyncio.Event().wait()
    finally:
        await runner.cleanup()


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the Web MVP with a live BRAVE streaming decoder.")
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--offline-model", type=Path, required=True)
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4173)
    parser.add_argument("--frames", type=int, default=8)
    args = parser.parse_args()
    try:
        asyncio.run(run_server(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
