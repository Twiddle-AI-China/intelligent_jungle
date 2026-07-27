"""唯一 backend/VoicePool/model owner。"""
from __future__ import annotations

import copy
import hashlib
from typing import Any, Callable

from ..backend_factory import make_backend
from ..config import EngineConfig
from ..config import GATE_NOTE_BUFFER_SECONDS
from ..voices import VoicePool


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
        self.voice_pool = VoicePool(size=self.config.pool_size, sample_rate=self.config.sample_rate)
        self.voice_pool_count += 1
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
        if kind == "preview.allOff" and "voice" not in command and "row" not in command:
            for voice in self.voice_pool.voices:
                voice.note_off()
                self.backend.note_off(voice)
            return
        if kind == "mix.set":
            self.mix_state[command["param"]] = copy.deepcopy(command["value"])
            return
        voice = self._resolve_voice(command)
        if kind in {"note.on", "gate.on", "preview.start"}:
            if kind == "note.on":
                voice.duration_seconds = float(command.get("durationSeconds", 1.0))
            elif kind == "gate.on":
                voice.duration_seconds = GATE_NOTE_BUFFER_SECONDS
            voice.note_on(float(command.get("midi", 60.0)), float(command.get("velocity", 0.8)))
            self.backend.note_on(voice)
        elif kind in {"note.off", "gate.off", "preview.allOff"}:
            voice.note_off()
            self.backend.note_off(voice)
        elif kind in {"continuous.set", "latent.set"}:
            param = command.get("param")
            if param not in {"gain", "rich", "room", "dirt", "timbre", "timbre_xy", "timbre_k", "timbre_pca"}:
                raise RuntimeError("AUDIO_COMMAND_PARAM_INVALID")
            value = command.get("value")
            if param in {"timbre_xy", "timbre_pca"}:
                value = tuple(value)
            setattr(voice, param, value)
        else:
            raise RuntimeError("AUDIO_COMMAND_TYPE_INVALID")
