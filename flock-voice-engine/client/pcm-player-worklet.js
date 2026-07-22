/**
 * PCM 环形缓冲播放器（AudioWorklet）
 *
 * 来源：改编自 Latent-Cosmos-Synth 仓库 `codex/pitch-conditioned-brave` 分支的
 * `src/pcm-player-worklet.js`。保留了基线的三条约定，保证与服务端的背压逻辑对齐：
 *
 *   1. 环形缓冲容量 1.5 s
 *   2. 攒够 PRIME 帧（默认 4096）才起播
 *   3. 每 32 个 render quantum 回报一次 stats
 *
 * 相对基线的两处改动：
 *
 * A. **重采样**。基线假定前端自己 new 一个 44.1 kHz 的 AudioContext。本项目要接进
 *    前端**已有**的 AudioContext（很可能是 48 kHz），所以这里用小数读指针做线性
 *    插值重采样，stride = 服务端采样率 / 上下文采样率。
 *
 *    注意环形缓冲里存的是**服务端帧**，`available` 也按服务端帧计数 —— 服务端的
 *    pacing 逻辑（PRIME_FRAMES、按 44100 Hz 推算消费速度）就是按这个单位算的，
 *    单位一换服务端就会估错水位。每秒消费 ctxRate × stride = serverRate 帧，正好对上。
 *
 * B. **饿死后的淡入**。基线在 underrun 之后直接接着播，环形缓冲的断点会出现波形
 *    阶跃 → 咔哒声。这里在重新有数据时用 256 样本斜坡淡入，代价可忽略。
 *
 * C. **N 通道分轨**。服务端 `?split=1` 时下发 pool_size 个通道（第 n 通道 = 第 n 轨
 *    干声），前端要能给每一轨接自己的 EQ / 混响发送。所以缓冲从「左右两条」推广成
 *    「N 条」，输出按**节点的输出槽顺序**依次映射：
 *
 *      立体声：1 个输出 × 2 通道  → 环形缓冲通道 0, 1（左右恒等）
 *      分轨：  N 个输出 × 1 通道  → 环形缓冲通道 0..N-1
 *
 *    两种布局共用同一段填充代码 —— 分开写迟早会漂移成两套行为。
 *    **所有轨共用一个读指针**，因此天然采样对齐，不会各自漂移。
 */
'use strict';

const STATS_EVERY_QUANTA = 32;   // 约 85 ms @ 48 kHz，比基线更勤，服务端估水位更准
const REPRIME_RAMP_SAMPLES = 256;

class PcmRingPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};

    // 服务端采样率。ready 帧到达前先按 44100 走（midiBrave 的原生采样率）。
    this.serverRate = Number(opts.serverSampleRate) || 44100;
    this.primeFrames = Number(opts.primeFrames) || 4096;
    // 下行通道数。立体声 2；分轨时 = pool_size。ready 帧到达后可经 config 修正。
    this.channelCount = Math.max(1, Number(opts.channelCount) || 2);

    this.capacity = Math.max(16384, Math.round(this.serverRate * 1.5));
    this.allocate();

    this.read = 0;          // 整数读指针（服务端帧）
    this.frac = 0;          // 小数部分，配合 stride 做线性插值
    this.write = 0;
    this.available = 0;     // 缓冲里有多少服务端帧

    this.primed = false;
    this.underruns = 0;
    this.quanta = 0;
    this.ramp = 0;          // 淡入计数器，0 表示不在淡入
    this.dropped = 0;       // 因缓冲满而丢弃的帧数（服务端发太快时才会非零）

    this.port.onmessage = ({ data }) => this.onMessage(data);
  }

  /** 按当前 capacity / channelCount 重建环形缓冲，并把指针归零。 */
  allocate() {
    this.chan = [];
    for (let c = 0; c < this.channelCount; c += 1) {
      this.chan.push(new Float32Array(this.capacity));
    }
    this.read = 0;
    this.write = 0;
    this.frac = 0;
    this.available = 0;
    this.primed = false;
    this.ramp = 0;
  }

  /** 当前的读取步长。上下文采样率由 worklet 全局 `sampleRate` 给出。 */
  get stride() {
    return this.serverRate / sampleRate;
  }

  onMessage(data) {
    if (data instanceof ArrayBuffer) {
      this.push(new Float32Array(data));
      return;
    }
    if (!data || typeof data !== 'object') return;

    if (data.type === 'reset') {
      // 断线重连 / 切后端时清空，避免把旧音频的尾巴接到新流上。
      this.read = 0;
      this.write = 0;
      this.frac = 0;
      this.available = 0;
      this.primed = false;
      this.ramp = 0;
      return;
    }
    if (data.type === 'config') {
      // ready 帧带来了服务端真实采样率与通道布局。任一不同就重建缓冲。
      const rate = Number(data.serverSampleRate);
      const chans = Number(data.channelCount);
      const rateChanged = rate > 0 && rate !== this.serverRate;
      const chanChanged = chans > 0 && chans !== this.channelCount;
      if (rateChanged || chanChanged) {
        if (rateChanged) this.serverRate = rate;
        if (chanChanged) this.channelCount = chans;
        this.capacity = Math.max(16384, Math.round(this.serverRate * 1.5));
        this.allocate();
      }
      if (Number(data.primeFrames) > 0) this.primeFrames = Number(data.primeFrames);
    }
  }

  /**
   * 写入一块交错 float32（每帧 channelCount 个数）。
   * 缓冲满时丢最旧的帧（宁可丢也不阻塞）。
   */
  push(pcm) {
    const ch = this.channelCount;
    for (let i = 0; i + ch <= pcm.length; i += ch) {
      if (this.available >= this.capacity) {
        this.read = (this.read + 1) % this.capacity;
        this.available -= 1;
        this.dropped += 1;
      }
      for (let c = 0; c < ch; c += 1) this.chan[c][this.write] = pcm[i + c];
      this.write = (this.write + 1) % this.capacity;
      this.available += 1;
    }
  }

  /**
   * 把节点的输出槽按顺序摊平成一维缓冲列表，与环形缓冲通道一一对应。
   * 立体声是「1 输出 × 2 通道」，分轨是「N 输出 × 1 通道」，两者共用同一段填充逻辑。
   */
  static sinks(outputs) {
    const list = [];
    for (let o = 0; o < outputs.length; o += 1) {
      for (let c = 0; c < outputs[o].length; c += 1) list.push(outputs[o][c]);
    }
    return list;
  }

  process(_inputs, outputs) {
    const sinks = PcmRingPlayer.sinks(outputs);
    if (!sinks.length) return true;
    // 输出槽多于下行通道时（例如后端降级成 1 轨），多出来的槽保持静音。
    const n = Math.min(sinks.length, this.channelCount);
    const frames = sinks[0].length;
    const stride = this.stride;

    if (!this.primed && this.available >= this.primeFrames) {
      this.primed = true;
      this.ramp = REPRIME_RAMP_SAMPLES;
    }

    for (let i = 0; i < frames; i += 1) {
      // 线性插值要读 read 和 read+1 两帧，所以至少留 2 帧余量。
      if (this.primed && this.available >= 2) {
        const next = (this.read + 1) % this.capacity;
        const t = this.frac;
        const g = this.ramp > 0 ? 1 - this.ramp / REPRIME_RAMP_SAMPLES : 1;

        // 所有通道共用同一个读指针与插值系数 —— 这正是分轨之间保持采样对齐的原因。
        for (let c = 0; c < n; c += 1) {
          const ring = this.chan[c];
          sinks[c][i] = (ring[this.read] * (1 - t) + ring[next] * t) * g;
        }
        for (let c = n; c < sinks.length; c += 1) sinks[c][i] = 0;
        if (this.ramp > 0) this.ramp -= 1;

        this.frac += stride;
        while (this.frac >= 1) {
          this.read = (this.read + 1) % this.capacity;
          this.available -= 1;
          this.frac -= 1;
        }
      } else {
        for (let c = 0; c < sinks.length; c += 1) sinks[c][i] = 0;
        if (this.primed) {
          this.underruns += 1;
          // 饿死了：退回未起播状态，重新攒够再播，并淡入。
          this.primed = false;
          this.frac = 0;
        }
      }
    }

    this.quanta += 1;
    if (this.quanta % STATS_EVERY_QUANTA === 0) {
      this.port.postMessage({
        type: 'stats',
        bufferedFrames: this.available,
        underruns: this.underruns,
        dropped: this.dropped,
        capacity: this.capacity,
        primed: this.primed,
        serverSampleRate: this.serverRate,
      });
    }
    return true;
  }
}

registerProcessor('pcm-ring-player', PcmRingPlayer);
