"""服务配置。

端口 8090 是**硬约束**:Spark 上 22 / 4173 / 7890 / 8081(vLLM 生产)/ 8083 /
8086 / 8766 / 8888 / 9090 / 9418 都被占了,本项目只用 8090,不要改成别的去试探。

采样率 44100 跟着 midiBrave 走（BRIEF.md:44.1 kHz mono）。当前块长 4096，
单块预算 4096 / 44100 ≈ 92.88 ms。

源码开发默认 voice 池长度为 4；生产 Docker 显式使用 pool 5。运行期不可变：
改池长度等于重建所有声部的跨块状态。

四轨计算仍使用 ``OMP_NUM_THREADS=16``（deploy/docker-run.sh）。机器与其他推理服务
共享资源，性能判断必须同时记录当时负载；不要从旧 block 配置外推当前端到端延迟。
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass

DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8090
DEFAULT_SAMPLE_RATE = 44_100
#: 神经后端(brave / brave-voices)的 torch 计算设备。程序合成后端不吃这个参数,
#: 不受影响。默认 cpu —— 换成 cuda 前先确认宿主机 torch 是 CUDA 版本
#: (容器镜像目前故意装的是 CPU-only wheel,见 deploy/Dockerfile 的说明)。
DEFAULT_DEVICE = "cpu"
#: 块长 = 每轮渲染并下发的样本数,也是硬截止时间(4096/44100 = 92.88 ms)。
#: 4096 用来吸收共享 GPU 的亚秒级渲染尖峰；它仍是
#: geometry.samples_per_latent 的整数倍，逐样本/离线一致性约束不变。
#: 该数只决定单块几何，端到端延迟还要叠加 pacing target、网络与浏览器 outputLatency。
DEFAULT_BLOCK_SAMPLES = 4096
DEFAULT_POOL_SIZE = 4          # 源码开发默认；生产由 Docker 显式传 pool 5

#: 客户端 worklet 攒够这么多帧才起播(基线约定)。低于此值服务端加速发送。
PRIME_FRAMES = 4096
#: 缓冲超过这么多帧就减速,避免无限堆积。
#: 当前 19000 / 44100 ≈ 430.84 ms，比 TARGET_FRAMES=13000 高约 46%，
#: 避免稳态附近误触发减速档。
HIGH_WATER_FRAMES = 19000

#: 训练数据边界(BRIEF.md)。越界即分布外,服务层负责夹紧后再喂给后端。
MIDI_MIN = 31
MIDI_MAX = 95
#: note 时长范围,对齐前端 ``unperchToRelease``。
DURATION_MIN_SECONDS = 0.25
DURATION_MAX_SECONDS = 6.0
#: gate/hold 起音没有声明时长,但 v2 的随机激励缓冲要在 note_on 时按
#: 「这个音会播多久」一次性生成。hold 按住多久事先不知道,先按这个上限
#: 备缓冲;按得更久就由 excitation_bands 的末帧冻结兜底(听感无感,不炸)。
GATE_NOTE_BUFFER_SECONDS = 30.0


@dataclass(frozen=True)
class EngineConfig:
    """一次服务运行的全部配置。"""

    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    sample_rate: int = DEFAULT_SAMPLE_RATE
    block_samples: int = DEFAULT_BLOCK_SAMPLES
    pool_size: int = DEFAULT_POOL_SIZE
    backend: str = "synth"          # synth | brave | brave-voices | silent
    model_path: str | None = None   # brave 后端用
    device: str = DEFAULT_DEVICE    # 神经后端用:cpu / cuda / cuda:N
    static: str | None = None

    @property
    def block_seconds(self) -> float:
        """一块音频的时长。发送节奏以此为基准。"""
        return self.block_samples / self.sample_rate

    def validate(self) -> None:
        if self.pool_size < 1:
            raise ValueError("voice 池长度必须 >= 1")
        if self.block_samples < 64:
            raise ValueError("块太小,调度开销会盖过渲染")
        if self.sample_rate not in (16_000, 22_050, 32_000, 44_100, 48_000):
            raise ValueError(f"不常见的采样率: {self.sample_rate}")
        if not (1024 <= self.port <= 65535):
            raise ValueError(f"端口越界: {self.port}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="flock-voice-engine 实时音源服务")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--sample-rate", type=int, default=DEFAULT_SAMPLE_RATE)
    parser.add_argument("--block-samples", type=int, default=DEFAULT_BLOCK_SAMPLES)
    parser.add_argument("--pool-size", type=int, default=DEFAULT_POOL_SIZE)
    parser.add_argument(
        "--backend", default="synth",
        help="synth=S 档程序合成兜底 / silent=全零占位 / 任意已注册的 backend_id "
             "/ '模块:类名'。未知名字会回落到 synth,不会让服务起不来",
    )
    parser.add_argument("--model-path", default=None, help="brave 后端的权重路径")
    parser.add_argument(
        "--device", default=DEFAULT_DEVICE,
        help="神经后端(brave / brave-voices)的 torch 设备,如 cpu / cuda / cuda:0。"
             "程序合成后端不吃这个参数,给了也会被忽略。",
    )
    parser.add_argument(
        "--static",
        default=None,
        help=(
            "静态站点目录。给了之后由本服务同源托管前端页面，浏览器只需访问 "
            "http://<host>:<port>/ —— WS 与页面同源同主机，中间少一层代理/隧道，"
            "能规避本机 VPN 的 TUN 栈对长连接 WS 的干扰。"
        ),
    )
    return parser


def config_from_args(argv: list[str] | None = None) -> EngineConfig:
    args = build_parser().parse_args(argv)
    config = EngineConfig(
        host=args.host,
        port=args.port,
        sample_rate=args.sample_rate,
        block_samples=args.block_samples,
        pool_size=args.pool_size,
        backend=args.backend,
        model_path=args.model_path,
        device=args.device,
        static=args.static,
    )
    config.validate()
    return config


if __name__ == "__main__":
    default = EngineConfig()
    default.validate()
    print(f"默认配置: {default}")
    print(f"块时长: {default.block_seconds * 1000:.2f} ms")

    # 校验器要真的会拦下坏配置
    for bad, reason in [
        (EngineConfig(pool_size=0), "池长度 0"),
        (EngineConfig(block_samples=16), "块过小"),
        (EngineConfig(sample_rate=12_345), "采样率异常"),
        (EngineConfig(port=80), "端口越界"),
    ]:
        try:
            bad.validate()
        except ValueError as error:
            print(f"  拦下 {reason}: {error}")
        else:
            raise AssertionError(f"没拦下 {reason}")

    parsed = config_from_args(["--pool-size", "4", "--backend", "synth"])
    assert parsed.pool_size == 4 and parsed.backend == "synth"
    assert parsed.port == DEFAULT_PORT == 8090
    print("config.py 自测通过")
