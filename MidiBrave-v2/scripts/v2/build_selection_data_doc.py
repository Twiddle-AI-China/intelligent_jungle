#!/usr/bin/env python3
"""Generate the audited five-class Top-400 Markdown data catalogue."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
from collections import Counter, defaultdict
from pathlib import Path, PurePosixPath
from typing import Any


CLASSES = ("pad", "lead", "base", "pluck", "texture")
REMOTE_MANIFEST_ROOT = "/data/midibrave-v2/manifests"


def rows(path: Path):
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                yield json.loads(line)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def percentile(values: list[float], q: float) -> float:
    ordered = sorted(values)
    position = (len(ordered) - 1) * q
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] * (upper - position) + ordered[upper] * (position - lower)


def score_summary(values: list[float]) -> str:
    return (f"{min(values):.6f} / {percentile(values, .10):.6f} / "
            f"{statistics.median(values):.6f} / {statistics.mean(values):.6f} / "
            f"{percentile(values, .90):.6f} / {max(values):.6f}")


def md(value: Any) -> str:
    return str(value if value is not None else "—").replace("|", "\\|").replace("\n", " ")


def entity_label(dataset: str, entity: dict[str, Any]) -> str:
    if dataset == "serum":
        return f"{entity.get('preset_name', '—')} (category={entity.get('category', '—')})"
    if dataset == "dexed":
        return f"{entity.get('preset_name', '—')} (synth={entity.get('synth', 'Dexed')})"
    return str(entity.get("instrument_name") or entity.get("definition_path") or "—")


def parse_mapping(values: list[str]) -> dict[str, Path]:
    result: dict[str, Path] = {}
    for value in values:
        name, raw_path = value.split("=", 1)
        result[name] = Path(raw_path)
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--selected", type=Path, required=True)
    parser.add_argument("--manifest", action="append", default=[], metavar="CLASS=PATH")
    parser.add_argument("--entity", action="append", default=[], metavar="DATASET=PATH")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--date", default="2026-07-20")
    args = parser.parse_args()
    manifests = parse_mapping(args.manifest)
    entity_paths = parse_mapping(args.entity)
    if set(manifests) != set(CLASSES):
        raise ValueError(f"need exactly five class manifests: {sorted(manifests)}")
    if set(entity_paths) != {"serum", "dexed", "sample"}:
        raise ValueError("need serum, dexed and sample entity metadata")

    selected = list(rows(args.selected))
    by_class = {name: [row for row in selected if row["class_name"] == name]
                for name in CLASSES}
    if any(len(values) != 400 for values in by_class.values()):
        raise ValueError({name: len(values) for name, values in by_class.items()})
    identities = [(row["dataset_id"], row["timbre_id"]) for row in selected]
    if len(set(identities)) != 2000:
        raise ValueError("selected timbres are not globally unique")

    entities: dict[tuple[str, str], dict[str, Any]] = {}
    for dataset, path in entity_paths.items():
        key_name = "instrument_id" if dataset == "sample" else "preset_id"
        for row in rows(path):
            entities[(dataset, str(row[key_name]))] = row

    aggregates: dict[tuple[str, str], dict[str, Any]] = {}
    manifest_hashes: dict[str, str] = {}
    class_sample_totals: Counter[str] = Counter()
    class_hours: Counter[str] = Counter()
    class_split_samples: dict[str, Counter[str]] = defaultdict(Counter)
    for class_name, path in manifests.items():
        manifest_hashes[class_name] = sha256(path)
        for sample in rows(path):
            key = (str(sample["dataset_id"]), str(sample["timbre_id"]))
            value = aggregates.setdefault(key, {
                "sample_ids": set(), "notes": set(), "velocities": set(),
                "seconds": 0.0, "representative": None, "split": sample["split"],
            })
            value["sample_ids"].add(str(sample["sample_id"]))
            value["notes"].add(int(sample["midi_note"]))
            value["velocities"].add(int(sample["velocity"]))
            value["seconds"] += float(sample["duration_seconds"])
            relative = str(sample["audio_path"]).replace("\\", "/")
            if value["representative"] is None or relative < value["representative"]:
                value["representative"] = relative
            class_sample_totals[class_name] += 1
            class_hours[class_name] += float(sample["duration_seconds"]) / 3600.0
            class_split_samples[class_name][str(sample["split"])] += 1

    formula_error = 0.0
    for row in selected:
        key = (row["dataset_id"], row["timbre_id"])
        if key not in aggregates:
            raise ValueError(f"missing manifest samples for {key}")
        expected_ids = set(map(str, row["sample_ids"]))
        if aggregates[key]["sample_ids"] != expected_ids:
            raise ValueError(f"sample membership mismatch for {key}")
        formula_error = max(formula_error, abs(
            float(row["selection_score"])
            - (0.8 * float(row["label_score"]) + 0.2 * float(row["clap_score"]))
        ))

    roots = {row["dataset_id"]: row["dataset_root"] for row in selected}
    output: list[str] = [
        "# MidiBrave 五类 Top-400 正式数据汇总",
        "",
        f"生成日期：{args.date}  ",
        "状态：正式 CLAP 评分与全局互斥分配已完成；本文档记录 cache finalization 前的 Top-400 选择全集。",
        "",
        "## 1. 数据位置与口径",
        "",
        f"- Octopus 选择总表：`{REMOTE_MANIFEST_ROOT}/selected_timbres.jsonl`",
        f"- 五类样本 manifest：`{REMOTE_MANIFEST_ROOT}/{{pad,lead,base,pluck,texture}}.jsonl`",
        f"- 选择报告：`{REMOTE_MANIFEST_ROOT}/selection_report.json`",
        "- 训练缓存：`/data/midibrave-v2/cache/<class>`",
        "- 训练前会生成 cache-eligible 冻结版本；被窗口级 pitch/cache 门禁剔除的样本不会改变本文记录的原始 Top-400 归属。",
        "",
        "数据根目录：",
        "",
    ]
    for dataset in ("serum", "dexed", "sample"):
        output.append(f"- `{dataset}`：`{roots[dataset]}`")
    output.extend([
        "",
        "已 QA 数据的类别分数严格为：",
        "",
        "$$S = 0.80 S_{label} + 0.20 S_{CLAP}$$",
        "",
        "其中 CLAP 是同一数据源、同一类别内的 percentile rank；`raw cosine` 仅供审计。分配先遵守来源优先级 Serum > Dexed v2 > sample v2，再在每个来源层内做全局最小费用流，因此不同来源的总分不能直接解释为跨来源全局排名。",
        "",
        "### 1.1 标签与 CLAP 语义来源",
        "",
        "- Serum：原生 `category` 为主标签；`preset_name` 与 `bank` 只作审计，不覆盖原生类别。",
        "- Dexed v2：`preset_name`、synth 与版本化强/弱关键词；紧凑 Base 复合词规则只识别明确的 `BASS*` 或限定前缀+`bass`。",
        "- sample v2：`instrument_name`、`definition_path`、source/pack 与 articulation；默认训练只接收 `velocity_known=true`。",
        "- 名称无标签证据时保持 0，不使用 CLAP 伪造类别标签；0.7 表示高可信弱兼容，1.0 表示明确匹配。",
        "",
        "| 类别 | 固定 CLAP prompts |",
        "|---|---|",
        "| pad | warm sustained synthesizer pad；slow soft ambient pad |",
        "| lead | bright monophonic synth lead；clean flute or whistle lead |",
        "| base | soft low synth bass；electric bass fundamental |",
        "| pluck | short dry tonal pluck；harp or guitar-like pluck |",
        "| texture | pitched granular texture；tonal metallic broadband transient |",
        "",
        "## 2. 完整性检查",
        "",
        "| 检查项 | 结果 |",
        "|---|---:|",
        f"| 总 timbre | {len(selected):,} |",
        f"| 全局唯一 timbre | {len(set(identities)):,} |",
        f"| 每类 | 400 |",
        f"| 总分公式最大绝对误差 | {formula_error:.3e} |",
        f"| selected_timbres SHA256 | `{sha256(args.selected)}` |",
        "",
        "## 3. 五类汇总",
        "",
        "分数统计顺序均为 `min / P10 / median / mean / P90 / max`。",
        "",
        "| 类别 | timbre | 来源（Serum/Dexed/sample） | 标签分布 | families / 单 family 最大数 | 样本 | 总时长(h) | split timbre | split 样本 |",
        "|---|---:|---|---|---|---:|---:|---|---|",
    ])
    for class_name in CLASSES:
        values = by_class[class_name]
        source = Counter(row["dataset_id"] for row in values)
        labels = Counter(float(row["label_score"]) for row in values)
        families = Counter((row["dataset_id"], row["source_family"]) for row in values)
        splits = Counter(row["split"] for row in values)
        output.append(
            f"| {class_name} | 400 | {source['serum']}/{source['dexed']}/{source['sample']} | "
            f"{', '.join(f'{score:g}:{count}' for score, count in sorted(labels.items(), reverse=True))} | "
            f"{len(families)} / {max(families.values())} | {class_sample_totals[class_name]:,} | "
            f"{class_hours[class_name]:.3f} | "
            f"{splits['train']}/{splits['validation']}/{splits['test']} | "
            f"{class_split_samples[class_name]['train']:,}/"
            f"{class_split_samples[class_name]['validation']:,}/"
            f"{class_split_samples[class_name]['test']:,} |"
        )
    output.extend([
        "",
        "### 3.1 评分分布",
        "",
        "| 类别 | label | CLAP percentile | raw cosine | 最终总分 |",
        "|---|---|---|---|---|",
    ])
    for class_name in CLASSES:
        values = by_class[class_name]
        output.append(
            f"| {class_name} | {score_summary([float(row['label_score']) for row in values])} | "
            f"{score_summary([float(row['clap_score']) for row in values])} | "
            f"{score_summary([float(row['raw_clap_cosine'][class_name]) for row in values])} | "
            f"{score_summary([float(row['selection_score']) for row in values])} |"
        )
    output.extend([
        "",
        "### 3.2 正式 manifest 哈希",
        "",
        "| 类别 | Octopus 路径 | SHA256 |",
        "|---|---|---|",
    ])
    for class_name in CLASSES:
        output.append(
            f"| {class_name} | `{REMOTE_MANIFEST_ROOT}/{class_name}.jsonl` | "
            f"`{manifest_hashes[class_name]}` |"
        )

    output.extend([
        "",
        "## 4. 每类 Top-400 逐条明细",
        "",
        "排序为 `source priority ASC → selection_score DESC → timbre_id ASC`。`MIDI` 显示 `min–max (distinct)`；代表音频为该 timbre manifest 中字典序第一条相对路径，需与本节上方对应数据根目录拼接。",
    ])
    for class_name in CLASSES:
        output.extend([
            "",
            f"### 4.{CLASSES.index(class_name) + 1} {class_name} Top 400",
            "",
            "| # | split | timbre / 原生标签 | 来源 / family | label | CLAP% | raw cosine | 总分 | 样本 | MIDI | velocity | 时长(h) | 代表 audio_path |",
            "|---:|---|---|---|---:|---:|---:|---:|---:|---|---|---:|---|",
        ])
        ordered = sorted(by_class[class_name], key=lambda row: (
            int(row["priority"]), -float(row["selection_score"]), str(row["timbre_id"])))
        for rank, row in enumerate(ordered, 1):
            key = (row["dataset_id"], row["timbre_id"])
            aggregate = aggregates[key]
            entity = entities.get(key, {})
            notes = sorted(aggregate["notes"])
            velocities = sorted(aggregate["velocities"])
            representative = PurePosixPath(str(aggregate["representative"])).as_posix()
            output.append(
                f"| {rank} | {md(row['split'])} | `{md(row['timbre_id'])}`<br>{md(entity_label(row['dataset_id'], entity))} | "
                f"{md(row['dataset_id'])}<br>{md(row['source_family'])} | {float(row['label_score']):.3f} | "
                f"{float(row['clap_score']):.6f} | {float(row['raw_clap_cosine'][class_name]):.6f} | "
                f"{float(row['selection_score']):.6f} | {len(aggregate['sample_ids'])} | "
                f"{notes[0]}–{notes[-1]} ({len(notes)}) | {md(','.join(map(str, velocities)))} | "
                f"{aggregate['seconds'] / 3600.0:.4f} | `{md(representative)}` |"
            )

    output.extend([
        "",
        "## 5. 使用说明",
        "",
        "- 训练与复现实验应读取对应 class manifest，不要从本 Markdown 反向解析数据。",
        "- `label_score` 是可复现 metadata 标签证据；`CLAP%` 是来源内 percentile，不是概率。",
        "- Top-400 是 timbre 级互斥集合；表中“样本”是该 timbre 的 MIDI/velocity 音频条数。",
        "- Lead 当前资格训练使用缓存 finalization 后的同名 canonical manifest，最终保留数与剔除原因见 `/data/midibrave-v2/reports/lead_cache_finalization.json`。",
        "- Texture 本版全部按 tonal pitch 硬门禁筛选，没有启用无音高 fallback。",
    ])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("\n".join(output) + "\n", encoding="utf-8")
    print(json.dumps({
        "output": str(args.output.resolve()), "rows": len(selected),
        "bytes": args.output.stat().st_size, "sha256": sha256(args.output),
    }, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
