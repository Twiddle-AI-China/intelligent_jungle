"""服务配置。

端口 8090 是**硬约束**:Spark 上 22 / 4173 / 7890 / 8081(vLLM 生产)/ 8083 /
8086 / 8766 / 8888 / 9090 / 9418 都被占了,本项目只用 8090,不要改成别的去试探。

采样率 44100 跟着 midiBrave 走(BRIEF.md:44.1 kHz mono)。块 2048 样本约
46.4 ms —— 单音延迟预算 100–300 ms,足够宽裕。

voice 池长度按 PRD 取 4(1 人控 + 3 agent 控)。运行期不可变:改这个数等于重建
所有声部的跨块状态。

**四轨满载的关键配置是 ``OMP_NUM_THREADS=16``**(deploy/docker-run.sh)。
实测(tools/stress_pool4.py,四轨持续发声,各三次重复):

    threads=8   p95 55.8–65.4 ms  max 69–122 ms   ✗ 每次都超 46.44 ms 截止
    threads=16  p95 37.1–38.4 ms  max 40–42 ms    ✅ 每次都过

机器 20 核,只给 8 线程还要跟 8081/8083 两个 LLM 抢调度,尾部就炸。
调线程比调块长有效得多 —— 4096 也能过但延迟翻倍,没必要。
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
#: **1024 → 2048 的依据**(``tools/bench_compute.py`` 实测,2026-07-20):
#: 四声部串行在 1024 下 p95 45.91 ms / 预算 23.22 ms,超预算 2 倍;
#: 2048 下 p95 38.47 ms / 预算 46.44 ms,进预算且余量 7.97 ms。
#: **2048 → 4096(2026-07-22)**:块长本身不是问题,共享 GPU 才是——同机 vLLM
#: 的推理是**亚秒级突发**(生成时瞬间打满 GPU,间隙全空,1 秒采样的 nvidia-smi
#: 均值只有约 20% 却完全看不到这些尖峰)。突发会把落在那个窗口里的单块渲染从
#: 常态 13 ms 拖到 60–71 ms,一旦超过 46.44 ms 预算,客户端缓冲被抽干就 underrun
#: → 卡顿。把块长翻倍到 4096,预算随之翻倍到 92.88 ms:一次突发把渲染顶到 ~70 ms
#: 仍在预算内,不再产生 underrun。这是拿延迟换突发容错,不是降负载——降负载已经
#: 靠 pad 和弦收窄(pool 7→5)做过一轮。
#: 块长翻倍 → 预算翻倍,而每块成本涨不到一倍(固定开销被摊薄),所以换得过来。
#: 安全性:HANDOFF 已验证「块长无关」(逐样本与离线一致 6.9e-07);4096 仍是
#: geometry.samples_per_latent 的整数倍(4096 = 2×2048),几何约束不破。
#: 代价:端到端延迟再 +46 ms(单块 46→93 ms),叠加客户端 PRIME/缓冲后端到端
#: 仍在 BRIEF 的 100–300 ms 预算内。
DEFAULT_BLOCK_SAMPLES = 4096
DEFAULT_POOL_SIZE = 4          # PRD 四轨(1 人控 + 3 agent 控);2048 块长下 pool=4 实测 p95 38.47/46.44 ms

#: 客户端 worklet 攒够这么多帧才起播(基线约定)。低于此值服务端加速发送。
PRIME_FRAMES = 4096
#: 缓冲超过这么多帧就减速,避免无限堆积。
#: 2026-07-21 从 12288 提到 16384:TARGET_FRAMES 提到 11000(250 ms)后,
#: 旧高水位只比目标高 12%,稳态会频繁误触发减速档。
#: 2026-07-22 从 16384 提到 19000:TARGET_FRAMES 提到 13000 后按同比例上移,
#: 保持高水位比目标高约 46%,不让稳态误触发减速。
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
