"""midiBrave v2 单音色后端:四个音色专用 checkpoint(pad/bass/lead/pluck),256D z_timbre。

对 v1 ``MidiBraveBackend`` 的扩展,只做两件 v1 没有的事:

1. **vendor 源码换成 ``vendor/midibrave-v2/src``**。v1 vendor 是 v2 训练代码的早期
   快照,``ModelConfig`` 少 11 个字段(``decoder_fp32_tail`` / ``film_scale_limit`` /
   ``stochastic_excitation`` 等,见 ``docs`` 里的架构记录)。用 v1 vendor 加载 v2
   checkpoint 能 strict-load 成功、能出声——但那是"形状兼容"不是"行为正确":
   FiLM 限幅、精度控制、随机激励全部被静默丢弃,不报错但结果不对。
2. **补上 v1 vendor 完全没有的 ``stochastic_excitation``**——训练时对激励子带加了
   低速调制的带限噪声(``StochasticBandExcitation``),v1 的 ``excitation_bands()``
   没有这部分。

为什么不能只换 vendor 源码就完事:streaming.py 的解码器主体(FiLM/PQMF/因果卷积)
全部是**调用 ``self.decoder`` 的实际子模块**,配置驱动的行为(FiLM 限幅、dtype)
通过子模块内部持有的 ``self.config`` 自动生效,streaming.py 一行不用改。
**唯一的例外是 stochastic_excitation**——它在 ``MidiBrave.decode()`` 的编排层,不在
任何 decoder 子模块里,而 streaming/backend 是绕过 ``decode()`` 直接调子模块的,
所以这部分必须在这一层手动补上。

跨块一致性怎么保证
------------------
训练时的随机源用固定 seed(``config.stochastic_seed``),对 ``[bands, frames]``
整段一次性生成。**分块调用不等于整段调用的切片**——``torch.randn`` 按行主序填充,
outer 维(bands)先填满整行再填下一行,时间轴切片不会落在同一段连续的随机流上。
这个坑已经验证过(见开发记录),不是走形式。所以必须在 ``note_on`` 时就知道
这个音会播多久,一次性生成整段缓冲存起来,流式渲染时按位置切片——
而不是每块现算一次(那样等于每块都用了不同的随机种子,能量和调制包络
在块边界处全部跳变)。
"""

from __future__ import annotations

import math
from pathlib import Path

import torch
from torch import Tensor

from .midibrave_backend import MidiBraveBackend, _sha256_file

_HERE = Path(__file__).resolve()
DEFAULT_VENDOR_V2 = _HERE.parents[2] / "vendor" / "midibrave-v2"
CONFIG_DIR_V2 = DEFAULT_VENDOR_V2 / "configs"
CHECKPOINT_DIR = Path("/data/model_weights/midiBrave")

#: 四个已训练的音色专用 checkpoint。均为 ``safe_fallback`` 变体——目录里与之并列
#: 还有 ``fp16_candidate``,但 config_hash 精确匹配证实这四个 checkpoint 是用
#: safe_fallback 那份配置训的,不是候选项。
#:
#: bass 在 Serum 里的行话叫 "base"(和乐理上的贝斯是一个东西),config/manifest
#: 文件名都叫 base,checkpoint 文件名叫 bass_latest.pt——本表用 "bass" 做对外
#: 统一名字(与 client TIMBRES 列表一致),内部指向 base_*.yaml。
#:
#: hash 来源:2026-07-20 用 checkpoint 自带的 config_hash/manifest_hash 逐一比对
#: /home/jyhu/MidiBrave-v2/configs/v2/generated_clap_recon_top50_100k/ 下 10 个
#: 候选 yaml 的 sha256,精确匹配(不是猜的),再拉到本仓库校验传输完整性。
VOICE_CHECKPOINTS: dict[str, dict[str, str]] = {
    "pad": {
        "checkpoint": str(CHECKPOINT_DIR / "pad_latest.pt"),
        "config": str(CONFIG_DIR_V2 / "pad_safe_fallback.yaml"),
        "config_hash": "fb36c00d876d17ac135796b6af1198c77efa6def5dcd07c084b3d562fc9c8a9e",
        "manifest_hash": "d953523370962f453f6f7279c35591593b3848cfe9cd5a9225aa39f6efe53788",
    },
    "bass": {
        "checkpoint": str(CHECKPOINT_DIR / "bass_latest.pt"),
        "config": str(CONFIG_DIR_V2 / "base_safe_fallback.yaml"),
        "config_hash": "f77aa58c543c4d897be8d0824c8b03654be5f718ea8097bc4a257c90569588ef",
        "manifest_hash": "48db9e3f9346b40a53550bb7ea726de96053885cd14f25f8e3fe6625a02c457f",
    },
    "lead": {
        "checkpoint": str(CHECKPOINT_DIR / "lead_latest.pt"),
        "config": str(CONFIG_DIR_V2 / "lead_safe_fallback.yaml"),
        "config_hash": "218034a8e2b7d3f233412c8c35310b9f8dd4d81d1236071f0613b63ab729ec4a",
        "manifest_hash": "b325276944ad1cfad6a217a190c4f7fa820b54b7125e53eda5430a9c35017919",
    },
    "pluck": {
        "checkpoint": str(CHECKPOINT_DIR / "pluck_latest.pt"),
        "config": str(CONFIG_DIR_V2 / "pluck_safe_fallback.yaml"),
        "config_hash": "16ea822f92e9783e39f99f0efd3f48f909a244a897a11f0ed4db881fc974da75",
        "manifest_hash": "25b04af16cfb976611a98fb05f948bf415083568724f17707b9e7ee679c4ae7c",
    },
}
EXPECTED_TENSOR_COUNT_V2 = 141

#: texture 有 config(texture_*.yaml)但还没有对应 checkpoint(2026-07-20 现状)。
#: 不放进 VOICE_CHECKPOINTS,免得被误当成可用音色。
PENDING_VOICES = ("texture",)


class MidiBraveBackendV2(MidiBraveBackend):
    """单个音色的 v2 backend:自己的 checkpoint、自己的 config、自己的 stochastic 缓冲。

    每个实例只装一个音色。四音色并存用 ``brave_voices.MultiVoiceBraveBackend``
    持有四个本类实例,不在这一层做多音色路由。
    """

    def __init__(
        self, voice_name: str, device: str = "cpu", verify_hashes: bool = True,
        spec_override: dict[str, str] | None = None,
        vendor_root: Path | None = None,
    ) -> None:
        spec = spec_override or VOICE_CHECKPOINTS.get(voice_name)
        if spec is None:
            raise ValueError(f"未知音色 {voice_name!r}，可选: {sorted(VOICE_CHECKPOINTS)}")
        self.voice_name = voice_name

        # verify_hashes=False 传给 super()：v1 的校验是单一模块级常量
        # （EXPECTED_CONFIG_SHA256 等），对应的是旧的单音色 checkpoint，
        # 四个 v2 checkpoint 各自的 hash 不同，下面手动逐一比对。
        super().__init__(
            checkpoint_path=spec["checkpoint"],
            config_path=spec["config"],
            vendor_root=vendor_root or DEFAULT_VENDOR_V2,
            device=device,
            verify_hashes=False,
        )

        if verify_hashes:
            # 双重校验：文件本身的 hash + checkpoint 自报的 hash，两者都要对上
            # spec 里记录的值——只查一个查不出"文件被换了但 checkpoint 记录没变"
            # 或反过来的情况。
            file_hash = _sha256_file(Path(spec["config"]))
            if file_hash != spec["config_hash"]:
                raise ValueError(
                    f"{voice_name}: 本地 config 文件 hash 与预期不符 "
                    f"({file_hash} != {spec['config_hash']})——文件可能被替换或传输损坏"
                )
            got_config = self.checkpoint_meta.get("config_hash")
            got_manifest = self.checkpoint_meta.get("manifest_hash")
            if got_config != spec["config_hash"]:
                raise ValueError(
                    f"{voice_name}: checkpoint 自报的 config_hash 与预期不符 "
                    f"({got_config} != {spec['config_hash']})"
                )
            if got_manifest != spec["manifest_hash"]:
                raise ValueError(
                    f"{voice_name}: checkpoint 自报的 manifest_hash 与预期不符 "
                    f"({got_manifest} != {spec['manifest_hash']})"
                )
            if self.loaded_tensor_count != EXPECTED_TENSOR_COUNT_V2:
                raise ValueError(
                    f"{voice_name}: 张量数 {self.loaded_tensor_count} != "
                    f"预期 {EXPECTED_TENSOR_COUNT_V2}"
                )

        # -- stochastic_excitation 状态 ------------------------------------
        # 按「这个音会播多久」缓存整段随机激励；key 是 PQMF 时间轴上的总帧数。
        self._stochastic_cache: dict[int, Tensor] = {}
        self._active_total_frames_pqmf: int | None = None

    # -- 随机激励：一次性整段生成，按位置切片 ------------------------------
    def _stochastic_buffer(self, total_frames_pqmf: int) -> Tensor:
        cached = self._stochastic_cache.get(total_frames_pqmf)
        if cached is not None:
            return cached
        cfg = self.config.model
        bands = cfg.pqmf_bands
        if not getattr(cfg, "stochastic_excitation", False):
            # 这个音色训练时没开随机激励——加零，等价于不存在，
            # 与 v1 checkpoint（完全没有这个字段）行为一致。
            buf = torch.zeros(1, bands, total_frames_pqmf, device=self.device)
        else:
            # 逐字复刻 midibrave.model.StochasticBandExcitation.forward
            # （batch=1，seeds=None → 用 config.stochastic_seed）。
            generator = torch.Generator(device=self.device)
            generator.manual_seed(int(cfg.stochastic_seed))
            noise = torch.randn(
                bands, total_frames_pqmf, device=self.device,
                dtype=torch.float32, generator=generator,
            )
            noise = noise / noise.square().mean(dim=-1, keepdim=True).sqrt().clamp_min(1e-6)
            # hop_samples 在源码里也是 pqmf_bands（PQMF 降采样因子本身），
            # 不是另一个独立参数——frame_rate 由此换算。
            frame_rate = self.geometry.sample_rate / bands
            duration = total_frames_pqmf / max(frame_rate, 1e-6)
            control_points = max(2, int(math.ceil(duration * cfg.stochastic_modulation_hz)) + 1)
            modulation = torch.randn(
                1, 1, control_points, device=self.device,
                dtype=torch.float32, generator=generator,
            )
            modulation = torch.nn.functional.interpolate(
                modulation, size=total_frames_pqmf, mode="linear", align_corners=True,
            )[0]
            envelope = 0.75 + 0.25 * torch.tanh(modulation)
            buf = (noise * envelope * cfg.stochastic_excitation_rms).unsqueeze(0)
        self._stochastic_cache[total_frames_pqmf] = buf
        return buf

    #: 安全余量（原始采样点）。真实服务端（app.py Session）按整块渲染，
    #: note 到期是在某块渲染*之后*才检测到的（remaining <= 0 才 note_off），
    #: 所以实际渲染的样本数总是 >= 声明时长，超出量最多一整块。这里按当前
    #: 已知的最大块长（4096，见 tools/bench_compute.py 的块长扫描）留双倍余量，
    #: 换算 pqmf 帧数便宜到可以忽略（几千个 float），不值得为了省这点内存
    #: 去精确算「这次连接的 block_samples 到底是多少」。
    _DURATION_SAFETY_MARGIN_SAMPLES = 8192

    def prepare_note_stochastic(self, duration_seconds: float) -> None:
        """note_on 时调用一次：按声明时长精确生成随机激励缓冲。

        **必须在 note_on 之前调用**——note_on 内部的 warmup 渲染就会开始
        消费这段缓冲。总帧数算法与 v1 render_note() 基本一致
        （body + warmup + tail + 安全余量），这样流式输出才能与同等时长的
        离线单次渲染逐样本对齐（本类 excitation_bands() 的无缓冲兜底分支
        走的是同一套算法，见下）。

        **安全余量的由来**：真实服务端总是整块渲染，note 到期的检测发生在
        某块渲染完*之后*，所以实际消耗的样本数会比 duration_seconds 多，
        最多多出一整块。缓冲不留余量的话，长块长（2048/4096）下最后一块会
        因为切片越界直接报错（已实测：块=512 时越界 384 采样点，与
        “87 块 ×512 − 87 块所需的 44160” 的差值吻合）。
        """
        geom = self.geometry
        body_frames = geom.frames_for_seconds(duration_seconds)
        total_frames_latent = body_frames + geom.warmup_latent_frames + geom.tail_latent_frames
        total_samples = (total_frames_latent * geom.samples_per_latent
                          + self._DURATION_SAFETY_MARGIN_SAMPLES)
        total_frames_pqmf = -(-total_samples // self.config.model.pqmf_bands)  # 向上取整
        self._stochastic_buffer(total_frames_pqmf)  # 预生成并缓存
        self._active_total_frames_pqmf = total_frames_pqmf

    def excitation_bands(self, note: int, start_sample: int, samples: int) -> Tensor:
        """确定性谐波部分照抄 v1，随机部分叠加预生成缓冲的对应切片。"""
        deterministic = super().excitation_bands(note, start_sample, samples)
        pqmf_bands = self.config.model.pqmf_bands
        total = self._active_total_frames_pqmf
        if total is None:
            # 没有经过 prepare_note_stochastic——例如离线 render_note() 的
            # 单次大调用（start_sample=0, samples=完整时长）。把这次调用本身
            # 当作整段处理，与 render_note() 的语义一致，不需要调用方额外配合。
            total = samples // pqmf_bands
            buf = self._stochastic_buffer(total)
            return deterministic + buf
        buf = self._stochastic_buffer(total)
        f0 = start_sample // pqmf_bands
        flen = samples // pqmf_bands
        if f0 >= buf.shape[-1]:
            # 渲染位置整体越过缓冲末尾：整段用最后一帧填充（见下）。
            piece = buf[..., -1:].expand(buf.shape[0], buf.shape[1], flen)
        else:
            piece = buf[..., f0 : f0 + flen]
            short = flen - piece.shape[-1]
            if short > 0:
                # 渲染位置越过预生成缓冲（release 尾巴、hold 超过声明时长）。
                # 缓冲是按「声明时长 + release + 一块余量」生成的，越界是
                # 正常情况不是错误：重复最后一帧把切片补齐，激励冻结在缓冲
                # 末尾的噪声包络上继续，而不是让形状不匹配炸掉整条连接。
                # 尾巴里只是噪声包络不再缓慢变化，且当时增益正在衰减，
                # 听感无感——远好于掉线（2026-07-21 生产事故：每个自然
                # 到期的音都在 release 中段把会话炸进 fallback）。
                piece = torch.cat(
                    [piece, piece[..., -1:].expand(-1, -1, short)], dim=-1
                )
        return deterministic + piece
