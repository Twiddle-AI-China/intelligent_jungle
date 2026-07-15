from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import time
from dataclasses import dataclass, field, replace
from pathlib import Path

import numpy as np


SPECIES = ("pulse", "resonance", "texture")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def limited_step(previous: np.ndarray, target: np.ndarray, maximum_step: float) -> tuple[np.ndarray, float]:
    difference = np.asarray(target, dtype=np.float32) - np.asarray(previous, dtype=np.float32)
    distance = float(np.linalg.norm(difference))
    step = float(np.clip(maximum_step, 0.005, 2.0))
    next_value = np.asarray(previous, dtype=np.float32) + difference * min(1.0, step / max(distance, 1e-9))
    return next_value, max(0.0, distance - step)


@dataclass
class VoiceControl:
    object_id: int
    species: str
    decoder_id: str
    chart_position: np.ndarray
    motion: np.ndarray
    latent_step: float
    note_groups: list[dict[str, float]]
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
    latent_remaining: dict[int, float] = field(default_factory=dict)
    pitch_shifters: dict[tuple[int, int], "StreamingPitchShifter"] = field(default_factory=dict)
    envelopes: dict[tuple[int, int], float] = field(default_factory=dict)
    last_triggers: dict[tuple[int, int], int] = field(default_factory=dict)
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


def read_stratified_audio(path: Path, target_rate: int, segment_seconds: float = 2.0, segments: int = 24) -> np.ndarray:
    """Read deterministic windows across a file instead of mistaking its intro for its corpus."""
    import soundfile as sf

    with sf.SoundFile(path) as source:
        source_frames = len(source)
        source_rate = source.samplerate
        window_frames = max(1, round(segment_seconds * source_rate))
        latest_start = max(0, source_frames - window_frames)
        starts = np.linspace(0, latest_start, max(1, segments), dtype=np.int64)
        windows = []
        for start in starts:
            source.seek(int(start))
            window = source.read(window_frames, dtype="float32", always_2d=True).mean(axis=1)
            if len(window) < window_frames:
                window = np.pad(window, (0, window_frames - len(window)))
            windows.append(window)
    audio = np.concatenate(windows).astype(np.float32, copy=False)
    if source_rate == target_rate:
        return audio
    import torch
    import torchaudio
    return torchaudio.functional.resample(torch.from_numpy(audio)[None], source_rate, target_rate)[0].numpy()


class RealtimeDecoder:
    def __init__(self, model_id: str, streaming_model: Path, offline_model: Path, corpus: Path, frames: int | None = None, atlas_segments: int = 24) -> None:
        import torch

        torch.set_num_threads(2)
        self.torch = torch
        self.model_id = model_id
        self.sample_rate = 44_100
        self.model_path = streaming_model
        self.model_sha = sha256(streaming_model)
        self.model = torch.jit.load(str(streaming_model), map_location="cpu").eval()
        self.sample_rate = int(self.model.sr)
        self.latent_size = int(self.model.latent_size)
        decode_params = np.asarray(self.model.decode_params).reshape(-1)
        if len(decode_params) < 2:
            raise RuntimeError(f"model {model_id} does not expose a usable decode_params")
        self.samples_per_frame = int(decode_params[1])
        self.frames = frames or max(1, round(1024 / self.samples_per_frame))

        encoder = torch.jit.load(str(offline_model), map_location="cpu").eval()
        self.anchors: dict[str, object] = {}
        self.chart_bases: dict[str, object] = {}
        self.chart_scales: dict[str, object] = {}
        with torch.inference_mode():
            for species in SPECIES:
                audio = read_stratified_audio(corpus / f"{species}.wav", self.sample_rate, segments=atlas_segments)
                tensor = torch.from_numpy(audio)[None, :]
                latent = encoder.encode(tensor[None, :]).squeeze(0).contiguous()
                if latent.shape[0] != self.latent_size or latent.shape[-1] < self.frames * 2:
                    raise RuntimeError(f"invalid latent path for {species}: {tuple(latent.shape)}")
                self.anchors[species] = latent.mean(dim=-1)
                centered = latent - self.anchors[species][:, None]
                basis, _singular_values, _right = torch.linalg.svd(centered, full_matrices=False)
                projected = basis.T @ centered
                chart_scale = torch.quantile(projected.abs(), 0.9, dim=1).clamp_min(0.05)
                self.chart_bases[species] = basis.contiguous()
                self.chart_scales[species] = chart_scale
        del encoder

    def new_session(self) -> "RealtimeDecoder":
        session = object.__new__(RealtimeDecoder)
        session.torch = self.torch
        session.frames = self.frames
        session.model_id = self.model_id
        session.sample_rate = self.sample_rate
        session.model_path = self.model_path
        session.model_sha = self.model_sha
        session.latent_size = self.latent_size
        session.samples_per_frame = self.samples_per_frame
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
        normalized = np.clip(position, 0.0, 1.0) * 2.0 - 1.0
        coordinates = torch.zeros(self.latent_size, dtype=anchor.dtype)
        coordinates[:2] = torch.from_numpy(normalized).to(dtype=anchor.dtype) * scale[:2] * 1.35
        # XY owns the two leading corpus directions. The remaining PCA directions
        # respond more subtly to actual flock behaviour, preserving a learnable
        # surface while allowing 8/16/32D exports to reveal additional articulation.
        if self.latent_size > 2:
            motion = np.pad(control.motion.astype(np.float32), (0, max(0, 6 - len(control.motion))))[:6]
            phase = np.arange(3, self.latent_size + 1, dtype=np.float32)[:, None]
            weights = np.sin(phase * np.arange(1, 7, dtype=np.float32)[None, :] * 1.618)
            secondary = np.tanh(weights @ motion / 2.5)
            coordinates[2:] = torch.from_numpy(secondary).to(dtype=anchor.dtype) * scale[2:] * 0.32
        target_offset = basis @ coordinates
        previous = state.previous_offsets.get(control.object_id)
        if previous is None:
            previous = target_offset.detach().cpu().numpy()
        target = target_offset.detach().cpu().numpy()
        next_offset, remaining = limited_step(previous, target, control.latent_step)
        ramp = np.linspace(0.0, 1.0, self.frames, dtype=np.float32)[None, :]
        offset = torch.from_numpy(previous[:, None] * (1.0 - ramp) + next_offset[:, None] * ramp)
        state.previous_offsets[control.object_id] = next_offset
        state.latent_remaining[control.object_id] = remaining
        latent = anchor[:, None] + offset.to(dtype=anchor.dtype)
        state.latent_means[control.object_id] = latent.mean(dim=-1).detach().cpu().tolist()
        return latent

    def decode(self, state: ClientState) -> tuple[np.ndarray, list[dict[str, float]], float]:
        torch = self.torch
        started = time.perf_counter()
        controls = state.voices[:6]
        if not controls:
            samples = self.frames * self.samples_per_frame
            return np.zeros((samples, 2), dtype=np.float32), [], 0.0
        latent = torch.stack([self._voice_latent(control, state) for control in controls])
        with torch.inference_mode():
            decoded = self.model.decode(latent).detach().cpu().numpy()[:, 0]

        any_solo = any(control.solo for control in controls)
        mix = np.zeros((decoded.shape[-1], 2), dtype=np.float32)
        levels: list[dict[str, float]] = []
        for audio, control in zip(decoded, controls, strict=True):
            raw_rms = float(np.sqrt(np.mean(np.square(audio, dtype=np.float64))))
            groups = control.note_groups or [{"id": 0, "pitchSemitones": control.pitch_semitones, "durationSeconds": 0.2, "strength": 1.0, "x": (control.pan + 1) * 0.5}]
            voice_mix = np.zeros((len(audio), 2), dtype=np.float32)
            calibrations = []
            envelope_levels = []
            for group_index, group in enumerate(groups[:4]):
                group_id = int(group.get("id", group_index))
                state_key = (control.object_id, group_id)
                pitch = float(np.clip(group.get("pitchSemitones", control.pitch_semitones), -6.0, 6.0))
                shifter = state.pitch_shifters.setdefault(state_key, StreamingPitchShifter())
                group_audio = shifter.process(audio, pitch)
                shifted_rms = float(np.sqrt(np.mean(np.square(group_audio, dtype=np.float64))))
                calibration = float(np.clip(0.08 / max(shifted_rms, 1e-5), 0.15, 12.0))
                calibrations.append(calibration)
                envelope = state.envelopes.get(state_key, 0.0)
                last_trigger = state.last_triggers.get(state_key, -1)
                if control.trigger_serial != last_trigger:
                    envelope = max(envelope, float(np.clip(control.trigger_strength, 0.0, 1.0)))
                    state.last_triggers[state_key] = control.trigger_serial
                duration = float(np.clip(group.get("durationSeconds", 0.2), 0.06, 1.5))
                decay = math.exp(-1.0 / (self.sample_rate * duration))
                envelope_curve = 0.005 + 0.995 * envelope * np.power(decay, np.arange(len(group_audio), dtype=np.float32))
                envelope *= decay ** len(group_audio)
                state.envelopes[state_key] = envelope
                envelope_levels.append(envelope)
                group_audio = group_audio * calibration * envelope_curve
                group_level = float(np.clip(group.get("strength", 1.0), 0.1, 1.0)) / math.sqrt(len(groups))
                group_pan = float(np.clip(control.pan * 0.6 + (float(group.get("x", 0.5)) * 2.0 - 1.0) * 0.4, -1.0, 1.0))
                voice_mix[:, 0] += group_audio * group_level * math.cos((group_pan + 1.0) * math.pi * 0.25)
                voice_mix[:, 1] += group_audio * group_level * math.sin((group_pan + 1.0) * math.pi * 0.25)
            rms = float(np.sqrt(np.mean(np.square(voice_mix, dtype=np.float64))))
            levels.append({"rms": rms, "rawRms": raw_rms, "calibrationGain": float(np.mean(calibrations)), "pitchSemitones": control.pitch_semitones, "envelope": max(envelope_levels, default=0.0), "noteGroups": len(groups), "latentRemaining": state.latent_remaining.get(control.object_id, 0.0)})
            audible = not control.muted and (not any_solo or control.solo)
            if not audible:
                continue
            # Slow musical energy remains in the control mapping; the limiter only
            # protects the output and does not synthesize or replace model audio.
            level = 0.35 + float(np.clip(control.energy, 0.0, 1.0)) * 0.65
            mix += voice_mix * level
        mix = np.tanh(mix * (0.9 / math.sqrt(max(1, len(controls))))).astype(np.float32)
        render_ms = (time.perf_counter() - started) * 1000.0
        return mix, levels, render_ms


class EnsembleRealtimeDecoder:
    """Route each Voice to its selected decoder and align blocks for one PCM stream."""

    def __init__(self, decoders: dict[str, RealtimeDecoder], default_id: str) -> None:
        if not decoders:
            raise RuntimeError("ensemble requires at least one decoder")
        sample_rates = {decoder.sample_rate for decoder in decoders.values()}
        if len(sample_rates) != 1:
            raise RuntimeError(f"ensemble decoders must share a sample rate, got {sample_rates}")
        self.sessions = {model_id: decoder.new_session() for model_id, decoder in decoders.items()}
        self.states = {model_id: ClientState() for model_id in decoders}
        self.default_id = default_id
        self.model_id = "ensemble"
        self.sample_rate = sample_rates.pop()
        self.block_samples = max(session.frames * session.samples_per_frame for session in self.sessions.values())
        for session in self.sessions.values():
            size = session.frames * session.samples_per_frame
            if self.block_samples % size:
                raise RuntimeError(f"cannot align decoder block {size} to {self.block_samples}")
        self.frames = 1
        self.samples_per_frame = self.block_samples
        self.latent_size = 0
        joined = "".join(sorted(session.model_sha for session in self.sessions.values()))
        self.model_sha = hashlib.sha256(joined.encode()).hexdigest()

    def decode(self, state: ClientState) -> tuple[np.ndarray, list[dict[str, float]], float]:
        started = time.perf_counter()
        mix = np.zeros((self.block_samples, 2), dtype=np.float32)
        levels_by_object: dict[int, dict[str, float]] = {}
        active_decoders = 0
        for model_id, session in self.sessions.items():
            controls = [control for control in state.voices if (control.decoder_id if control.decoder_id in self.sessions else self.default_id) == model_id]
            if not controls:
                continue
            active_decoders += 1
            substate = self.states[model_id]
            repeats = self.block_samples // (session.frames * session.samples_per_frame)
            # latentStep is defined per common ensemble block, so the lower-ratio
            # BRAVE decoder does not move twice as fast merely because it renders
            # two sub-blocks while a RAVE decoder renders one.
            routed_controls = [replace(control, latent_step=control.latent_step / repeats) for control in controls]
            substate.voices = routed_controls
            substate.revision = state.revision
            chunks = []
            latest_levels = []
            for _ in range(repeats):
                audio, latest_levels, _render_ms = session.decode(substate)
                chunks.append(audio)
            mix += np.concatenate(chunks, axis=0)
            for level, control in zip(latest_levels, controls, strict=True):
                levels_by_object[control.object_id] = {**level, "decoderId": model_id}
                state.latent_means[control.object_id] = substate.latent_means.get(control.object_id, [])
        if active_decoders:
            mix = np.tanh(mix / math.sqrt(active_decoders)).astype(np.float32)
        fallback = {"rms": 0.0, "rawRms": 0.0, "calibrationGain": 1.0, "pitchSemitones": 0.0, "envelope": 0.0, "noteGroups": 0, "latentRemaining": 0.0, "decoderId": self.default_id}
        levels = [levels_by_object.get(control.object_id, fallback) for control in state.voices]
        return mix, levels, (time.perf_counter() - started) * 1000.0


def parse_controls(payload: dict) -> list[VoiceControl]:
    controls = []
    for index, item in enumerate(payload.get("voices", [])[:6]):
        note_groups = []
        for group_index, group in enumerate(item.get("noteGroups", [])[:4]):
            note_groups.append({
                "id": int(group.get("id", group_index)),
                "pitchSemitones": float(np.clip(group.get("pitchSemitones", item.get("pitchSemitones", 0.0)), -6.0, 6.0)),
                "durationSeconds": float(np.clip(group.get("durationSeconds", 0.2), 0.06, 1.5)),
                "strength": float(np.clip(group.get("strength", 1.0), 0.1, 1.0)),
                "x": float(np.clip(group.get("x", 0.5), 0.0, 1.0)),
            })
        controls.append(VoiceControl(
            object_id=int(item.get("objectId", index)),
            species=str(item.get("species", "texture")),
            decoder_id=str(item.get("decoderId", "brave-16d")),
            chart_position=np.asarray(item.get("chartPosition", [0.5] * 2), dtype=np.float32)[:2],
            motion=np.clip(np.asarray(item.get("motion", [0.0] * 6), dtype=np.float32)[:6], -1.0, 1.0),
            latent_step=float(np.clip(item.get("latentStep", 0.16), 0.005, 2.0)),
            note_groups=note_groups,
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
    candidates = [(args.model_id, args.model, args.offline_model, args.frames)]
    for value in args.candidate:
        parts = value.split("=")
        if len(parts) != 2:
            raise ValueError("--candidate must be ID=MODEL_PATH")
        candidates.append((parts[0], Path(parts[1]), Path(parts[1]), None))
    decoders = {}
    for model_id, model, offline, frames in candidates:
        print(f"Loading realtime decoder {model_id}: {model}", flush=True)
        decoder = RealtimeDecoder(model_id, model, offline, args.corpus, frames, args.atlas_segments)
        decoders[model_id] = decoder
        print(f"Decoder ready: {model_id} · {decoder.model_sha[:8]} · {decoder.sample_rate} Hz · {decoder.latent_size}D · {decoder.samples_per_frame}x", flush=True)
    default_decoder = decoders[args.model_id]

    async def status(_request: web.Request) -> web.Response:
        return web.json_response({
            "engine": "neural-streaming-decoder",
            "defaultModel": args.model_id,
            "models": [{"id": item.model_id, "modelSha256": item.model_sha, "sampleRate": item.sample_rate, "latentSize": item.latent_size, "framesPerDecode": item.frames, "samplesPerFrame": item.samples_per_frame} for item in decoders.values()],
            "modelSha256": default_decoder.model_sha,
            "sampleRate": default_decoder.sample_rate,
            "latentSize": default_decoder.latent_size,
            "framesPerDecode": default_decoder.frames,
            "samplesPerDecode": default_decoder.frames * default_decoder.samples_per_frame,
            "liveDecoder": True,
            "latentMapping": "stratified-corpus-svd-plus-flock-motion",
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
        model_id = request.query.get("model", "ensemble")
        decoder = decoders.get(model_id)
        if model_id == "ensemble":
            session_model = EnsembleRealtimeDecoder(decoders, args.model_id)
        elif decoder is not None:
            session_model = decoder.new_session()
        else:
            await ws.send_json({"type": "error", "message": f"unknown model: {model_id}"})
            await ws.close()
            return ws
        await ws.send_json({
            "type": "ready",
            "engine": "neural-streaming-decoder",
            "modelId": session_model.model_id,
            "modelSha256": session_model.model_sha,
            "sampleRate": session_model.sample_rate,
            "latentSize": session_model.latent_size,
            "framesPerDecode": session_model.frames,
            "samplesPerFrame": session_model.samples_per_frame,
            "models": [{"id": item.model_id, "latentSize": item.latent_size, "samplesPerFrame": item.samples_per_frame} for item in decoders.values()],
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
        block_seconds = session_model.frames * session_model.samples_per_frame / session_model.sample_rate
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
    parser = argparse.ArgumentParser(description="Serve the Web MVP with live neural streaming decoders.")
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--model-id", default="brave-16d")
    parser.add_argument("--candidate", action="append", default=[], metavar="ID=MODEL_PATH")
    parser.add_argument("--offline-model", type=Path, required=True)
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4173)
    parser.add_argument("--frames", type=int, default=None)
    parser.add_argument("--atlas-segments", type=int, default=24)
    args = parser.parse_args()
    try:
        asyncio.run(run_server(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
