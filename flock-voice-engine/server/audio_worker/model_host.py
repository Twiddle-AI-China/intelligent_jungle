"""唯一 backend/VoicePool/model owner。"""
from __future__ import annotations

import copy
import hashlib
from typing import Any, Callable

import numpy as np

from ..backend_factory import make_backend
from ..config import EngineConfig
from ..config import GATE_NOTE_BUFFER_SECONDS
from ..voices import VoicePool
from .mixer import ServerMixer
from .texture import TextureRenderer
from .jungle import jungle_slice_for_cell


class ModelHost:
    def __init__(self, config: EngineConfig, geometry: dict[str, Any],
                 backend_factory: Callable[[EngineConfig], Any] = make_backend,
                 allow_test_backend: bool = False, asset_bundle=None):
        self.config = config
        self.geometry = dict(geometry)
        self.backend_factory = backend_factory
        self.allow_test_backend = allow_test_backend
        self.asset_bundle = asset_bundle
        self.backend = None
        self.voice_pool: VoicePool | None = None
        self.load_count = 0
        self.voice_pool_count = 0
        self.authoritative_state: dict[str, Any] | None = None
        self.assignments: dict[str, Any] | list[Any] = {}
        self.latent_state: dict[str, Any] = {"modes": {}, "targets": {}}
        self.mix_state: dict[str, Any] = {}
        self.texture_renderer: TextureRenderer | None = None
        self.mixer: ServerMixer | None = None
        self._texture_pcm = np.zeros(0, dtype=np.float32)
        self._texture_cursor = 0

    def load_once(self):
        if self.backend is not None:
            return self.backend
        expected = (self.geometry.get("sampleRate"), self.geometry.get("blockFrames"), self.geometry.get("poolSize"))
        actual = (self.config.sample_rate, self.config.block_samples, self.config.pool_size)
        if actual != expected:
            raise RuntimeError("AUDIO_GEOMETRY_MISMATCH")
        if self.allow_test_backend:
            backend = self.backend_factory(self.config)
        else:
            if self.asset_bundle is None:
                raise RuntimeError("CONTROLLED_ASSET_BUNDLE_REQUIRED")
            backend = self.backend_factory(self.config, asset_bundle=self.asset_bundle)
        if not self.allow_test_backend and getattr(backend, "backend_id", None) != "brave-voices":
            raise RuntimeError("PRODUCTION_BACKEND_REQUIRED")
        if not self.allow_test_backend and getattr(backend, "asset_manifest_sha256", None) != self.asset_bundle.manifest_sha256:
            raise RuntimeError("BACKEND_ASSET_BINDING_MISMATCH")
        backend.load()
        info = backend.info()
        if (info.get("sampleRate"), info.get("blockSamples"), info.get("poolSize")) != expected:
            backend.close()
            raise RuntimeError("BACKEND_GEOMETRY_MISMATCH")
        voice_pool = VoicePool(size=self.config.pool_size, sample_rate=self.config.sample_rate)
        texture_renderer = None
        mixer = None
        if not self.allow_test_backend:
            try:
                texture_renderer = TextureRenderer.from_bundle(
                    self.asset_bundle, self.config.sample_rate, deterministic_seed=0)
                mixer = ServerMixer(
                    self.config.sample_rate, self.config.block_samples, self.geometry["rowVoices"],
                    ambience=texture_renderer.forest, deterministic_seed=0)
            except Exception:
                backend.close()
                raise
        self.voice_pool = voice_pool
        self.voice_pool_count += 1
        self.texture_renderer = texture_renderer
        self.mixer = mixer
        self.backend = backend
        self.load_count += 1
        return backend

    def _resolve_voice(self, command: dict[str, Any]):
        if self.voice_pool is None:
            raise RuntimeError("MODEL_NOT_LOADED")
        raw = command.get("row", command.get("voice"))
        if type(raw) is int:
            row = raw
        elif isinstance(raw, str) and raw in self.geometry.get("rowVoices", []):
            row = self.geometry["rowVoices"].index(raw)
        else:
            raise RuntimeError("AUDIO_COMMAND_VOICE_INVALID")
        voice = self.voice_pool.route(row)
        if voice is None:
            raise RuntimeError("AUDIO_COMMAND_VOICE_INVALID")
        return voice

    def apply_command(self, command: dict[str, Any]) -> None:
        """仅由 render thread 调用，将已 ACK intent 真正落到 pool/backend。"""
        if self.backend is None or self.voice_pool is None:
            raise RuntimeError("MODEL_NOT_LOADED")
        kind = command["type"]
        if kind == "state.replace":
            snapshot = copy.deepcopy(command["value"])
            self.backend.reset()
            seed_bytes = hashlib.sha256(str(snapshot["deterministicSeed"]).encode("utf-8")).digest()
            reset_pool = VoicePool(size=self.config.pool_size, sample_rate=self.config.sample_rate,
                                   seed=int.from_bytes(seed_bytes[:4], "big"))
            # Keep the singleton pool owner while replacing every mutable per-world Voice.
            self.voice_pool.voices = reset_pool.voices
            self.authoritative_state = snapshot
            self.assignments = copy.deepcopy(snapshot["voices"]["assignments"])
            self.latent_state = copy.deepcopy(snapshot["latent"])
            self.mix_state = copy.deepcopy(snapshot["mix"])
            if self.texture_renderer is not None:
                self.texture_renderer.reset(snapshot["deterministicSeed"])
                self._texture_pcm = np.zeros(0, dtype=np.float32)
                self._texture_cursor = 0
            if self.mixer is not None:
                self.mixer.reset(snapshot["deterministicSeed"])
            for voice_name, target in self.latent_state["targets"].items():
                for param, value in target.items():
                    self.apply_command({"type": "latent.set", "voice": voice_name,
                                        "param": param, "value": value})
            for note in snapshot["voices"]["activeNotes"]:
                self.apply_command({**note, "type": "note.on"})
            for gate in snapshot["voices"]["activeGates"]:
                self.apply_command({**gate, "type": "gate.on"})
            for release in snapshot["voices"]["releases"]:
                self.apply_command({**release, "type": "note.off"})
            return
        if kind in {"voice.allOff", "voice.reset"} or (kind == "preview.allOff"
                                                        and "voice" not in command and "row" not in command):
            self._texture_pcm = np.zeros(0, dtype=np.float32)
            self._texture_cursor = 0
            for voice in self.voice_pool.voices:
                voice.note_off()
                self.backend.note_off(voice)
            return
        if kind == "mix.set":
            param = command["param"]
            if param == "masterGain":
                self.mix_state[param] = copy.deepcopy(command["value"])
            else:
                target = self.mix_state.setdefault(param, {})
                if not isinstance(target, dict):
                    raise RuntimeError("AUDIO_MIX_STATE_INVALID")
                target[command["species"]] = copy.deepcopy(command["value"])
            return
        voice = self._resolve_voice(command)
        if kind in {"note.on", "gate.on", "preview.start"}:
            if kind == "note.on":
                voice.duration_seconds = float(command.get("durationSeconds", 1.0))
            elif kind == "gate.on":
                voice.duration_seconds = GATE_NOTE_BUFFER_SECONDS
            voice.note_on(float(command.get("midi", 60.0)), float(command.get("velocity", 0.8)))
            if (self.texture_renderer is not None
                    and self.geometry.get("rowVoices", [])[voice.row] == "pluck"):
                event = dict(command)
                event.setdefault("pitchBranchId", int(round(voice.midi)) % 5)
                event.setdefault("stepIndex", 0)
                event.setdefault("masterBpm", 60)
                seconds = jungle_slice_for_cell(**event)["outputSeconds"]
                frames = max(self.config.block_samples, round(seconds * self.config.sample_rate))
                self._texture_pcm = self.texture_renderer.render(event, frames)
                self._texture_cursor = 0
            else:
                self.backend.note_on(voice)
        elif kind in {"note.off", "gate.off", "preview.allOff"}:
            voice.note_off()
            self.backend.note_off(voice)
            if self.geometry.get("rowVoices", [])[voice.row] == "pluck":
                self._texture_pcm = np.zeros(0, dtype=np.float32)
                self._texture_cursor = 0
        elif kind in {"continuous.set", "latent.set"}:
            param = command.get("param")
            if param not in {"gain", "rich", "room", "dirt", "timbre", "timbre_xy", "timbre_k", "timbre_pca"}:
                raise RuntimeError("AUDIO_COMMAND_PARAM_INVALID")
            value = command.get("value")
            if param in {"timbre_xy", "timbre_pca"} and value is not None:
                value = tuple(value)
            setattr(voice, param, value)
        else:
            raise RuntimeError("AUDIO_COMMAND_TYPE_INVALID")

    def render_texture_block(self, frames: int) -> tuple[int | None, np.ndarray | None]:
        """Return the current Jungle dry stem without touching mixer/master state."""
        try:
            row = self.geometry.get("rowVoices", []).index("pluck")
        except ValueError:
            return None, None
        if self._texture_cursor >= self._texture_pcm.size:
            return row, np.zeros(frames, dtype=np.float32)
        output = np.zeros(frames, dtype=np.float32)
        count = min(frames, self._texture_pcm.size - self._texture_cursor)
        output[:count] = self._texture_pcm[self._texture_cursor:self._texture_cursor + count]
        self._texture_cursor += count
        return row, output
