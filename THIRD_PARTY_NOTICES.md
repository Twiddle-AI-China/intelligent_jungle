# 第三方组件与生产快照说明

本发行版为了让神经音源可以从一个源码仓库独立安装，随仓库保留了三套生产
运行所需的 Python 源码快照。快照日期统一为 **2026-07-22**；二进制权重、训练
语料、测试音频、生成缓存和 Python 字节码不在源码发行树中。

| 目录 | 用途 | 快照来源 | 保留范围 |
|---|---|---|---|
| `flock-voice-engine/vendor/midibrave` | 旧版 MidiBrave 兼容后端 | DGX Spark 已部署的 MidiBrave 源码副本 | Python 源码、运行配置与上游说明 |
| `flock-voice-engine/vendor/midibrave-v2` | bass、lead、pluck 生产解码器 | DGX Spark 生产容器实际加载的 MidiBrave v2 源码副本 | Python 源码、运行配置与上游说明 |
| `flock-voice-engine/vendor/trajectorybrave` | pad 生产解码器 | DGX Spark 生产容器实际加载的 TrajectoryBrave 源码副本 | Python 源码、运行配置与上游说明 |

## 许可与发布边界

上述部署快照中没有发现独立的 `LICENSE` 或 `NOTICE` 文件。仓库维护者已在
2026-07-22 明确确认将这三套生产依赖随新的公开发行仓库发布。该确认只说明本
项目的发布决定，不替代任何上游权利声明；后续若取得上游许可证或准确提交号，
应把原文和版本信息补入本文件，并保持现有来源记录。

神经音源模型通过 GitHub Release `neural-audio-v1` 单独分发，文件名与 SHA-256
固定在 `config/model-assets.json`。本仓库不再分发或转售 vLLM、任何通用 LLM
权重、CUDA、PyTorch 或 NVIDIA 驱动；这些组件均由部署者依据各自许可独立安装。
