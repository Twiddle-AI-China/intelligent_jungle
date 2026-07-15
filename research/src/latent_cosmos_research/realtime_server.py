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


CORPUS_STEMS = ("pulse", "resonance", "texture")


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


def svd_plane_point(anchor: np.ndarray, basis: np.ndarray, scale: np.ndarray, x: float, y: float, gain: float = 0.85) -> np.ndarray:
    """Embed normalized XY into the decoder's full latent vector."""
    coordinates = np.zeros(len(anchor), dtype=np.float32)
    coordinates[0] = (float(np.clip(x, 0.0, 1.0)) * 2.0 - 1.0) * float(scale[0]) * gain
    if len(anchor) > 1:
        coordinates[1] = (1.0 - float(np.clip(y, 0.0, 1.0)) * 2.0) * float(scale[1]) * gain
    return np.asarray(anchor, dtype=np.float32) + np.asarray(basis, dtype=np.float32) @ coordinates


def relation_latent_point(anchor: np.ndarray, basis: np.ndarray, scale: np.ndarray, relations: np.ndarray, timbre_range: float = 1.0) -> np.ndarray:
    """Map eight whole-flock descriptors through corpus SVD directions into the full latent vector."""
    latent_size = len(anchor)
    values = np.pad(np.asarray(relations, dtype=np.float32), (0, max(0, 8 - len(relations))))[:8]
    coordinates = np.zeros(latent_size, dtype=np.float32)
    primary = min(8, latent_size)
    gains = np.asarray([0.78, 0.68, 0.62, 0.58, 0.55, 0.52, 0.56, 0.6], dtype=np.float32)
    depth = float(np.clip(timbre_range, 0.25, 6.0))
    coordinates[:primary] = values[:primary] * np.asarray(scale[:primary], dtype=np.float32) * gains[:primary] * depth
    if latent_size > 8:
        phase = np.arange(9, latent_size + 1, dtype=np.float32)[:, None]
        weights = np.sin(phase * np.arange(1, 9, dtype=np.float32)[None, :] * 1.618)
        coordinates[8:] = np.tanh(weights @ values / 3.0) * np.asarray(scale[8:], dtype=np.float32) * 0.28 * depth
    return np.asarray(anchor, dtype=np.float32) + np.asarray(basis, dtype=np.float32) @ coordinates


def atlas_latent_point(atlas_latents: np.ndarray, atlas_features: np.ndarray, relations: np.ndarray, exploration_range: float = 1.0, neighbors: int = 4) -> tuple[np.ndarray, float, int]:
    """Select a local blend of real encoded corpus nodes instead of extrapolating off-manifold."""
    dimensions = atlas_features.shape[0]
    values = np.pad(np.asarray(relations, dtype=np.float32), (0, max(0, dimensions - len(relations))))[:dimensions]
    target = np.tanh(values * 1.35) * float(np.clip(exploration_range, 0.25, 6.0))
    distances = np.linalg.norm(atlas_features - target[:, None], axis=0)
    count = max(1, min(int(neighbors), atlas_latents.shape[1]))
    indices = np.argpartition(distances, count - 1)[:count]
    local = distances[indices]
    weights = 1.0 / np.square(local + 0.08)
    weights /= max(float(weights.sum()), 1e-9)
    point = np.asarray(atlas_latents[:, indices], dtype=np.float32) @ weights.astype(np.float32)
    nearest = int(indices[np.argmin(local)])
    return point.astype(np.float32, copy=False), float(distances[nearest]), nearest


@dataclass
class VoiceControl:
    object_id: int
    decoder_id: str
    relation_state: np.ndarray
    gate: bool
    gate_serial: int
    velocity: float
    pitch_semitones: float
    notes: list[dict[str, object]]
    timbre_range: float
    latent_step: float
    attack_seconds: float
    release_seconds: float
    max_duration_seconds: float


@dataclass
class ClientState:
    voices: list[VoiceControl] = field(default_factory=list)
    previous_latents: dict[int, np.ndarray] = field(default_factory=dict)
    latent_means: dict[int, list[float]] = field(default_factory=dict)
    latent_remaining: dict[int, float] = field(default_factory=dict)
    relation_states: dict[int, list[float]] = field(default_factory=dict)
    atlas_distances: dict[int, float] = field(default_factory=dict)
    atlas_nodes: dict[int, int] = field(default_factory=dict)
    pitch_shifters: dict[tuple[int, str], "StreamingPitchShifter"] = field(default_factory=dict)
    envelopes: dict[tuple[int, str], float] = field(default_factory=dict)
    calibration_gains: dict[tuple[int, str], float] = field(default_factory=dict)
    note_controls: dict[tuple[int, str], dict[str, object]] = field(default_factory=dict)
    last_gate_serials: dict[int, int] = field(default_factory=dict)
    voice_ages: dict[int, float] = field(default_factory=dict)
    revision: int = 0
    buffered_frames: int = 0
    underruns: int = 0


class StreamingPitchShifter:
    """Low-latency dual-read-head delay pitch shifter, kept outside neural timbre latent."""

    def __init__(self, buffer_size: int = 8192, delay_range: int = 2048, minimum_delay: int = 128) -> None:
        self.history = np.zeros(buffer_size, dtype=np.float32)
        self.phase = 0.0
        self.delay_range = delay_range
        self.minimum_delay = minimum_delay

    def process(self, audio: np.ndarray, semitones: float) -> np.ndarray:
        factor = 2.0 ** (float(np.clip(semitones, -12.0, 12.0)) / 12.0)
        count = len(audio)
        source = np.concatenate((self.history, np.asarray(audio, dtype=np.float32)))
        writes = len(self.history) + np.arange(count, dtype=np.float64)
        if abs(factor - 1.0) < 1e-4:
            output = np.interp(writes - (self.minimum_delay + self.delay_range * 0.5), np.arange(len(source)), source)
        else:
            increment = abs(factor - 1.0) / self.delay_range
            phase_a = (self.phase + increment * (np.arange(count, dtype=np.float64) + 1.0)) % 1.0
            phase_b = (phase_a + 0.5) % 1.0
            delays_a = self.minimum_delay + ((1.0 - phase_a) if factor > 1.0 else phase_a) * self.delay_range
            delays_b = self.minimum_delay + ((1.0 - phase_b) if factor > 1.0 else phase_b) * self.delay_range
            sample_a = np.interp(writes - delays_a, np.arange(len(source)), source)
            sample_b = np.interp(writes - delays_b, np.arange(len(source)), source)
            output = sample_a * np.sin(np.pi * phase_a) ** 2 + sample_b * np.sin(np.pi * phase_b) ** 2
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
        latent_paths = []
        with torch.inference_mode():
            for stem in CORPUS_STEMS:
                audio = read_stratified_audio(corpus / f"{stem}.wav", self.sample_rate, segments=atlas_segments)
                tensor = torch.from_numpy(audio)[None, :]
                latent = encoder.encode(tensor[None, :]).squeeze(0).contiguous()
                if latent.shape[0] != self.latent_size or latent.shape[-1] < self.frames * 2:
                    raise RuntimeError(f"invalid latent path for {stem}: {tuple(latent.shape)}")
                latent_paths.append(latent)
            corpus_latent = torch.cat(latent_paths, dim=-1)
            self.anchor = corpus_latent.mean(dim=-1)
            centered = corpus_latent - self.anchor[:, None]
            self.chart_basis, _singular_values, _right = torch.linalg.svd(centered, full_matrices=False)
            projected = self.chart_basis.T @ centered
            self.chart_scale = torch.quantile(projected.abs(), 0.9, dim=1).clamp_min(0.05)
            node_count = min(2048, corpus_latent.shape[-1])
            node_indices = torch.linspace(0, corpus_latent.shape[-1] - 1, node_count).round().long()
            self.atlas_latents = corpus_latent[:, node_indices].detach().cpu().numpy().astype(np.float32)
            control_dimensions = min(8, self.latent_size)
            self.atlas_features = (projected[:control_dimensions, node_indices] / self.chart_scale[:control_dimensions, None]).detach().cpu().numpy().astype(np.float32)
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
        session.anchor = self.anchor
        session.chart_basis = self.chart_basis
        session.chart_scale = self.chart_scale
        session.atlas_latents = self.atlas_latents
        session.atlas_features = self.atlas_features
        session.model = self.torch.jit.load(str(self.model_path), map_location="cpu").eval()
        return session

    def _voice_latent(self, control: VoiceControl, state: ClientState) -> object:
        torch = self.torch
        previous = state.previous_latents.get(control.object_id)
        frames = []
        remaining = 0.0
        target, atlas_distance, atlas_node = atlas_latent_point(self.atlas_latents, self.atlas_features, control.relation_state, control.timbre_range)
        for _ in range(self.frames):
            if previous is None:
                previous = target
            previous, remaining = limited_step(previous, target, control.latent_step)
            frames.append(previous.copy())
        state.previous_latents[control.object_id] = previous
        state.latent_remaining[control.object_id] = remaining
        state.relation_states[control.object_id] = control.relation_state.tolist()
        state.atlas_distances[control.object_id] = atlas_distance
        state.atlas_nodes[control.object_id] = atlas_node
        latent = torch.from_numpy(np.stack(frames, axis=1)).to(dtype=self.anchor.dtype)
        state.latent_means[control.object_id] = latent.mean(dim=-1).detach().cpu().tolist()
        return latent

    def decode(self, state: ClientState) -> tuple[np.ndarray, list[dict[str, float]], float]:
        torch = self.torch
        started = time.perf_counter()
        controls = state.voices[:1]
        if not controls:
            samples = self.frames * self.samples_per_frame
            return np.zeros((samples, 2), dtype=np.float32), [], 0.0
        latent = torch.stack([self._voice_latent(control, state) for control in controls])
        with torch.inference_mode():
            decoded = self.model.decode(latent).detach().cpu().numpy()[:, 0]

        mix = np.zeros((decoded.shape[-1], 2), dtype=np.float32)
        levels: list[dict[str, float]] = []
        for audio, control in zip(decoded, controls, strict=True):
            last_serial = state.last_gate_serials.get(control.object_id, -1)
            if control.gate_serial != last_serial:
                state.voice_ages[control.object_id] = 0.0
                state.last_gate_serials[control.object_id] = control.gate_serial
            age = state.voice_ages.get(control.object_id, 0.0)
            lifecycle_open = control.gate and (control.max_duration_seconds <= 0.0 or age < control.max_duration_seconds)
            for key, note in list(state.note_controls.items()):
                if key[0] == control.object_id:
                    note["gate"] = False
            current_notes = control.notes or ([{"id": "voice", "pitchSemitones": control.pitch_semitones, "velocity": control.velocity}] if control.gate else [])
            for note in current_notes[:3]:
                key = (control.object_id, str(note["id"]))
                state.note_controls[key] = {**note, "gate": lifecycle_open}
            branch_mix = np.zeros((len(audio), 2), dtype=np.float32)
            branch_envelopes = []
            branch_calibrations = []
            raw_levels = []
            attack_coefficient = math.exp(-1.0 / (self.sample_rate * control.attack_seconds))
            release_coefficient = math.exp(-1.0 / (self.sample_rate * control.release_seconds))
            for key, note in list(state.note_controls.items()):
                if key[0] != control.object_id:
                    continue
                shifted = state.pitch_shifters.setdefault(key, StreamingPitchShifter()).process(audio, float(note["pitchSemitones"]))
                raw_rms = float(np.sqrt(np.mean(np.square(shifted, dtype=np.float64))))
                raw_levels.append(raw_rms)
                calibration_target = float(np.clip(0.08 / max(raw_rms, 1e-5), 0.15, 12.0))
                calibration = state.calibration_gains.get(key, calibration_target)
                calibration += (calibration_target - calibration) * 0.12
                state.calibration_gains[key] = calibration
                branch_calibrations.append(calibration)
                envelope = state.envelopes.get(key, 0.0)
                envelope_curve = np.empty(len(shifted), dtype=np.float32)
                note_gate = bool(note.get("gate", False)) and lifecycle_open
                for sample in range(len(shifted)):
                    envelope = 1.0 - (1.0 - envelope) * attack_coefficient if note_gate else envelope * release_coefficient
                    envelope_curve[sample] = envelope
                state.envelopes[key] = envelope
                branch_envelopes.append(envelope)
                mono = shifted * calibration * envelope_curve * (0.25 + 0.75 * float(note["velocity"]))
                branch_mix[:, 0] += mono * math.sqrt(0.5)
                branch_mix[:, 1] += mono * math.sqrt(0.5)
                if not note_gate and envelope < 1e-4:
                    state.note_controls.pop(key, None); state.envelopes.pop(key, None); state.pitch_shifters.pop(key, None); state.calibration_gains.pop(key, None)
            if control.gate:
                age += len(audio) / self.sample_rate
            state.voice_ages[control.object_id] = age
            branches = max(1, len(state.note_controls))
            voice_mix = branch_mix / math.sqrt(branches)
            rms = float(np.sqrt(np.mean(np.square(voice_mix, dtype=np.float64))))
            latent_mean = np.asarray(state.latent_means.get(control.object_id, []), dtype=np.float32)
            latent_radius = float(np.linalg.norm(latent_mean - self.anchor.detach().cpu().numpy())) if len(latent_mean) else 0.0
            levels.append({"rms": rms, "rawRms": float(np.mean(raw_levels)) if raw_levels else 0.0, "calibrationGain": float(np.mean(branch_calibrations)) if branch_calibrations else 1.0, "envelope": max(branch_envelopes, default=0.0), "gate": lifecycle_open, "polyphony": min(3, len(current_notes)), "voiceAge": age, "pitchSemitones": control.pitch_semitones, "timbreRange": control.timbre_range, "latentRadius": latent_radius, "atlasDistance": state.atlas_distances.get(control.object_id, 0.0), "atlasNode": state.atlas_nodes.get(control.object_id, 0), "latentRemaining": state.latent_remaining.get(control.object_id, 0.0), "relationState": state.relation_states.get(control.object_id, control.relation_state.tolist())})
            mix += voice_mix
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
        fallback = {"rms": 0.0, "rawRms": 0.0, "calibrationGain": 1.0, "envelope": 0.0, "gate": False, "polyphony": 0, "voiceAge": 0.0, "pitchSemitones": 0.0, "timbreRange": 1.0, "latentRadius": 0.0, "atlasDistance": 0.0, "atlasNode": 0, "latentRemaining": 0.0, "relationState": [0.0] * 8, "decoderId": self.default_id}
        levels = [levels_by_object.get(control.object_id, fallback) for control in state.voices]
        return mix, levels, (time.perf_counter() - started) * 1000.0


def parse_controls(payload: dict) -> list[VoiceControl]:
    controls = []
    for index, item in enumerate(payload.get("voices", [])[:1]):
        notes = [{"id": str(note.get("id", note_index)), "pitchSemitones": float(np.clip(note.get("pitchSemitones", 0.0), -12.0, 12.0)), "velocity": float(np.clip(note.get("velocity", 1.0), 0.0, 1.0))} for note_index, note in enumerate(item.get("notes", [])[:3])]
        controls.append(VoiceControl(
            object_id=int(item.get("objectId", index)),
            decoder_id=str(item.get("decoderId", "fsl10k-16d")),
            relation_state=np.clip(np.asarray(item.get("relationState", [0.0] * 8), dtype=np.float32)[:8], -1.0, 1.0),
            gate=bool(item.get("gate", False)),
            gate_serial=max(0, int(item.get("gateSerial", 0))),
            velocity=float(np.clip(item.get("velocity", 1.0), 0.0, 1.0)),
            pitch_semitones=float(np.clip(item.get("pitchSemitones", 0.0), -12.0, 12.0)),
            notes=notes,
            timbre_range=float(np.clip(item.get("timbreRange", 1.25), 0.25, 6.0)),
            latent_step=float(np.clip(item.get("latentStep", 0.2), 0.005, 0.5)),
            attack_seconds=float(np.clip(item.get("attackSeconds", 0.06), 0.001, 1.0)),
            release_seconds=float(np.clip(item.get("releaseSeconds", 0.45), 0.005, 4.0)),
            max_duration_seconds=float(np.clip(item.get("maxDurationSeconds", 0.0), 0.0, 30.0)),
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
            "latentMapping": "eight-whole-flock-relations-to-real-corpus-atlas",
            "pitchControl": "post-decoder-keyboard-semitones",
            "gateControl": "eternal-c4-carrier-with-keyboard-pitch-branches",
            "voiceLifecycle": "eternal-no-reset",
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
