/**
 * flock-voice-engine 浏览器端接入包
 *
 * 无构建步骤、非 module、全局对象风格，直接 <script src> 引入即可。
 *
 * 定位：**只提供干声音源**。它给你一个 AudioNode（`client.output`），你把它接到
 * 你现有的声部总线上就完事了。这里面没有混响、没有 EQ、没有 master、没有昼夜宏
 * —— 那些前端已经有了，且与音源解耦，服务端和本包都不重复做（BRIEF.md 架构决定 3）。
 *
 * 换句话说：本包替换的是 `audio.js` 里 **engine 这一层**，总线以后的链路一行不动。
 *
 * 三行接进去：
 *
 *     const voice = FlockVoiceClient.create({ context: ctx, destination: padBus });
 *     await voice.connect('ws://192.168.9.140:8090/decoder');
 *     voice.noteWithDuration(0, 60, 0.68, 2.0);
 *
 * 韧性：服务端连不上 / 中途挂掉 / 流卡死，都会**自动回落到本地 WebAudio 简易合成**，
 * 声音继续、界面不报错，同时后台按指数退避重连；连回来后自动切回神经音源。
 * 调用方全程不用关心当前在哪个模式 —— noteOn/noteOff 的语义是一样的。
 */
'use strict';

(function (global) {

  // ---------------------------------------------------------------------
  // 训练数据边界（BRIEF.md，硬约束，越界即分布外）
  // ---------------------------------------------------------------------

  const MIDI_MIN = 31;
  const MIDI_MAX = 95;
  const DURATION_MIN = 0.25;
  const DURATION_MAX = 6.0;

  /** 音色槽位，与服务端 `TIMBRE_NAMES` 一致。 */
  const TIMBRES = ['bass', 'pad', 'lead', 'pluck'];

  // ---------------------------------------------------------------------
  // velocity 三档 → 训练两档
  // ---------------------------------------------------------------------

  /**
   * 前端有 0.42 / 0.68 / 1.0 三档，模型只训过 v50 和 v127 两档。
   *
   * 映射（BRIEF.md，**禁止插值** —— 中间值是分布外，模型没见过）：
   *
   *   0.42        → v50
   *   0.68 与 1.0 → v127，两者的响度差用**增益差分**补，不动 velocity
   *
   * 所以这里输出两个东西：送给模型的离散 velocity，和送给 gain 参数的比例系数。
   */
  const VELOCITY_TIERS = [
    { name: 'soft',   input: 0.42, velocity: 50 / 127, gainScale: 1.00 },
    { name: 'medium', input: 0.68, velocity: 1.00,     gainScale: 0.68 },
    { name: 'hard',   input: 1.00, velocity: 1.00,     gainScale: 1.00 },
  ];

  function mapVelocity(value) {
    const v = Number.isFinite(value) ? value : 0.68;
    // 就近吸附到三档之一。调用方传任意连续值也不会漏进模型 —— 一律先量化。
    let best = VELOCITY_TIERS[0];
    let bestDistance = Infinity;
    for (const tier of VELOCITY_TIERS) {
      const distance = Math.abs(v - tier.input);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = tier;
      }
    }
    return best;
  }

  function clampMidi(midi) {
    const m = Math.round(Number(midi));
    if (!Number.isFinite(m)) return 60;
    return Math.min(MIDI_MAX, Math.max(MIDI_MIN, m));
  }

  function clampDuration(seconds) {
    const s = Number(seconds);
    if (!Number.isFinite(s)) return 1.0;
    return Math.min(DURATION_MAX, Math.max(DURATION_MIN, s));
  }

  function clamp01(value, fallback) {
    const v = Number(value);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(1, Math.max(0, v));
  }

  function midiToHz(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  // ---------------------------------------------------------------------
  // URL 归一化
  // ---------------------------------------------------------------------

  /** 接受 `ws://h:8090/decoder` / `http://h:8090` / `h:8090` 三种写法。 */
  function normalizeUrls(input) {
    let raw = String(input || '').trim();
    if (!raw) throw new Error('connect() 需要一个地址');
    if (!/^(wss?|https?):\/\//.test(raw)) raw = 'http://' + raw;

    const url = new URL(raw);
    const secure = url.protocol === 'wss:' || url.protocol === 'https:';
    const origin = (secure ? 'https:' : 'http:') + '//' + url.host;
    const path = (url.pathname && url.pathname !== '/') ? url.pathname : '/decoder';
    const ws = (secure ? 'wss:' : 'ws:') + '//' + url.host + path + (url.search || '');
    return { ws, status: origin + '/api/decoder-status', origin };
  }

  // ---------------------------------------------------------------------
  // 本地 WebAudio 兜底合成
  // ---------------------------------------------------------------------

  /**
   * 断线时用的简易合成器。**干声、单声部 last-note-priority**，与服务端语义对齐：
   * 同一 voice 上新音直接抢占旧音。
   *
   * 四种音色的参数照着服务端 `backends/synth.py` 的 TimbreSpec 抄，让回落时的
   * 音色跳变尽量小 —— 听感上应该是「音源换了个档次」，而不是「换了个乐器」。
   */
  const FALLBACK_SPECS = {
    bass:  { wave: 'sine',     detune: [0],           sub: 0.35, lowpass: 320,  attack: 0.040, decay: 2.20, sustain: 0.0, level: 0.42 },
    pad:   { wave: 'triangle', detune: [-7, 0, 7],    sub: 0.0,  lowpass: 1800, attack: 0.35,  decay: 3.00, sustain: 0.7, level: 0.30 },
    lead:  { wave: 'square',   detune: [0],           sub: 0.0,  lowpass: 2600, attack: 0.012, decay: 1.20, sustain: 0.5, level: 0.22 },
    pluck: { wave: 'triangle', detune: [0],           sub: 0.0,  lowpass: 3200, attack: 0.003, decay: 0.24, sustain: 0.0, level: 0.34 },
  };

  function createFallbackSynth(context, destination) {
    const active = new Map();   // row → 正在发声的节点组

    function stop(row, releaseSeconds) {
      const node = active.get(row);
      if (!node) return;
      active.delete(row);
      const now = context.currentTime;
      const release = Math.max(0.02, releaseSeconds || 0.25);
      try {
        node.amp.gain.cancelScheduledValues(now);
        node.amp.gain.setValueAtTime(Math.max(node.amp.gain.value, 1e-4), now);
        node.amp.gain.exponentialRampToValueAtTime(1e-4, now + release);
      } catch (_) { /* 上下文已关就无所谓了 */ }
      const stopAt = now + release + 0.05;
      for (const osc of node.oscillators) {
        try { osc.stop(stopAt); } catch (_) { /* 已经停过 */ }
      }
      // 停完再断开，避免留下悬挂节点。
      global.setTimeout(() => {
        try { node.amp.disconnect(); } catch (_) {}
        try { node.filter.disconnect(); } catch (_) {}
      }, (release + 0.2) * 1000);
    }

    function noteOn(row, midi, velocityTier, params) {
      stop(row, 0.02);   // last-note-priority：抢占，快速掐掉旧音

      const spec = FALLBACK_SPECS[params.timbre] || FALLBACK_SPECS.pad;
      const now = context.currentTime;
      const hz = midiToHz(midi);

      const filter = context.createBiquadFilter();
      filter.type = 'lowpass';
      // dirt 稍微开一点亮度，rich 加共振 —— 只是让参数不至于完全没反应
      filter.frequency.value = Math.min(context.sampleRate / 2.2, spec.lowpass * (1 + 0.6 * params.rich));
      filter.Q.value = 0.7 + params.dirt * 2.0;

      const amp = context.createGain();
      amp.gain.value = 1e-4;

      const oscillators = [];
      for (const cents of spec.detune) {
        const osc = context.createOscillator();
        osc.type = spec.wave;
        osc.frequency.value = hz;
        // dirt = 失谐抖动，和服务端 Voice.f0_hz 的意图一致
        osc.detune.value = cents + (Math.random() * 2 - 1) * 25 * params.dirt;
        osc.connect(filter);
        oscillators.push(osc);
      }
      if (spec.sub > 0) {
        const sub = context.createOscillator();
        sub.type = 'sine';
        sub.frequency.value = hz / 2;
        const subGain = context.createGain();
        subGain.gain.value = spec.sub;
        sub.connect(subGain).connect(filter);
        oscillators.push(sub);
      }

      filter.connect(amp).connect(destination);

      // 峰值 = 音色配平 × voice gain × velocity 档位 × 增益差分
      const peak = Math.max(1e-3,
        spec.level * params.gain * velocityTier.velocity * velocityTier.gainScale / spec.detune.length);
      const sustain = Math.max(1e-4, peak * spec.sustain);

      amp.gain.setValueAtTime(1e-4, now);
      amp.gain.exponentialRampToValueAtTime(peak, now + spec.attack);
      amp.gain.exponentialRampToValueAtTime(sustain, now + spec.attack + spec.decay);

      for (const osc of oscillators) osc.start(now);
      active.set(row, { oscillators, amp, filter });
    }

    return {
      noteOn,
      noteOff(row) { stop(row, 0.25); },
      allOff() { for (const row of Array.from(active.keys())) stop(row, 0.08); },
      get activeVoices() { return active.size; },
    };
  }

  // ---------------------------------------------------------------------
  // 客户端主体
  // ---------------------------------------------------------------------

  const DEFAULT_OPTIONS = {
    context: null,              // 传入前端已有的 AudioContext；不传就自己建一个
    destination: null,          // 干声接到哪儿（声部总线）；不传就接 destination
    poolSize: 4,                // 本地预期的声部数，仅用于参数缓存，实际以 ready 帧为准
    split: false,               // 分轨下行：每轨一个独立 mono 输出，见 trackOutput()
    autoReconnect: true,
    reconnectMinMs: 500,
    reconnectMaxMs: 8000,
    stallTimeoutMs: 1500,       // 这么久没收到音频块就认为流卡死
    workletUrl: null,           // 默认取本文件同目录的 pcm-player-worklet.js
    fallbackEnabled: true,
    // 2026-07-22:6s 太紧——服务端每条新连接要同步建 7 个 CUDA stream +
    // 跑增益标定渲染（真实 GPU 工作，非纯握手），GPU 有负载时经常超过 6s。
    // 客户端等不到 ready 帧就静默 degrade + 重连（openSocket 的 connect()
    // 承诺不 reject 到调用方），于是永远在「刚超时又重连」里循环，UI 卡在
    // 「连接中」且控制台完全没有报错——这不是断线，是握手一直抢不过服务端
    // 的建 session 耗时。放宽到 25s，给服务端一次真实机会把 ready 帧发出来。
    connectTimeoutMs: 25000,
    // 客户端是否把 velocity 量化到训练的两档。见 docs/client-integration.md「与
    // protocol.md 的一处出入」：protocol.md §9 说这件事由 brave 后端内部做。
    // 两边都做是**幂等**的（量化后的值再量化还是自己），所以默认开着当保险 ——
    // synth 兜底后端并不量化，关掉就会有连续 velocity 漏进去。
    // 确认 brave 后端接管之后，前端可以把这个关掉。
    quantizeVelocity: true,
  };

  /** 猜本文件所在目录，用来定位 worklet，省得调用方再配一个路径。 */
  function guessWorkletUrl() {
    try {
      const script = document.currentScript;
      if (script && script.src) {
        return script.src.replace(/[^/]*$/, 'pcm-player-worklet.js');
      }
    } catch (_) { /* 忽略 */ }
    return './pcm-player-worklet.js';
  }

  const SCRIPT_DIR_WORKLET = guessWorkletUrl();

  function createClient(userOptions) {
    const options = Object.assign({}, DEFAULT_OPTIONS, userOptions || {});
    const AudioContextCtor = global.AudioContext || global.webkitAudioContext;
    if (!AudioContextCtor) throw new Error('当前浏览器不提供 Web Audio AudioContext');

    const context = options.context || new AudioContextCtor({ latencyHint: 'interactive' });

    /** 干声出口。调用方把它接到自己的声部总线上。 */
    const output = context.createGain();
    output.gain.value = 1.0;
    output.connect(options.destination || context.destination);

    const fallback = options.fallbackEnabled ? createFallbackSynth(context, output) : null;

    // ---- 内部状态 ----------------------------------------------------
    const state = {
      mode: 'idle',            // idle | connecting | streaming | fallback | closed
      reason: '',
      urls: null,
      socket: null,
      node: null,              // AudioWorkletNode
      workletReady: false,
      ready: null,             // 服务端 ready 帧
      serverSampleRate: 44100,
      poolSize: options.poolSize,
      split: false,            // 实际是否分轨（连接时探测服务端能力后确定）
      trackCount: 1,           // 分轨时的轨数；混合模式恒为 1
      trackGains: null,        // 分轨时每轨的出口 GainNode
      closedByUser: false,
      reconnectAttempts: 0,
      reconnectTimer: null,
      stallTimer: null,
      lastBinaryAt: 0,
      stats: { bufferedFrames: 0, underruns: 0, dropped: 0, primed: false },
      telemetry: null,
      listeners: [],
      // 每个 voice 的参数缓存。note 帧会把它们一起带上，服务端就不用记状态。
      params: new Map(),
      // 正在发声的音，用于回落切换时把状态搬过去
      held: new Map(),
      clampedNotes: 0,
    };

    /** 按配置决定量化与否。关掉时原样透传，增益差分也随之失效。 */
    function resolveVelocity(value) {
      if (options.quantizeVelocity) return mapVelocity(value);
      return { name: 'raw', input: value, velocity: clamp01(value, 0.68), gainScale: 1.0 };
    }

    function voiceParams(row) {
      if (!state.params.has(row)) {
        state.params.set(row, { timbre: 'pad', gain: 0.8, rich: 0.5, room: 0.2, dirt: 0.0 });
      }
      return state.params.get(row);
    }

    function setMode(mode, reason) {
      if (state.mode === mode && reason === state.reason) return;
      state.mode = mode;
      state.reason = reason || '';
      emit();
    }

    function emit() {
      const snapshot = getState();
      for (const listener of state.listeners) {
        try { listener(snapshot); } catch (error) { console.error('[flock-voice] 回调抛错', error); }
      }
    }

    function getState() {
      return {
        mode: state.mode,
        reason: state.reason,
        connected: state.mode === 'streaming',
        usingFallback: state.mode === 'fallback',
        url: state.urls ? state.urls.ws : null,
        serverSampleRate: state.serverSampleRate,
        contextSampleRate: context.sampleRate,
        poolSize: state.poolSize,
        backend: state.ready ? (state.ready.modelId || state.ready.defaultModel) : null,
        reconnectAttempts: state.reconnectAttempts,
        // 完整 ready 帧：调用方据此读后端自述（音色锚点、漫游步长、音域…）
        ready: state.ready || null,
      };
    }

    function getStats() {
      const buffered = state.stats.bufferedFrames;
      // 端到端延迟估算：环形缓冲水位 + 上下文自身的输出延迟
      const bufferMs = (buffered / state.serverSampleRate) * 1000;
      const outputMs = ((context.baseLatency || 0) + (context.outputLatency || 0)) * 1000;
      return {
        mode: state.mode,
        bufferedFrames: buffered,
        bufferMs: bufferMs,
        outputLatencyMs: outputMs,
        estimatedLatencyMs: bufferMs + outputMs,
        underruns: state.stats.underruns,
        dropped: state.stats.dropped,
        primed: !!state.stats.primed,
        clampedNotes: state.clampedNotes,
        activeVoices: state.telemetry ? state.telemetry.activeVoices : (fallback ? fallback.activeVoices : 0),
        renderMs: state.telemetry ? state.telemetry.renderMs : null,
        serverBufferedFrames: state.telemetry ? state.telemetry.estimatedBufferedFrames : null,
        db: state.telemetry ? state.telemetry.db : null,
      };
    }

    // ---- worklet -----------------------------------------------------

    async function ensureWorklet() {
      if (state.workletReady) return;
      const url = options.workletUrl || SCRIPT_DIR_WORKLET;
      try {
        await context.audioWorklet.addModule(url);
      } catch (error) {
        // file:// 打开页面时 addModule 会被安全策略拦掉。退一步用 Blob URL 再试
        // （同样受限于能不能 fetch 到文件，所以 demo 请用本地 http server 打开）。
        try {
          const source = await fetch(url).then((r) => r.text());
          const blob = new Blob([source], { type: 'application/javascript' });
          await context.audioWorklet.addModule(URL.createObjectURL(blob));
        } catch (_) {
          throw new Error('加载 pcm-player-worklet.js 失败（用 http server 打开页面，别用 file://）：' + error.message);
        }
      }

      // 分轨：N 个 mono 输出，调用方按轨接自己的总线（trackOutput(row)）。
      // 混合：1 个立体声输出，与既有前端完全一致。
      // 通道数以 **ready 帧**为准；ready 之前 state.trackCount 是 1（混合）。
      const split = state.split && state.trackCount > 1;
      const nOut = split ? state.trackCount : 1;
      state.node = new AudioWorkletNode(context, 'pcm-ring-player', {
        numberOfInputs: 0,
        numberOfOutputs: nOut,
        outputChannelCount: split ? new Array(nOut).fill(1) : [2],
        processorOptions: {
          serverSampleRate: state.serverSampleRate,
          primeFrames: 4096,
          channelCount: split ? state.trackCount : 2,
        },
      });
      state.node.port.onmessage = ({ data }) => {
        if (!data || data.type !== 'stats') return;
        state.stats = data;
        // 背压回报。服务端拿它做发送节奏控制，漏报会让缓冲一路涨到高水位。
        send({ type: 'buffer', bufferedFrames: data.bufferedFrames, underruns: data.underruns });
      };
      if (split) {
        // 每轨一个 GainNode 出口。调用方拿它去接 EQ / 混响发送 / 频段占位；
        // 没接的轨默认汇到 output，保证「什么都不接也能出声」。
        state.trackGains = [];
        for (let i = 0; i < nOut; i += 1) {
          const g = context.createGain();
          state.node.connect(g, i);
          g.connect(output);
          state.trackGains.push(g);
        }
      } else {
        state.node.connect(output);
      }
      state.workletReady = true;
    }

    // ---- 连接 --------------------------------------------------------

    function send(payload) {
      const socket = state.socket;
      if (!socket || socket.readyState !== 1 /* OPEN */) return false;
      try {
        socket.send(JSON.stringify(payload));
        return true;
      } catch (_) {
        return false;
      }
    }

    function armStall() {
      clearTimeout(state.stallTimer);
      state.stallTimer = global.setTimeout(() => {
        // 连着但不发流 = 和断了一样难受。当断线处理：回落 + 重连。
        if (state.mode === 'streaming') {
          degrade('音频流停滞');
          try { state.socket && state.socket.close(); } catch (_) {}
        }
      }, options.stallTimeoutMs);
    }

    /** 掉到本地兜底。正在响的音原样搬到本地合成器上，听感不断。 */
    function degrade(reason) {
      clearTimeout(state.stallTimer);
      state.telemetry = null;
      if (state.node) {
        try { state.node.port.postMessage({ type: 'reset' }); } catch (_) {}
      }
      if (!fallback) {
        setMode('idle', reason);
        return;
      }
      setMode('fallback', reason);
      for (const [row, note] of state.held) {
        fallback.noteOn(row, note.midi, note.tier, voiceParams(row));
        if (note.endsAt) scheduleLocalRelease(row, note.endsAt - context.currentTime);
      }
    }

    function scheduleReconnect() {
      if (!options.autoReconnect || state.closedByUser) return;
      clearTimeout(state.reconnectTimer);
      const attempt = state.reconnectAttempts;
      const base = Math.min(options.reconnectMaxMs, options.reconnectMinMs * Math.pow(2, attempt));
      const delay = base * (0.7 + Math.random() * 0.6);   // 抖动，避免多客户端齐步重连
      state.reconnectAttempts += 1;
      state.reconnectTimer = global.setTimeout(() => {
        openSocket().catch(() => { /* 失败会自己再排下一次 */ });
      }, delay);
    }

    /** 分轨要在握手时告诉服务端（``?split=1``），它据此决定下行通道布局。 */
    function socketUrl() {
      const base = state.urls.ws;
      if (!state.split) return base;
      return base + (base.includes('?') ? '&' : '?') + 'split=1';
    }

    function openSocket() {
      return new Promise((resolve, reject) => {
        if (state.closedByUser) { reject(new Error('已 disconnect')); return; }
        let settled = false;
        let socket;
        try {
          socket = new WebSocket(socketUrl());
        } catch (error) {
          degrade('WebSocket 构造失败: ' + error.message);
          scheduleReconnect();
          reject(error);
          return;
        }
        socket.binaryType = 'arraybuffer';
        state.socket = socket;
        if (state.mode !== 'fallback') setMode('connecting', '');

        const timeout = global.setTimeout(() => {
          if (settled) return;
          settled = true;
          try { socket.close(); } catch (_) {}
          degrade('连接超时');
          scheduleReconnect();
          reject(new Error('连接超时'));
        }, options.connectTimeoutMs);

        socket.onmessage = ({ data }) => {
          if (data instanceof ArrayBuffer) {
            state.lastBinaryAt = Date.now();
            armStall();
            if (state.node) state.node.port.postMessage(data, [data]);
            return;
          }
          let message;
          try { message = JSON.parse(data); } catch (_) { return; }

          if (message.type === 'ready') {
            clearTimeout(timeout);
            state.ready = message;
            state.poolSize = message.poolSize || state.poolSize;
            // 核对服务端实际给的通道布局与建节点时的假设是否一致。不一致只能告警 ——
            // 节点输出数创建后不可变，静默继续会表现为「某几轨永远没声」这种难查的故障。
            if (state.split && message.channels !== state.trackCount) {
              console.error('[flock-voice] 分轨通道数不符：建节点时按 '
                + state.trackCount + ' 轨，服务端给 ' + message.channels
                + ' 轨。请重连以重建节点。');
            }
            if (message.sampleRate) {
              state.serverSampleRate = message.sampleRate;
              if (state.node) {
                state.node.port.postMessage({
                  type: 'config',
                  serverSampleRate: message.sampleRate,
                  primeFrames: 4096,
                });
              }
            }
            state.reconnectAttempts = 0;
            if (fallback) fallback.allOff();       // 交还发声权
            setMode('streaming', '');
            armStall();                            // 连上却不发流，也算故障

            resendHeldState();
            if (!settled) { settled = true; resolve(getState()); }
          } else if (message.type === 'telemetry') {
            state.telemetry = message;
          } else if (message.type === 'error') {
            console.warn('[flock-voice] 服务端报错:', message.message);
          }
        };

        socket.onerror = () => {
          // onerror 之后必定跟 onclose，收尾统一放在 onclose 里做。
        };

        socket.onclose = () => {
          if (state.socket !== socket) return;   // 已经被新连接取代
          state.socket = null;
          clearTimeout(timeout);
          if (state.closedByUser) { setMode('closed', ''); return; }
          degrade('连接断开');
          scheduleReconnect();
          if (!settled) { settled = true; reject(new Error('连接断开')); }
        };
      });
    }

    /** 重连成功后，把仍在响的音和参数补发给服务端，接上就有声。 */
    function resendHeldState() {
      for (const [row, params] of state.params) {
        send({ type: 'control', voices: [Object.assign({ voice: row }, params)] });
      }
      const now = context.currentTime;
      for (const [row, note] of state.held) {
        const remaining = note.endsAt ? Math.max(0, note.endsAt - now) : DURATION_MAX;
        if (remaining <= 0.05) { state.held.delete(row); continue; }
        sendNote(row, note.midi, note.tier, clampDuration(remaining));
      }
    }

    function sendNote(row, midi, tier, durationSeconds) {
      const params = voiceParams(row);
      return send({
        type: 'note',
        voice: row,
        midi: midi,
        velocity: tier.velocity,
        durationSeconds: durationSeconds,
        timbre: params.timbre,
        // 增益差分在这里落地：0.68 与 1.0 都是 v127，靠 gain 拉开响度
        gain: clamp01(params.gain * tier.gainScale, 0.8),
        rich: params.rich,
        room: params.room,
        dirt: params.dirt,
      });
    }

    const localTimers = new Map();

    function scheduleLocalRelease(row, seconds) {
      clearTimeout(localTimers.get(row));
      localTimers.set(row, global.setTimeout(() => {
        localTimers.delete(row);
        state.held.delete(row);
        if (fallback) fallback.noteOff(row);
      }, Math.max(0, seconds) * 1000));
    }

    // ---- 公开 API ----------------------------------------------------

    /**
     * 起音。没有时长的持续音 —— 要自己调 noteOff()。
     * 内部按 DURATION_MAX 下发，所以万一 noteOff 丢了，服务端也会在 6 s 后自己收。
     */
    function noteOn(voice, midi, velocity) {
      const row = Number(voice) | 0;
      const rawMidi = Math.round(Number(midi));
      const clamped = clampMidi(midi);
      if (clamped !== rawMidi) state.clampedNotes += 1;
      const tier = resolveVelocity(velocity);

      state.held.set(row, { midi: clamped, tier: tier, endsAt: null });
      clearTimeout(localTimers.get(row));
      localTimers.delete(row);

      if (state.mode === 'streaming') {
        sendNote(row, clamped, tier, DURATION_MAX);
      } else if (fallback) {
        fallback.noteOn(row, clamped, tier, voiceParams(row));
      }
      return { midi: clamped, clamped: clamped !== rawMidi, tier: tier.name };
    }

    /**
     * 持续延音（漫游用）。走 control 帧的 gate 语义，**不设时长上限**。
     *
     * 与 noteOn 的区别：noteOn 发的是 note 帧，服务端有 6 秒时长上限，到点自动松键；
     * 且每次重触发都会把 z_timbre 拉回当前锚点，切断漫游的连续性。
     * hold 只在 gate 由 false 变 true 时起一次音，之后换锚点走的是漫游路径 ——
     * 这才能听到「同一个音上音色连续变化」。
     */
    function hold(voice, midi, velocity) {
      const row = Number(voice) | 0;
      const clamped = clampMidi(midi);
      const tier = resolveVelocity(velocity);
      state.held.set(row, { midi: clamped, tier: tier, endsAt: null });
      clearTimeout(localTimers.get(row));
      localTimers.delete(row);
      if (state.mode === 'streaming') {
        send({
          type: 'control',
          voices: [Object.assign({ voice: row, midi: clamped, velocity: tier.value, gate: true },
                                 voiceParams(row))],
        });
      } else if (fallback) {
        fallback.noteOn(row, clamped, tier, voiceParams(row));
      }
      return { midi: clamped, tier: tier.name };
    }

    /** 结束 hold 起的延音。 */
    function release(voice) {
      const row = Number(voice) | 0;
      state.held.delete(row);
      if (state.mode === 'streaming') {
        send({ type: 'control', voices: [{ voice: row, gate: false }] });
      } else if (fallback) {
        fallback.noteOff(row);
      }
    }

    function noteOff(voice) {
      const row = Number(voice) | 0;
      state.held.delete(row);
      clearTimeout(localTimers.get(row));
      localTimers.delete(row);
      if (state.mode === 'streaming') {
        send({ type: 'noteOff', voice: row });
      } else if (fallback) {
        fallback.noteOff(row);
      }
    }

    /**
     * 起音 + 到点自动松键。这是前端 perch/unperch 的主路径
     * （`unperchToRelease` 给出 0.25–6 s 的时长）。
     */
    function noteWithDuration(voice, midi, velocity, seconds) {
      const row = Number(voice) | 0;
      const rawMidi = Math.round(Number(midi));
      const clamped = clampMidi(midi);
      if (clamped !== rawMidi) state.clampedNotes += 1;
      const tier = resolveVelocity(velocity);
      const duration = clampDuration(seconds);

      state.held.set(row, { midi: clamped, tier: tier, endsAt: context.currentTime + duration });

      if (state.mode === 'streaming') {
        sendNote(row, clamped, tier, duration);
        // 服务端会自己倒计时松键，本地只清记账，不发 noteOff。
        clearTimeout(localTimers.get(row));
        localTimers.set(row, global.setTimeout(() => {
          localTimers.delete(row);
          state.held.delete(row);
        }, duration * 1000));
      } else if (fallback) {
        fallback.noteOn(row, clamped, tier, voiceParams(row));
        scheduleLocalRelease(row, duration);
      }
      return { midi: clamped, clamped: clamped !== rawMidi, tier: tier.name, durationSeconds: duration };
    }

    /**
     * 连续参数。`timbre` 取 bass/pad/lead/pluck（或下标）。
     * `gain / rich / room / dirt` 都是 0–1。
     *
     * 注意 `room` 服务端收下但不消费 —— 混响在前端。留着这个字段只是为了让前端
     * 一套参数原样发过来不报错。
     */
    function setParams(voice, patch) {
      const row = Number(voice) | 0;
      const params = voiceParams(row);
      if (patch && patch.timbre !== undefined) {
        // 数字下标**原样透传**，不要映射到本地的 TIMBRES 名单。
        //
        // TIMBRES 是 synth 兜底后端的 4 个波形名；brave 后端是 atlas 的 9 个锚点。
        // 早先这里把数字转成 TIMBRES[t]，锚点 4–8 全变成 undefined→'pad'，
        // 服务端再把不认识的名字回落成索引 1 —— 结果是**选任何锚点都听起来一样**。
        // 音色名单归服务端所有（ready 帧的 backend.timbrePresets），客户端不该有副本。
        const t = patch.timbre;
        params.timbre = typeof t === 'number' ? (Number.isFinite(t) ? t : 0) : String(t);
      }
      if (patch && patch.timbreK !== undefined) {
        // kNN 邻居数。k=1 硬切到最近 preset，k 大则糊成一片平均音色 ——
        // 有听感后果，所以要真的发给服务端，而不是只改本地可视化。
        params.timbreK = Math.max(1, Math.min(32, Number(patch.timbreK) | 0));
      }
      if (patch && 'timbreXY' in patch) {
        // 二维音色地图坐标。给 null 表示回到锚点槽位模式。
        // 服务端按它做 kNN 混合真实 preset，优先级高于 timbre 槽位。
        const xy = patch.timbreXY;
        params.timbreXY = Array.isArray(xy) ? [Number(xy[0]), Number(xy[1])] : null;
      }
      if (patch && 'timbrePCA' in patch) {
        // 无约束 PCA 子空间系数。给 null 表示退出该模式。
        // 优先级最高——同时给了 timbreXY 也会被服务端忽略（server/backends/
        // brave_voices.py 的 note_on/_sync_timbre，PCA 分支先判断）。
        // **不保证落在训练流形上**，这是协议本身的性质，不是客户端的 bug。
        const pca = patch.timbrePCA;
        params.timbrePCA = Array.isArray(pca) ? pca.map(Number) : null;
      }
      for (const key of ['gain', 'rich', 'room', 'dirt']) {
        if (patch && patch[key] !== undefined) params[key] = clamp01(patch[key], params[key]);
      }
      if (state.mode === 'streaming') {
        // 只带参数、不带 gate/midi 的 control 帧 —— 服务端只更新参数，不会重触发。
        send({ type: 'control', voices: [Object.assign({ voice: row }, params)] });
      }
      return Object.assign({}, params);
    }

    /**
     * 连上服务端。**这个 Promise 不会因为服务端不可用而 reject 到调用方手上**
     * ——连不上就静默进入 fallback 模式并在后台重连，前端界面不该因此报错。
     * 想知道当前到底在哪个模式，用 onStateChange / getState。
     */
    async function connect(url) {
      state.closedByUser = false;
      state.urls = normalizeUrls(url);
      state.reconnectAttempts = 0;

      if (context.state === 'suspended') {
        try { await context.resume(); } catch (_) { /* 需要用户手势，调用方负责 */ }
      }
      // 分轨要先问清楚有几轨：AudioWorkletNode 的输出数在**创建时**固定，
      // 之后改不了。所以不能等 ready 帧回来再建节点。
      if (options.split) {
        try {
          const status = await fetch(state.urls.status).then((r) => r.json());
          if (status.splitSupported) {
            state.split = true;
            state.trackCount = Number(status.splitChannels) || options.poolSize;
          } else {
            console.warn('[flock-voice] 服务端不支持分轨，按混合立体声连接');
          }
        } catch (error) {
          console.warn('[flock-voice] 探测分轨能力失败，按混合立体声连接:', error.message);
        }
      }
      try {
        await ensureWorklet();
      } catch (error) {
        // worklet 都装不上就只能一直本地兜底了。
        degrade(error.message);
        return getState();
      }
      try {
        await openSocket();
      } catch (_) {
        // openSocket 内部已经 degrade + 排好重连了，这里不再往上抛。
      }
      return getState();
    }

    function disconnect() {
      state.closedByUser = true;
      clearTimeout(state.reconnectTimer);
      clearTimeout(state.stallTimer);
      for (const timer of localTimers.values()) clearTimeout(timer);
      localTimers.clear();
      state.held.clear();
      if (fallback) fallback.allOff();
      if (state.socket) {
        try { state.socket.close(); } catch (_) {}
        state.socket = null;
      }
      if (state.node) {
        try { state.node.port.postMessage({ type: 'reset' }); } catch (_) {}
      }
      setMode('closed', '');
    }

    function onStateChange(callback) {
      if (typeof callback !== 'function') return function () {};
      state.listeners.push(callback);
      try { callback(getState()); } catch (_) {}
      return function unsubscribe() {
        const index = state.listeners.indexOf(callback);
        if (index >= 0) state.listeners.splice(index, 1);
      };
    }

    /** 探一下服务端自述。跨域时会失败（服务端没开 CORS），失败不影响 WS。 */
    async function probeStatus() {
      if (!state.urls) return null;
      try {
        const response = await fetch(state.urls.status, { mode: 'cors' });
        if (!response.ok) return null;
        return await response.json();
      } catch (_) {
        return null;
      }
    }

    /**
     * 第 row 轨的干声出口（分轨模式）。把它接到你自己的声部总线上：
     *
     *     const out = voice.trackOutput(1);
     *     out.disconnect();          // 断开默认汇流
     *     out.connect(bassBusEq);    // 接进这一轨自己的链路
     *
     * 混合模式或轨号越界时返回 null —— 调用方据此决定要不要退回 `output`。
     */
    function trackOutput(row) {
      if (!state.trackGains) return null;
      const i = Number(row);
      return (Number.isInteger(i) && i >= 0 && i < state.trackGains.length)
        ? state.trackGains[i] : null;
    }

    return {
      context: context,
      output: output,
      trackOutput: trackOutput,
      /** 分轨轨数；混合模式为 1。连接后才准确。 */
      get trackCount() { return state.split ? state.trackCount : 1; },
      get isSplit() { return !!state.split; },
      connect: connect,
      disconnect: disconnect,
      noteOn: noteOn,
      noteOff: noteOff,
      noteWithDuration: noteWithDuration,
      hold: hold,
      release: release,
      setParams: setParams,
      onStateChange: onStateChange,
      getState: getState,
      getStats: getStats,
      probeStatus: probeStatus,
      get mode() { return state.mode; },
    };
  }

  global.FlockVoiceClient = {
    create: createClient,
    // 纯函数，方便前端单测和在控制台里手验映射规则
    mapVelocity: mapVelocity,
    clampMidi: clampMidi,
    clampDuration: clampDuration,
    TIMBRES: TIMBRES,
    MIDI_MIN: MIDI_MIN,
    MIDI_MAX: MIDI_MAX,
    DURATION_MIN: DURATION_MIN,
    DURATION_MAX: DURATION_MAX,
    VELOCITY_TIERS: VELOCITY_TIERS,
  };

})(typeof window !== 'undefined' ? window : this);
