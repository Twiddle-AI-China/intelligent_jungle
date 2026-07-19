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

    this.capacity = Math.max(16384, Math.round(this.serverRate * 1.5));
    this.left = new Float32Array(this.capacity);
    this.right = new Float32Array(this.capacity);

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
      // ready 帧带来了服务端真实采样率。与当前假设不同就重建缓冲。
      const rate = Number(data.serverSampleRate);
      if (rate > 0 && rate !== this.serverRate) {
        this.serverRate = rate;
        this.capacity = Math.max(16384, Math.round(rate * 1.5));
        this.left = new Float32Array(this.capacity);
        this.right = new Float32Array(this.capacity);
        this.read = this.write = this.available = 0;
        this.frac = 0;
        this.primed = false;
      }
      if (Number(data.primeFrames) > 0) this.primeFrames = Number(data.primeFrames);
    }
  }

  /** 写入一块交错立体声 float32。缓冲满时丢最旧的帧（宁可丢也不阻塞）。 */
  push(pcm) {
    for (let i = 0; i + 1 < pcm.length; i += 2) {
      if (this.available >= this.capacity) {
        this.read = (this.read + 1) % this.capacity;
        this.available -= 1;
        this.dropped += 1;
      }
      this.left[this.write] = pcm[i];
      this.right[this.write] = pcm[i + 1];
      this.write = (this.write + 1) % this.capacity;
      this.available += 1;
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const outL = output[0];
    const outR = output[1] || output[0];
    const stride = this.stride;

    if (!this.primed && this.available >= this.primeFrames) {
      this.primed = true;
      this.ramp = REPRIME_RAMP_SAMPLES;
    }

    for (let i = 0; i < outL.length; i += 1) {
      // 线性插值要读 read 和 read+1 两帧，所以至少留 2 帧余量。
      if (this.primed && this.available >= 2) {
        const next = (this.read + 1) % this.capacity;
        const t = this.frac;
        let l = this.left[this.read] * (1 - t) + this.left[next] * t;
        let r = this.right[this.read] * (1 - t) + this.right[next] * t;

        if (this.ramp > 0) {
          const g = 1 - this.ramp / REPRIME_RAMP_SAMPLES;
          l *= g;
          r *= g;
          this.ramp -= 1;
        }
        outL[i] = l;
        outR[i] = r;

        this.frac += stride;
        while (this.frac >= 1) {
          this.read = (this.read + 1) % this.capacity;
          this.available -= 1;
          this.frac -= 1;
        }
      } else {
        outL[i] = 0;
        outR[i] = 0;
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
