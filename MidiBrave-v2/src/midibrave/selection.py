from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import time
from collections import defaultdict, deque
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import soundfile as sf
import torch
import yaml
from scipy.signal import resample_poly


CLASSES = ("pad", "lead", "base", "pluck", "texture")
QA_SOURCES = ("serum", "dexed", "sample")

TEXT_PROMPTS = {
    "pad": ("warm sustained synthesizer pad", "slow soft ambient pad"),
    "lead": ("bright monophonic synth lead", "clean flute or whistle lead"),
    "base": ("soft low synth bass", "electric bass fundamental"),
    "pluck": ("short dry tonal pluck", "harp or guitar-like pluck"),
    "texture": ("pitched granular texture", "tonal metallic broadband transient"),
}

STRONG_KEYWORDS = {
    "pad": ("pad", "warm", "atmos", "string", "strings", "choir", "ambient", "swell"),
    "lead": ("lead", "flute", "whistle", "reed", "solo", "bright", "synlead"),
    "base": ("bass", "sub", "low", "contra", "finger", "fretless"),
    "pluck": ("pluck", "guitar", "harp", "koto", "pizz", "pizzicato", "sitar", "short"),
    "texture": ("mallet", "metal", "bell", "bells", "vibe", "vibes", "marimba", "percussion", "grain", "glass"),
}

WEAK_KEYWORDS = {
    "pad": ("soft", "slow", "ensemble", "ens", "strg", "cloud"),
    "lead": ("mono", "horn", "voice", "sax"),
    "base": ("deep", "bottom", "fundamental"),
    "pluck": ("pick", "key", "piano", "clav", "arp"),
    "texture": ("noise", "digital", "motion", "effect", "impact", "wood", "perc", "chime"),
}

# Dexed contains many compact all-caps names (for example DEEPBASS and
# BASSORGAN2). Token-only matching loses the explicit "bass" evidence in
# these names. Keep this intentionally narrow so words such as "bassoon" or
# "embassy" cannot become false bass labels.
COMPACT_BASE = re.compile(
    r"^(?:bass(?:[0-9]+|organ[0-9]*|synth[0-9]*|syn[0-9]*|guitar[0-9]*)?"
    r"|(?:deep|hollow|low|moog[0-9]*|syn|synth|sub|contra)[a-z0-9]*bass[a-z0-9]*)$"
)

SERUM_CATEGORY = {
    "pad": "pad", "lead": "lead", "bass": "base", "pluck": "pluck",
    "synth": "texture", "keys": "texture",
}


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                rows.append(json.loads(line))
    return rows


def _write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
    temporary.replace(path)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _tokens(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", text.casefold()))


def keyword_scores(text: str) -> dict[str, float]:
    tokens = _tokens(text)
    if any(COMPACT_BASE.fullmatch(token) for token in tokens):
        tokens.add("bass")
    result: dict[str, float] = {}
    for class_name in CLASSES:
        if tokens.intersection(STRONG_KEYWORDS[class_name]):
            result[class_name] = 1.0
        elif tokens.intersection(WEAK_KEYWORDS[class_name]):
            result[class_name] = 0.7
        else:
            result[class_name] = 0.0
    return result


@dataclass(frozen=True)
class SourceSpec:
    dataset_id: str
    root: str
    priority: int


@dataclass(frozen=True)
class SelectionConfig:
    seed: int
    output_root: str
    clap_checkpoint: str
    cache_root: str
    sources: tuple[SourceSpec, ...]
    quota_per_class: int = 400
    family_cap_per_class: int = 20
    minimum_distinct_notes: int = 4
    minimum_valid_samples: int = 16384

    @classmethod
    def load(cls, path: str | Path) -> "SelectionConfig":
        raw = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
        sources = tuple(SourceSpec(
            dataset_id=str(item["dataset_id"]), root=str(item["root"]),
            priority=int(item["priority"]),
        ) for item in raw["sources"])
        return cls(
            seed=int(raw.get("seed", 20260720)),
            output_root=str(raw["output_root"]),
            clap_checkpoint=str(raw["clap_checkpoint"]),
            cache_root=str(raw["cache_root"]), sources=sources,
            quota_per_class=int(raw.get("quota_per_class", 400)),
            family_cap_per_class=int(raw.get("family_cap_per_class", 20)),
            minimum_distinct_notes=int(raw.get("minimum_distinct_notes", 4)),
            minimum_valid_samples=int(raw.get("minimum_valid_samples", 16384)),
        )


def _source_metadata(spec: SourceSpec) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    root = Path(spec.root)
    if spec.dataset_id in {"serum", "dexed"}:
        entities = _read_jsonl(root / "metadata" / "presets.jsonl")
        samples = _read_jsonl(root / "metadata" / "samples.jsonl")
        supplemental = root / "metadata" / "supplemental_samples.jsonl"
        if supplemental.is_file():
            samples.extend(_read_jsonl(supplemental))
    elif spec.dataset_id == "sample":
        entities = _read_jsonl(root / "metadata" / "instruments.jsonl")
        samples = _read_jsonl(root / "metadata" / "samples.jsonl")
        supplemental = root / "metadata" / "supplemental_samples.jsonl"
        if supplemental.is_file():
            samples.extend(_read_jsonl(supplemental))
    else:
        raise ValueError(f"unsupported dataset_id: {spec.dataset_id}")
    return entities, samples


def _entity_id(dataset_id: str, row: dict[str, Any]) -> str:
    key = "instrument_id" if dataset_id == "sample" else "preset_id"
    return str(row[key])


def _label_scores(dataset_id: str, entity: dict[str, Any]) -> dict[str, float]:
    if dataset_id == "serum":
        result = {name: 0.0 for name in CLASSES}
        mapped = SERUM_CATEGORY.get(str(entity.get("category", "")).casefold())
        if mapped is not None:
            result[mapped] = 1.0
        return result
    fields = [
        entity.get("preset_name"), entity.get("instrument_name"),
        entity.get("definition_path"), entity.get("source_audio_path"),
        entity.get("synth"),
    ]
    return keyword_scores(" ".join(str(value) for value in fields if value))


def _family(dataset_id: str, entity: dict[str, Any], samples: list[dict[str, Any]]) -> str:
    if dataset_id == "serum":
        return str(entity.get("bank") or _entity_id(dataset_id, entity))
    if dataset_id == "sample":
        if samples:
            source = str(samples[0].get("source_id") or "sample")
            path = str(samples[0].get("source_audio_path") or "")
            pack = Path(path.replace("\\", "/")).parts[:1]
            return source + (":" + pack[0] if pack else "")
    # Dexed source-patch provenance is unavailable; treating the entire synth
    # as one family would incorrectly cap the source to 20. Keep each patch as
    # its own auditable family and report source_patch_dedup_verifiable=false.
    return _entity_id(dataset_id, entity)


def _sample_usable(dataset_id: str, sample: dict[str, Any], cfg: SelectionConfig) -> bool:
    if int(sample.get("sample_rate", 0)) != 44100:
        return False
    if int(sample.get("num_samples", 0)) < cfg.minimum_valid_samples:
        return False
    if not math.isfinite(float(sample.get("median_cents_error", 0.0) or 0.0)):
        return False
    if abs(float(sample.get("median_cents_error", 0.0) or 0.0)) > 35.0:
        return False
    p95 = sample.get("p95_cents_error")
    if p95 is not None and float(p95) > 100.0:
        return False
    voiced = sample.get("voiced_frames")
    if voiced is not None and int(voiced) < 12:
        return False
    ratio = sample.get("voiced_ratio")
    if ratio is not None and float(ratio) < 0.15:
        return False
    periodicity = sample.get("periodicity")
    if periodicity is not None and float(periodicity) < 0.10:
        return False
    return dataset_id != "sample" or bool(sample.get("velocity_known", False))


def _hard_gate_samples(dataset_id: str, samples: list[dict[str, Any]], cfg: SelectionConfig) -> tuple[bool, list[str]]:
    reasons: list[str] = []
    usable = [sample for sample in samples if _sample_usable(dataset_id, sample, cfg)]
    notes = {int(item["midi_note"]) for item in usable}
    if len(notes) < cfg.minimum_distinct_notes:
        reasons.append(f"distinct_notes={len(notes)}<{cfg.minimum_distinct_notes}")
    if not usable:
        reasons.append("no_usable_samples")
    return not reasons, reasons


def inventory_candidates(cfg: SelectionConfig) -> dict[str, Any]:
    output = Path(cfg.output_root)
    rows: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    for spec in sorted(cfg.sources, key=lambda item: item.priority):
        entities, samples = _source_metadata(spec)
        grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for sample in samples:
            key = "instrument_id" if spec.dataset_id == "sample" else "preset_id"
            grouped[str(sample[key])].append(sample)
        for entity in entities:
            timbre_id = _entity_id(spec.dataset_id, entity)
            members = grouped.get(timbre_id, [])
            passed, reasons = _hard_gate_samples(spec.dataset_id, members, cfg)
            scores = _label_scores(spec.dataset_id, entity)
            if not passed or max(scores.values(), default=0.0) <= 0.0:
                rejected.append({
                    "dataset_id": spec.dataset_id, "timbre_id": timbre_id,
                    "reasons": reasons or ["no_reproducible_label_evidence"],
                })
                continue
            usable = [item for item in members if _sample_usable(spec.dataset_id, item, cfg)]
            rows.append({
                "dataset_id": spec.dataset_id,
                "dataset_root": str(Path(spec.root).resolve()),
                "priority": spec.priority,
                "timbre_id": timbre_id,
                "source_family": _family(spec.dataset_id, entity, usable),
                "label_scores": scores,
                "clap_scores": {name: 0.0 for name in CLASSES},
                "raw_clap_cosine": {name: 0.0 for name in CLASSES},
                "sample_ids": [str(item["sample_id"]) for item in usable],
                "source_patch_dedup_verifiable": entity.get("source_patch_dedup_verifiable"),
            })
    raw_path = output / "candidates.raw.jsonl"
    rejected_path = output / "rejected.inventory.jsonl"
    _write_jsonl(raw_path, rows)
    _write_jsonl(rejected_path, rejected)
    return {
        "candidates": len(rows), "rejected": len(rejected),
        "candidate_path": str(raw_path), "rejected_path": str(rejected_path),
        "candidate_sha256": _sha256(raw_path),
    }


def _anchor_rows(samples: list[dict[str, Any]], maximum: int = 8) -> list[dict[str, Any]]:
    by_note: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for sample in samples:
        by_note[int(sample["midi_note"])].append(sample)
    notes = sorted(by_note)
    if not notes:
        return []
    indices = np.linspace(0, len(notes) - 1, min(4, len(notes))).round().astype(int)
    chosen: list[dict[str, Any]] = []
    for index in dict.fromkeys(indices.tolist()):
        members = sorted(by_note[notes[index]], key=lambda row: (int(row.get("velocity", 64)), row["sample_id"]))
        if len(members) == 1:
            chosen.append(members[0])
        else:
            chosen.extend((members[0], members[-1]))
    return chosen[:maximum]


def _audio_embedding(model: Any, audio_path: Path, sample_rate: int, device: str) -> np.ndarray:
    audio, rate = sf.read(audio_path, dtype="float32", always_2d=True)
    if rate != sample_rate or audio.shape[1] != 1:
        raise ValueError(f"invalid formal audio: {audio_path}")
    mono = audio[:, 0]
    if rate != 48000:
        mono = resample_poly(mono, 160, 147).astype(np.float32)
    tensor = torch.from_numpy(mono).unsqueeze(0).to(device)
    with torch.no_grad():
        value = model.get_audio_embedding_from_data(tensor, use_tensor=True).float()
        value = torch.nn.functional.normalize(value, dim=-1)
    return value[0].cpu().numpy().astype(np.float32)


def score_candidate_clap(cfg: SelectionConfig, device: str = "cuda") -> dict[str, Any]:
    import laion_clap

    output = Path(cfg.output_root)
    candidates = _read_jsonl(output / "candidates.raw.jsonl")
    sample_lookup: dict[tuple[str, str], dict[str, Any]] = {}
    for spec in cfg.sources:
        _, samples = _source_metadata(spec)
        for sample in samples:
            sample_lookup[(spec.dataset_id, str(sample["sample_id"]))] = sample
    model = laion_clap.CLAP_Module(enable_fusion=False, amodel="HTSAT-base", device=device)
    model.load_ckpt(cfg.clap_checkpoint)
    model.eval()
    prompt_values: dict[str, np.ndarray] = {}
    with torch.no_grad():
        for class_name, prompts in TEXT_PROMPTS.items():
            embedding = model.get_text_embedding(list(prompts), use_tensor=True).float()
            embedding = torch.nn.functional.normalize(embedding.mean(dim=0, keepdim=True), dim=-1)
            prompt_values[class_name] = embedding[0].cpu().numpy()
    cache = Path(cfg.cache_root) / "clap"
    cache.mkdir(parents=True, exist_ok=True)
    cached_anchors = 0
    encoded_anchors = 0
    started = time.monotonic()
    for candidate_index, candidate in enumerate(candidates):
        members = [sample_lookup[(candidate["dataset_id"], sample_id)]
                   for sample_id in candidate["sample_ids"]]
        anchors = _anchor_rows(members)
        embeddings = []
        for sample in anchors:
            cache_id = hashlib.sha256(
                f"{candidate['dataset_id']}::{sample['sample_id']}".encode()
            ).hexdigest()
            path = cache / f"{cache_id}.npy"
            if path.is_file():
                value = np.load(path).astype(np.float32)
                cached_anchors += 1
            else:
                value = _audio_embedding(
                    model, Path(candidate["dataset_root"]) / sample["audio_path"],
                    int(sample["sample_rate"]), device,
                )
                temporary = path.with_suffix(".tmp.npy")
                np.save(temporary, value)
                temporary.replace(path)
                encoded_anchors += 1
            embeddings.append(value)
        mean = np.mean(embeddings, axis=0)
        mean /= max(float(np.linalg.norm(mean)), 1e-8)
        candidate["raw_clap_cosine"] = {
            name: float(np.dot(mean, prompt_values[name])) for name in CLASSES
        }
        candidate["anchor_sample_ids"] = [str(item["sample_id"]) for item in anchors]
        if (candidate_index + 1) % 50 == 0 or candidate_index + 1 == len(candidates):
            print(json.dumps({
                "event": "clap_selection_progress",
                "candidates_done": candidate_index + 1,
                "candidates_total": len(candidates),
                "cached_anchors": cached_anchors,
                "encoded_anchors": encoded_anchors,
                "elapsed_seconds": time.monotonic() - started,
            }, sort_keys=True), flush=True)
    # Percentile calibration is per source and class, exactly as the design
    # contract specifies. Stable hashes break ties reproducibly.
    by_source: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for candidate in candidates:
        by_source[candidate["dataset_id"]].append(candidate)
    for members in by_source.values():
        for class_name in CLASSES:
            ordered = sorted(members, key=lambda item: (
                item["raw_clap_cosine"][class_name],
                hashlib.sha256(item["timbre_id"].encode()).hexdigest(),
            ))
            denominator = max(1, len(ordered) - 1)
            for rank, candidate in enumerate(ordered):
                candidate["clap_scores"][class_name] = rank / denominator
    scored = output / "candidates.scored.jsonl"
    _write_jsonl(scored, candidates)
    return {
        "candidates": len(candidates), "path": str(scored), "sha256": _sha256(scored),
        "cached_anchors": cached_anchors, "encoded_anchors": encoded_anchors,
        "elapsed_seconds": time.monotonic() - started,
    }


class _Edge:
    __slots__ = ("to", "reverse", "capacity", "cost", "candidate", "class_name")

    def __init__(self, to: int, reverse: int, capacity: int, cost: int,
                 candidate: str | None = None, class_name: str | None = None):
        self.to = to
        self.reverse = reverse
        self.capacity = capacity
        self.cost = cost
        self.candidate = candidate
        self.class_name = class_name


def _add_edge(graph: list[list[_Edge]], source: int, target: int, capacity: int, cost: int,
              candidate: str | None = None, class_name: str | None = None) -> None:
    forward = _Edge(target, len(graph[target]), capacity, cost, candidate, class_name)
    backward = _Edge(source, len(graph[source]), 0, -cost)
    graph[source].append(forward)
    graph[target].append(backward)


def _tier_assignment(candidates: list[dict[str, Any]], remaining: dict[str, int],
                     family_cap: int) -> list[tuple[str, str]]:
    families = sorted({(row["source_family"], name) for row in candidates for name in CLASSES
                       if row["label_scores"][name] > 0.0 and remaining[name] > 0})
    source = 0
    candidate_base = 1
    family_base = candidate_base + len(candidates)
    class_base = family_base + len(families)
    sink = class_base + len(CLASSES)
    graph: list[list[_Edge]] = [[] for _ in range(sink + 1)]
    family_index = {value: family_base + index for index, value in enumerate(families)}
    class_index = {name: class_base + index for index, name in enumerate(CLASSES)}
    for index, candidate in enumerate(candidates):
        node = candidate_base + index
        _add_edge(graph, source, node, 1, 0)
        tie = int(hashlib.sha256(candidate["timbre_id"].encode()).hexdigest()[:6], 16) % 100
        for class_name in CLASSES:
            label = float(candidate["label_scores"][class_name])
            if label <= 0.0 or remaining[class_name] <= 0:
                continue
            clap = float(candidate["clap_scores"][class_name])
            score = 0.8 * label + 0.2 * clap
            _add_edge(
                graph, node, family_index[(candidate["source_family"], class_name)], 1,
                -int(round(score * 1_000_000)) + tie,
                str(candidate["timbre_id"]), class_name,
            )
    for family, class_name in families:
        _add_edge(graph, family_index[(family, class_name)], class_index[class_name], family_cap, 0)
    for class_name in CLASSES:
        _add_edge(graph, class_index[class_name], sink, remaining[class_name], 0)
    while True:
        distance = [10**30] * len(graph)
        parent: list[tuple[int, int] | None] = [None] * len(graph)
        queued = [False] * len(graph)
        distance[source] = 0
        queue = deque([source])
        queued[source] = True
        while queue:
            node = queue.popleft()
            queued[node] = False
            for edge_index, edge in enumerate(graph[node]):
                if edge.capacity <= 0 or distance[edge.to] <= distance[node] + edge.cost:
                    continue
                distance[edge.to] = distance[node] + edge.cost
                parent[edge.to] = (node, edge_index)
                if not queued[edge.to]:
                    queue.append(edge.to)
                    queued[edge.to] = True
        if parent[sink] is None:
            break
        node = sink
        while node != source:
            previous, edge_index = parent[node]  # type: ignore[misc]
            edge = graph[previous][edge_index]
            edge.capacity -= 1
            graph[node][edge.reverse].capacity += 1
            node = previous
    # Augmenting paths can contain reverse edges and re-route an assignment.
    # Recording one candidate per augmentation therefore preserves stale
    # history and can exceed a class quota. Extract the final unit flow from
    # candidate -> family edges only after the residual network converges.
    assignments: list[tuple[str, str]] = []
    for index in range(len(candidates)):
        node = candidate_base + index
        for edge in graph[node]:
            if edge.candidate is not None and edge.capacity == 0:
                assignments.append((edge.candidate, str(edge.class_name)))
    return assignments


def assign_candidates(cfg: SelectionConfig) -> dict[str, Any]:
    output = Path(cfg.output_root)
    candidates = _read_jsonl(output / "candidates.scored.jsonl")
    by_id = {(row["dataset_id"], row["timbre_id"]): row for row in candidates}
    remaining = {name: cfg.quota_per_class for name in CLASSES}
    selected: list[dict[str, Any]] = []
    used: set[tuple[str, str]] = set()
    for priority in sorted({int(row["priority"]) for row in candidates}):
        tier = [row for row in candidates if int(row["priority"]) == priority
                and (row["dataset_id"], row["timbre_id"]) not in used]
        # IDs are namespaced because Serum/Dexed identifiers are independent.
        namespaced = []
        id_map: dict[str, dict[str, Any]] = {}
        for row in tier:
            copy = dict(row)
            key = f"{row['dataset_id']}::{row['timbre_id']}"
            copy["timbre_id"] = key
            id_map[key] = row
            namespaced.append(copy)
        for key, class_name in _tier_assignment(namespaced, remaining, cfg.family_cap_per_class):
            row = id_map[key]
            identity = (row["dataset_id"], row["timbre_id"])
            if identity in used or remaining[class_name] <= 0:
                continue
            used.add(identity)
            remaining[class_name] -= 1
            selected.append({
                **row, "class_name": class_name,
                "label_score": float(row["label_scores"][class_name]),
                "clap_score": float(row["clap_scores"][class_name]),
                "selection_score": (0.8 * float(row["label_scores"][class_name])
                                    + 0.2 * float(row["clap_scores"][class_name])),
            })
    for class_name in CLASSES:
        members = [row for row in selected if row["class_name"] == class_name]
        members.sort(key=lambda row: hashlib.sha256(
            f"{cfg.seed}:{row['dataset_id']}:{row['timbre_id']}".encode()).hexdigest())
        for index, row in enumerate(members):
            row["split"] = "train" if index < 360 else "validation" if index < 380 else "test"
    selected_path = output / "selected_timbres.jsonl"
    _write_jsonl(selected_path, sorted(selected, key=lambda row: (row["class_name"], row["split"], row["timbre_id"])))
    samples_by_source: dict[str, dict[str, dict[str, Any]]] = {}
    for spec in cfg.sources:
        _, samples = _source_metadata(spec)
        samples_by_source[spec.dataset_id] = {str(row["sample_id"]): row for row in samples}
    manifest_paths: dict[str, str] = {}
    for class_name in CLASSES:
        rows = []
        for chosen in selected:
            if chosen["class_name"] != class_name:
                continue
            for sample_id in chosen["sample_ids"]:
                sample = dict(samples_by_source[chosen["dataset_id"]][sample_id])
                sample.update({
                    "dataset_id": chosen["dataset_id"],
                    "timbre_id": chosen["timbre_id"],
                    "class_name": class_name, "split": chosen["split"],
                    "velocity_known": bool(sample.get("velocity_known", True)),
                    "label_score": chosen["label_score"],
                    "clap_score": chosen["clap_score"],
                    "selection_score": chosen["selection_score"],
                })
                # Preserve null source-only fields. The unified training label
                # is the measured midi_note, never a fabricated sent note.
                sample.setdefault("preset_id", chosen["timbre_id"])
                sample.setdefault("instrument_id", None)
                sample.setdefault("render_gain_db", 0.0)
                rows.append(sample)
        path = output / f"{class_name}.jsonl"
        _write_jsonl(path, rows)
        meta_path = output / f"{class_name}.meta.json"
        meta = {
            "schema": 2,
            "class_name": class_name,
            "selected_timbres": sum(row["class_name"] == class_name for row in selected),
            "samples": len(rows),
            "eligible_manifest_sha256": _sha256(path),
            "selection_manifest_sha256": _sha256(selected_path),
            "qa_score_formula": "0.8*label_score+0.2*clap_score",
            "dataset_roots": {item.dataset_id: str(Path(item.root).resolve())
                              for item in cfg.sources},
        }
        meta_path.write_text(json.dumps(meta, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        manifest_paths[class_name] = str(path)
    counts = {name: cfg.quota_per_class - remaining[name] for name in CLASSES}
    report = {
        "schema": 1, "counts": counts, "shortfall": remaining,
        "unique_timbres": len(used), "selected_sha256": _sha256(selected_path),
        "manifests": {name: {"path": path, "sha256": _sha256(Path(path))}
                      for name, path in manifest_paths.items()},
        "qa_score_formula": "0.8*label_score+0.2*clap_score",
        "texture_tonal_only": True,
    }
    report_path = output / "selection_report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return {"report": str(report_path), **report}


def run_selection(config_path: str, stage: str, device: str) -> dict[str, Any]:
    cfg = SelectionConfig.load(config_path)
    if stage == "inventory":
        return inventory_candidates(cfg)
    if stage == "clap":
        return score_candidate_clap(cfg, device)
    if stage == "assign":
        assignment = assign_candidates(cfg)
        if any(int(value) > 0 for value in assignment["shortfall"].values()):
            raise RuntimeError(f"selection quota shortfall: {assignment['shortfall']}")
        return assignment
    inventory = inventory_candidates(cfg)
    clap = score_candidate_clap(cfg, device)
    assignment = assign_candidates(cfg)
    if any(int(value) > 0 for value in assignment["shortfall"].values()):
        raise RuntimeError(f"selection quota shortfall: {assignment['shortfall']}")
    return {"inventory": inventory, "clap": clap, "assignment": assignment}


def main() -> None:
    parser = argparse.ArgumentParser(description="Deterministic five-class MidiBrave selector")
    parser.add_argument("--config", required=True)
    parser.add_argument("--stage", choices=("inventory", "clap", "assign", "all"), default="all")
    parser.add_argument("--device", default="cuda")
    args = parser.parse_args()
    print(json.dumps(run_selection(args.config, args.stage, args.device), sort_keys=True))


if __name__ == "__main__":
    main()
