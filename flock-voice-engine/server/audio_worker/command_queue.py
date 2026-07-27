"""音频指令批次的原子预留、coalesce 和固定排序。"""
from __future__ import annotations

from dataclasses import dataclass
import copy
import threading
import math
from typing import Any, Callable

from .framing import decode_u64_decimal

COMMAND_PRIORITY = {
    "state.replace": 0,
    "note.off": 1, "gate.off": 1, "preview.allOff": 1, "voice.allOff": 1, "voice.reset": 1,
    "continuous.set": 2, "latent.set": 2, "mix.set": 2,
    "note.on": 3, "gate.on": 3, "preview.start": 3,
}
CONTINUOUS = frozenset({"continuous.set", "latent.set", "mix.set"})


@dataclass(frozen=True)
class Accepted:
    accepted: bool
    code: str
    command_seq: int | None = None


@dataclass(frozen=True)
class QueuedCommand:
    target_frame: int
    command_seq: int
    index: int
    command: dict[str, Any]
    expires_at_frame: int | None = None


def command_sort_key(item: QueuedCommand) -> tuple[int, int, int]:
    return (COMMAND_PRIORITY[item.command["type"]], item.command_seq, item.index)


class CommandQueues:
    def __init__(self, audio_epoch: str, continuous_capacity: int = 512, reliable_capacity: int = 256,
                 expected_sample_rate: int = 44100,
                 row_voices: tuple[str, ...] | list[str] | None = None):
        self.audio_epoch = audio_epoch
        self.continuous_capacity = continuous_capacity
        self.reliable_capacity = reliable_capacity
        self.expected_sample_rate = expected_sample_rate
        self.row_voices = tuple(row_voices or ("bass", "pad", "lead", "pluck", "pad"))
        self._continuous: dict[tuple[object, object, object, str], QueuedCommand] = {}
        self._reliable: list[QueuedCommand] = []
        self.last_command_seq = 0
        self.degraded = False
        self.rebuild_required = False
        self.late_frames = 0
        self._lock = threading.RLock()
        self._admission_pending = False

    def _valid_state_replace(self, command: dict[str, Any]) -> bool:
        value = command.get("value")
        required = {"stateRevision", "world", "frameMap", "voices", "latent", "mix",
                    "audioOwner", "voiceMode", "deterministicSeed", "configRevision"}
        if not isinstance(value, dict) or set(value) != required:
            return False
        if value.get("audioOwner") not in {"world", "legacy"} or value.get("voiceMode") != "production":
            return False
        world = value.get("world")
        frame_map = value.get("frameMap")
        voices = value.get("voices")
        latent = value.get("latent")
        mix = value.get("mix")
        return (type(value.get("stateRevision")) is int and value["stateRevision"] >= 0
                and isinstance(world, dict)
                and set(world) == {"worldId", "worldGeneration", "revision", "worldTimeSeconds"}
                and all(isinstance(world.get(key), str) and world[key] for key in ("worldId", "worldGeneration"))
                and type(world.get("revision")) is int and world["revision"] >= 0
                and self._finite_value(world.get("worldTimeSeconds"))
                and isinstance(frame_map, dict)
                and set(frame_map) == {"audioEpoch", "worldTimeSeconds", "renderFrame", "sampleRate"}
                and frame_map.get("audioEpoch") == self.audio_epoch
                and self._finite_value(frame_map.get("worldTimeSeconds"))
                and frame_map.get("sampleRate") == self.expected_sample_rate
                and isinstance(frame_map.get("renderFrame"), str)
                and self._valid_wire_u64(frame_map.get("renderFrame"))
                and isinstance(voices, dict) and set(voices) == {"assignments", "activeNotes", "activeGates", "releases"}
                and isinstance(voices["assignments"], (dict, list))
                and self._safe_assignment_value(voices["assignments"])
                and all(isinstance(voices[key], list) for key in ("activeNotes", "activeGates", "releases"))
                and all("type" not in item and self._valid_command({**item, "type": "note.on"})
                        for item in voices["activeNotes"] if isinstance(item, dict))
                and all(isinstance(item, dict) for item in voices["activeNotes"])
                and all("type" not in item and self._valid_command({**item, "type": "gate.on"})
                        for item in voices["activeGates"] if isinstance(item, dict))
                and all(isinstance(item, dict) for item in voices["activeGates"])
                and all("type" not in item and self._valid_command({**item, "type": "note.off"})
                        for item in voices["releases"] if isinstance(item, dict))
                and all(isinstance(item, dict) for item in voices["releases"])
                and isinstance(latent, dict) and set(latent) == {"modes", "targets"}
                and isinstance(latent["modes"], dict) and isinstance(latent["targets"], dict)
                and all(isinstance(key, str) and key in self.row_voices and value in {"AGENT", "USER"}
                        for key, value in latent["modes"].items())
                and all(isinstance(key, str) and key in self.row_voices and self._valid_latent_target(target)
                        for key, target in latent["targets"].items())
                and isinstance(mix, dict) and set(mix) == {"species", "masterGain", "mute", "solo", "eq", "reverb"}
                and isinstance(mix["species"], dict) and self._valid_gain(mix["masterGain"], maximum=2.0)
                and all(isinstance(mix[key], dict) for key in ("mute", "solo", "eq", "reverb"))
                and all(isinstance(key, str) and self._valid_gain(gain, maximum=2.0)
                        for key, gain in mix["species"].items())
                and all(isinstance(key, str) and isinstance(flag, bool) for key, flag in mix["mute"].items())
                and all(isinstance(key, str) and isinstance(flag, bool) for key, flag in mix["solo"].items())
                and all(isinstance(key, str) and self._valid_eq(value)
                        for key, value in mix["eq"].items())
                and all(isinstance(key, str) and self._valid_gain(value)
                        for key, value in mix["reverb"].items())
                and isinstance(value.get("deterministicSeed"), (str, int))
                and not isinstance(value.get("deterministicSeed"), bool)
                and type(value.get("configRevision")) is int and value["configRevision"] >= 0)

    @staticmethod
    def _valid_wire_u64(value: object) -> bool:
        try:
            decode_u64_decimal(value)
            return True
        except Exception:
            return False

    @staticmethod
    def _finite_value(value: object) -> bool:
        if isinstance(value, bool):
            return False
        if isinstance(value, (int, float)):
            return math.isfinite(value)
        if isinstance(value, (list, tuple)):
            return all(CommandQueues._finite_value(item) for item in value)
        if isinstance(value, dict):
            return all(isinstance(key, str) and CommandQueues._finite_value(item) for key, item in value.items())
        return False

    @staticmethod
    def _number(value: object) -> bool:
        return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)

    @classmethod
    def _valid_gain(cls, value: object, maximum: float = 1.0) -> bool:
        return cls._number(value) and 0.0 <= float(value) <= maximum

    @classmethod
    def _finite_nonempty_tree(cls, value: object) -> bool:
        if isinstance(value, dict):
            return bool(value) and all(isinstance(key, str) and cls._finite_nonempty_tree(item)
                                       for key, item in value.items())
        if isinstance(value, (list, tuple)):
            return bool(value) and all(cls._finite_nonempty_tree(item) for item in value)
        return cls._number(value)

    @classmethod
    def _valid_param_value(cls, param: str, value: object) -> bool:
        if param in {"timbre_xy", "timbre_pca"} and value is None:
            return True
        if param in {"gain", "rich", "room", "dirt"}:
            return cls._valid_gain(value)
        if param == "timbre":
            return type(value) is int and value >= 0
        if param == "timbre_xy":
            return (isinstance(value, (list, tuple)) and len(value) == 2
                    and all(cls._number(item) for item in value))
        if param == "timbre_k":
            return type(value) is int and 1 <= value <= 32
        if param == "timbre_pca":
            return (isinstance(value, (list, tuple)) and bool(value)
                    and len(value) <= 32
                    and all(cls._number(item) and -8.0 <= float(item) <= 8.0 for item in value))
        return False

    @classmethod
    def _valid_latent_target(cls, target: object) -> bool:
        if not isinstance(target, dict) or not target:
            return False
        return all(isinstance(param, str) and cls._valid_param_value(param, value)
                   for param, value in target.items())

    @classmethod
    def _valid_mix_value(cls, param: str, value: object) -> bool:
        if param == "masterGain":
            return cls._valid_gain(value, maximum=2.0)
        if param in {"mute", "solo"}:
            return isinstance(value, bool)
        if param == "species":
            return cls._valid_gain(value, maximum=2.0)
        if param == "eq":
            return cls._valid_eq(value)
        if param == "reverb":
            return cls._valid_gain(value)
        return False

    @classmethod
    def _valid_eq(cls, value: object) -> bool:
        return (isinstance(value, dict) and set(value) == {"low", "mid", "high"}
                and all(cls._number(item) and -12 <= float(item) <= 12 for item in value.values()))

    @staticmethod
    def _safe_assignment_value(value: object) -> bool:
        if isinstance(value, bool) or value is None:
            return False
        if isinstance(value, (str, int)):
            return bool(value) if isinstance(value, str) else value >= 0
        if isinstance(value, list):
            return all(CommandQueues._safe_assignment_value(item) for item in value)
        if isinstance(value, dict):
            return all(isinstance(key, str) and CommandQueues._safe_assignment_value(item)
                       for key, item in value.items())
        return False

    def _valid_voice(self, command: dict[str, Any]) -> bool:
        row = command.get("row")
        voice = command.get("voice")
        return ((type(row) is int and 0 <= row < len(self.row_voices) and voice is None)
                or (isinstance(voice, str) and voice in self.row_voices and row is None))

    def _valid_command(self, command: dict[str, Any]) -> bool:
        kind = command.get("type")
        if kind == "state.replace":
            return set(command) == {"type", "value"} and self._valid_state_replace(command)
        if kind in {"note.on", "gate.on"}:
            jungle_allowed = {"pitchBranchId", "stepIndex", "tension", "masterBpm",
                              "tempoMultiplier", "grainSeconds", "overlap", "jungleEditPlan"}
            edit = command.get("jungleEditPlan")
            valid_evidence = (isinstance(edit, dict) and isinstance(edit.get("evidence"), dict)
                and set(edit["evidence"]) == {"onsetCount", "conflictRatio", "patternSimilarity", "tension"}
                and all(self._number(value) for value in edit["evidence"].values()))
            valid_edit = (edit is None or (isinstance(edit, dict)
                and set(edit) in ({"breakEdit", "toneEdit"}, {"breakEdit", "toneEdit", "evidence"})
                and edit["breakEdit"] in {"hold", "dropout", "repeat2", "repeat4"}
                and edit["toneEdit"] in {"clean", "filter", "reverse", "crush", "dub"}
                and ("evidence" not in edit or valid_evidence)))
            return ({"type", "midi", "velocity"}.issubset(command)
                    and set(command).issubset({"type", "row", "voice", "midi", "velocity", "durationSeconds", "worldId"}
                                                      | jungle_allowed)
                    and self._valid_voice(command) and self._finite_value(command.get("midi"))
                    and 0 <= float(command["midi"]) <= 127
                    and self._finite_value(command.get("velocity"))
                    and 0 <= float(command["velocity"]) <= 1
                    and ("durationSeconds" not in command
                         or (self._number(command["durationSeconds"])
                             and 0.25 <= float(command["durationSeconds"]) <= 6.0))
                    and ("pitchBranchId" not in command or type(command["pitchBranchId"]) is int
                         and 0 <= command["pitchBranchId"] < 5)
                    and ("stepIndex" not in command or type(command["stepIndex"]) is int
                         and 0 <= command["stepIndex"] < 16)
                    and ("tension" not in command or self._valid_gain(command["tension"]))
                    and ("masterBpm" not in command or self._number(command["masterBpm"])
                         and 1 <= float(command["masterBpm"]) <= 300)
                    and ("tempoMultiplier" not in command or self._number(command["tempoMultiplier"])
                         and 1 <= float(command["tempoMultiplier"]) <= 8)
                    and ("grainSeconds" not in command or self._number(command["grainSeconds"])
                         and .02 <= float(command["grainSeconds"]) <= 1)
                    and ("overlap" not in command or self._number(command["overlap"])
                         and .1 <= float(command["overlap"]) <= .8)
                    and valid_edit)
        if kind in {"note.off", "gate.off"}:
            return set(command).issubset({"type", "row", "voice", "worldId"}) and self._valid_voice(command)
        if kind == "preview.start":
            return (set(command).issubset({"type", "row", "voice", "expiresAtFrame"})
                    and self._valid_voice(command) and self._valid_wire_u64(command.get("expiresAtFrame")))
        if kind == "preview.allOff":
            return (set(command).issubset({"type", "row", "voice"})
                    and (("voice" not in command and "row" not in command) or self._valid_voice(command)))
        if kind in {"voice.allOff", "voice.reset"}:
            return set(command) == {"type"}
        if kind in {"continuous.set", "latent.set"}:
            allowed_params = ({"gain", "rich", "room", "dirt"} if kind == "continuous.set"
                              else {"timbre", "timbre_xy", "timbre_k", "timbre_pca"})
            return (set(command).issubset({"type", "row", "voice", "worldId", "param", "value"})
                    and self._valid_voice(command) and isinstance(command.get("param"), str)
                    and command["param"] in allowed_params
                    and self._valid_param_value(command["param"], command.get("value")))
        if kind == "mix.set":
            allowed_params = {"masterGain", "mute", "solo", "eq", "reverb", "species"}
            param = command.get("param")
            species = command.get("species")
            needs_species = param != "masterGain"
            return (set(command).issubset({"type", "worldId", "species", "param", "value"})
                    and isinstance(command.get("param"), str) and command["param"] in allowed_params
                    and ((not needs_species and species is None)
                         or (needs_species and isinstance(species, str)
                             and species in {"bass", "pad", "melody", "texture"}))
                    and self._valid_mix_value(command["param"], command.get("value")))
        return False

    @staticmethod
    def _key(command: dict[str, Any]) -> tuple[object, object, object, str]:
        if command["type"] == "mix.set":
            voice_identity = ("species", command.get("species"))
        else:
            voice_identity = (("row", command["row"]) if "row" in command
                              else ("voice", command.get("voice")))
        return (command.get("worldId"), voice_identity, command.get("param"), command["type"])

    def enqueue(self, batch: dict[str, Any], on_accept: Callable[[Accepted], None] | None = None) -> Accepted:
        with self._lock:
            try:
                if self._admission_pending:
                    return Accepted(False, "ADMISSION_PENDING")
                if not isinstance(batch, dict) or batch.get("audioEpoch") != self.audio_epoch:
                    return Accepted(False, "AUDIO_EPOCH_MISMATCH")
                seq = batch.get("commandSeq")
                if type(seq) is not int or seq <= self.last_command_seq:
                    return Accepted(False, "COMMAND_SEQ_INVALID")
                target = batch.get("targetFrame")
                if not isinstance(target, str):
                    return Accepted(False, "TARGET_FRAME_INVALID")
                try:
                    target_frame = decode_u64_decimal(target)
                except Exception:
                    return Accepted(False, "TARGET_FRAME_INVALID")
                commands = batch.get("commands")
                if not isinstance(commands, list) or not commands:
                    return Accepted(False, "COMMAND_BATCH_INVALID")
                has_replace = any(c.get("type") == "state.replace" for c in commands if isinstance(c, dict))
                if has_replace and (len(commands) != 1 or not self._valid_state_replace(commands[0])):
                    return Accepted(False, "STATE_REPLACE_INVALID")
                new_continuous: dict[tuple[object, object, object, str], QueuedCommand] = {}
                new_reliable: list[QueuedCommand] = []
                for index, command in enumerate(commands):
                    if (not isinstance(command, dict) or command.get("type") not in COMMAND_PRIORITY
                            or not self._valid_command(command)):
                        return Accepted(False, "COMMAND_SCHEMA_INVALID")
                    expiry = None
                    if command["type"] == "preview.start" and "expiresAtFrame" in command:
                        try:
                            expiry = decode_u64_decimal(command["expiresAtFrame"])
                        except Exception:
                            return Accepted(False, "COMMAND_SCHEMA_INVALID")
                    item = QueuedCommand(target_frame, seq, index, copy.deepcopy(command), expiry)
                    if command["type"] in CONTINUOUS:
                        new_continuous[self._key(command)] = item
                    else:
                        new_reliable.append(item)
                planned_continuous = new_continuous if has_replace else {**self._continuous, **new_continuous}
                planned_reliable = new_reliable if has_replace else [*self._reliable, *new_reliable]
                if len(planned_continuous) > self.continuous_capacity:
                    return Accepted(False, "CONTINUOUS_QUEUE_OVERFLOW")
                if len(planned_reliable) > self.reliable_capacity:
                    self.degraded = True
                    self.rebuild_required = True
                    return Accepted(False, "RELIABLE_EDGE_OVERFLOW")
                accepted = Accepted(True, "ACCEPTED", seq)
                self._admission_pending = True
            except Exception:
                return Accepted(False, "COMMAND_BATCH_INVALID")

        try:
            if on_accept is not None:
                on_accept(accepted)
        except Exception:
            with self._lock:
                self._admission_pending = False
            return Accepted(False, "COMMAND_ACK_FAILED")

        with self._lock:
            if has_replace:
                self._continuous = new_continuous
                self._reliable = new_reliable
            else:
                self._continuous.update(new_continuous)
                self._reliable.extend(new_reliable)
            self.last_command_seq = seq
            self._admission_pending = False
            return accepted

    def drain_due(self, render_frame: int) -> list[QueuedCommand]:
        with self._lock:
            due = [item for item in self._reliable if item.target_frame <= render_frame]
            due += [item for item in self._continuous.values() if item.target_frame <= render_frame]
            self._reliable = [item for item in self._reliable if item.target_frame > render_frame]
            self._continuous = {key: item for key, item in self._continuous.items() if item.target_frame > render_frame}
            applicable: list[QueuedCommand] = []
            for item in due:
                self.late_frames += max(0, render_frame - item.target_frame)
                if item.expires_at_frame is not None and item.expires_at_frame <= render_frame:
                    continue
                applicable.append(item)
            return sorted(applicable, key=command_sort_key)

    def snapshot(self) -> tuple:
        with self._lock:
            return self._snapshot_unlocked()

    def _snapshot_unlocked(self) -> tuple:
        return (dict(self._continuous), list(self._reliable), self.last_command_seq)

    def _capture_unlocked(self) -> tuple:
        return (*self._snapshot_unlocked(), self.degraded, self.rebuild_required, self.late_frames)

    def _restore(self, value: tuple) -> None:
        (self._continuous, self._reliable, self.last_command_seq,
         self.degraded, self.rebuild_required, self.late_frames) = value

    @property
    def depth(self) -> int:
        with self._lock:
            return len(self._continuous) + len(self._reliable)
