"""试听素材生成器 —— 把音源渲染成一目录 WAV,供人耳过一遍。

`audit_notes.py` 出数字,这个出声音。两者互补:数字能证伪(音高偏了 40 cents、
velocity 反了),但证明不了「像不像那个音色」「起音有没有抖」「尾音干不干净」——
这些只有耳朵知道。Phase 1 权重没跑对抗微调,音质上限本来就有限,更需要实际听。

产出三组:

    scale      半音阶 / 八度阶,横跨训练音域 31–95 —— 听音区一致性,
               尤其是两个边界附近有没有塌陷
    velocity   同一个音的 v50 / v127 对照 —— 听力度差是响度差还是音色差
    sustain    长音 —— 听尾音、循环感、有没有慢性漂移或爆音

另出一个 `contact_sheet.wav`:把所有测试点按顺序拼成一条,中间垫静音。
逐个点开 40 个文件没人受得了,一条连播 30 秒就能听出哪里不对。

用法::

    python3 tools/render_grid.py --self-test              # 正弦波跑通全流程
    python3 tools/render_grid.py --render server.backends.brave:make_render \\
        --out-dir staging/grid_brave
"""
from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np

# 与验收器共用底层工具:两个工具对「音高」「WAV 格式」的定义必须是同一套,
# 各写一份迟早会漂移成两个标准。
from audit_notes import (
    MIDI_MAX,
    MIDI_MIN,
    SAMPLE_RATE,
    TRAIN_VELOCITIES,
    RenderFn,
    load_render,
    make_sine_render,
    midi_to_hz,
    rms_db,
    write_wav,
)

#: 全音阶(C 大调)音级,用来铺音阶而不是铺半音 —— 半音阶听着累,
#: 全音阶更容易听出哪一级的音色跳了。
_MAJOR_STEPS: tuple[int, ...] = (0, 2, 4, 5, 7, 9, 11)

CONTACT_GAP_SECONDS = 0.35
"""拼条时测试点之间的静音间隔。留够余量,免得前一个音的尾巴糊进下一个音。"""


@dataclass(frozen=True)
class GridItem:
    """一个待渲染的试听点。"""

    group: str
    midi: int
    velocity: int
    duration: float

    @property
    def filename(self) -> str:
        return f"{self.group}_n{self.midi:03d}_v{self.velocity:03d}_{self.duration:g}s.wav"


def octave_scale(
    low: int = MIDI_MIN, high: int = MIDI_MAX, step: int = 12
) -> list[int]:
    """从 low 到 high 每隔 step 个半音取一个音,并**保证收尾踩到 high**。

    边界必须踩到:分布外的塌陷总是从音域两端先出现,而等距取点很容易正好跳过 95。
    """
    notes = list(range(low, high + 1, step))
    if notes[-1] != high:
        notes.append(high)
    return notes


def major_scale(root: int = 60, octaves: int = 1) -> list[int]:
    """从 root 起的大调音阶,含收尾的高八度主音。越界的音会被夹在训练音域内。"""
    notes: list[int] = []
    for octave in range(octaves):
        notes.extend(root + octave * 12 + step for step in _MAJOR_STEPS)
    notes.append(root + octaves * 12)
    return [n for n in notes if MIDI_MIN <= n <= MIDI_MAX]


def build_grid(
    *,
    scale_step: int = 12,
    scale_duration: float = 1.5,
    velocity_notes: tuple[int, ...] = (36, 48, 60, 72, 84),
    velocity_duration: float = 1.5,
    sustain_notes: tuple[int, ...] = (36, 60, 84),
    sustain_duration: float = 6.0,
    melodic_root: int = 60,
) -> list[GridItem]:
    """拼出完整的试听点清单。"""
    items: list[GridItem] = []

    # 1) 跨音域八度阶 —— 音区一致性
    for midi in octave_scale(step=scale_step):
        items.append(GridItem("scale", midi, TRAIN_VELOCITIES[1], scale_duration))

    # 2) 一条大调音阶 —— 旋律语境下更容易听出音准问题
    for midi in major_scale(melodic_root):
        items.append(GridItem("melodic", midi, TRAIN_VELOCITIES[1], 0.8))

    # 3) 力度对照 —— 只用训练里存在的两档,中间值禁止插值(BRIEF.md)
    for midi in velocity_notes:
        for velocity in TRAIN_VELOCITIES:
            items.append(GridItem("velocity", midi, velocity, velocity_duration))

    # 4) 长音 —— 6 s 是前端 unperchToRelease 的上限,压着上限听尾音
    for midi in sustain_notes:
        items.append(GridItem("sustain", midi, TRAIN_VELOCITIES[1], sustain_duration))

    return items


def render_grid(
    render: RenderFn,
    out_dir: Path,
    items: list[GridItem] | None = None,
    *,
    sample_rate: int = SAMPLE_RATE,
    contact_sheet: bool = True,
    verbose: bool = True,
) -> list[tuple[GridItem, Path, float]]:
    """渲染全部试听点并落盘,返回 [(点, 路径, RMS dB)]。"""
    items = items if items is not None else build_grid()
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    rendered: list[tuple[GridItem, Path, float]] = []
    pieces: list[np.ndarray] = []
    gap = np.zeros(int(sample_rate * CONTACT_GAP_SECONDS), dtype=np.float64)

    for item in items:
        audio = np.asarray(
            render(item.midi, item.velocity, item.duration), dtype=np.float64
        ).reshape(-1)
        # 拼条前先清掉非有限值,否则一个 NaN 会顺着 concatenate 污染整条试听带,
        # 让人误以为整个音源都坏了。单点的 WAV 保持原样,故障留在原处可见。
        clean = np.nan_to_num(audio, nan=0.0, posinf=0.0, neginf=0.0)

        path = out_dir / item.filename
        write_wav(path, audio, sample_rate)
        level = rms_db(audio)
        rendered.append((item, path, level))
        pieces.extend((clean, gap))

        if verbose:
            print(
                f"  {item.group:<8} note {item.midi:>3} "
                f"({midi_to_hz(item.midi):7.1f} Hz)  v{item.velocity:<3} "
                f"{item.duration:>4.1f}s  {level:6.1f} dB  → {path.name}"
            )

    if contact_sheet and pieces:
        sheet_path = out_dir / "contact_sheet.wav"
        write_wav(sheet_path, np.concatenate(pieces), sample_rate)
        total = sum(len(p) for p in pieces) / sample_rate
        if verbose:
            print(f"\n  连播带:{sheet_path.name}({total:.1f} s,{len(items)} 个点)")

    _write_index(out_dir, rendered)
    return rendered


def _write_index(out_dir: Path, rendered: list[tuple[GridItem, Path, float]]) -> None:
    """写一份清单,标注每个文件是什么、该听什么。

    一目录裸 WAV 过两天就没人记得 `scale_n095_v127_1.5s.wav` 是干嘛的了。
    """
    lines = ["# 试听素材清单", ""]
    lines.append(f"共 {len(rendered)} 个测试点,采样率 {SAMPLE_RATE} Hz mono 16-bit。")
    lines.append("")
    lines.append("先听 `contact_sheet.wav`(全部连播),定位到可疑的点再开单个文件。")
    lines.append("")

    guides = {
        "scale": "跨音域八度阶。听**音区一致性**:低音区有没有糊、高音区有没有变尖变薄,"
                 f"以及边界 {MIDI_MIN} / {MIDI_MAX} 是否明显塌陷(越界即分布外)。",
        "melodic": "C 大调音阶。旋律语境下音准问题比孤立单音更容易听出来。",
        "velocity": f"力度对照。训练只有 v{TRAIN_VELOCITIES[0]} / v{TRAIN_VELOCITIES[1]} 两档。"
                    "听差异是**只有响度**还是**连音色也变了**——后者才说明力度真进了条件。",
        "sustain": "长音(6 s,前端 durationSeconds 上限)。听尾音、循环痕迹、"
                   "慢性漂移、块边界爆音。",
    }

    for group in ("scale", "melodic", "velocity", "sustain"):
        rows = [r for r in rendered if r[0].group == group]
        if not rows:
            continue
        lines.append(f"## {group}")
        lines.append("")
        lines.append(guides[group])
        lines.append("")
        lines.append("| 文件 | note | 频率 (Hz) | velocity | 时长 | RMS (dB) |")
        lines.append("| --- | --- | --- | --- | --- | --- |")
        for item, path, level in rows:
            lines.append(
                f"| `{path.name}` | {item.midi} | {midi_to_hz(item.midi):.1f} | "
                f"{item.velocity} | {item.duration:g}s | {level:.1f} |"
            )
        lines.append("")

    lines.append("---")
    lines.append("")
    lines.append("量化判据见 `docs/audit.md`,跑 `tools/audit_notes.py` 出数字报告。")
    (out_dir / "INDEX.md").write_text("\n".join(lines), encoding="utf-8")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="试听素材渲染器")
    parser.add_argument(
        "--render", default=None,
        help="render 回调,格式 module:attr(不给则用正弦波假 render)",
    )
    parser.add_argument("--self-test", action="store_true", help="用正弦波跑通全流程")
    parser.add_argument("--out-dir", default="staging/grid", help="WAV 落盘目录")
    parser.add_argument("--scale-step", type=int, default=12, help="音阶步长(半音)")
    parser.add_argument("--sustain-duration", type=float, default=6.0, help="长音时长(秒)")
    parser.add_argument("--no-contact-sheet", action="store_true", help="不生成连播带")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

    if args.render:
        render = load_render(args.render)
        label = args.render
    else:
        render = make_sine_render()
        label = "sine(自测基准)"

    out_dir = Path(args.out_dir)
    items = build_grid(
        scale_step=args.scale_step, sustain_duration=args.sustain_duration
    )

    print(f"渲染对象:{label}")
    print(f"测试点:{len(items)} 个  →  {out_dir}/")
    print("-" * 74)

    rendered = render_grid(
        render, out_dir, items, contact_sheet=not args.no_contact_sheet
    )

    print("-" * 74)
    print(f"完成:{len(rendered)} 个 WAV + INDEX.md")

    if args.self_test:
        return _self_test_assertions(rendered, out_dir)
    return 0


def _self_test_assertions(
    rendered: list[tuple[GridItem, Path, float]], out_dir: Path
) -> int:
    """自测:全流程跑通,且产出的文件真的能用。

    只检查渲染管线本身(文件写出来了、不空、音域没越界、力度两档都在),
    音质判定不归这里 —— 那是 audit_notes.py 的活。
    """
    print("-" * 74)
    print("自测断言:")
    failures: list[str] = []

    if not rendered:
        failures.append("一个测试点都没渲染出来")

    for item, path, level in rendered:
        if not path.exists() or path.stat().st_size <= 44:  # 44 = WAV 头长度
            failures.append(f"{path.name} 没写出来或是空文件")
        if not (MIDI_MIN <= item.midi <= MIDI_MAX):
            failures.append(f"{path.name} 的 note {item.midi} 越出训练音域")
        if item.velocity not in TRAIN_VELOCITIES:
            failures.append(f"{path.name} 用了训练里不存在的 velocity {item.velocity}")
        if level <= -119.0:
            failures.append(f"{path.name} 是静音")

    sheet = out_dir / "contact_sheet.wav"
    if not sheet.exists():
        failures.append("连播带没生成")
    if not (out_dir / "INDEX.md").exists():
        failures.append("INDEX.md 没生成")

    groups = {item.group for item, _, _ in rendered}
    for expected in ("scale", "melodic", "velocity", "sustain"):
        if expected not in groups:
            failures.append(f"缺少 {expected} 组")

    # 音域边界必须真的被踩到 —— 这是 scale 组存在的主要理由
    scale_notes = {item.midi for item, _, _ in rendered if item.group == "scale"}
    for boundary in (MIDI_MIN, MIDI_MAX):
        if boundary not in scale_notes:
            failures.append(f"音阶没踩到边界 note {boundary}")

    if failures:
        for item in failures:
            print(f"  ❌ {item}")
        return 1

    print(f"  ✅ {len(rendered)} 个 WAV 全部有效,四组齐全,音域边界 "
          f"{MIDI_MIN}/{MIDI_MAX} 已覆盖")
    print("自测通过。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
