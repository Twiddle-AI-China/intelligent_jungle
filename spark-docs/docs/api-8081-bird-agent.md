# 8081 推理后端 API 文档(前端调用指南)

> 服务:Step3-VL-10B(INT4 AWQ)@ vLLM,OpenAI 兼容协议。基地址 `http://192.168.9.140:8081`。
> 面向前端/调用方,只讲怎么调、有什么坑。运维细节见 `HANDOFF.md`。

## 1. 基本信息

| 项 | 值 |
|---|---|
| Base URL | `http://192.168.9.140:8081`(局域网,无鉴权) |
| 模型名 | **`bird_agent`**(上游契约,勿改);别名 `Step3-VL-10B-AWQ-CT`,两者等价 |
| 协议 | OpenAI 兼容(`/v1/chat/completions` 等) |
| 上下文上限 | 32768 token(输入+输出) |
| 实测性能 | 单流 ~40 tok/s,TTFT 50–110 ms;16 并发聚合 ~620 tok/s |
| 健康检查 | `GET /v1/models` 返回 200 即在线 |

浏览器直接跨域调用即可(服务已开 CORS `*`)。

## 2. 最小调用(非流式)

```js
const r = await fetch("http://192.168.9.140:8081/v1/chat/completions", {
  method: "POST",
  headers: {"Content-Type": "application/json"},
  body: JSON.stringify({
    model: "bird_agent",
    messages: [
      {role: "system", content: "你是助手"},
      {role: "user", content: "你好"}
    ],
    temperature: 0,
    max_tokens: 512
  })
});
const obj = await r.json();
console.log(obj.choices[0].message.content);
console.log(obj.usage);  // {prompt_tokens, completion_tokens, total_tokens}
```

## 3. 流式调用(SSE,推荐:可测 TTFT、逐字出)

请求加 `stream: true` 和 `stream_options: {include_usage: true}`(最后一个事件带回 token 用量)。

```js
const resp = await fetch("http://192.168.9.140:8081/v1/chat/completions", {
  method: "POST",
  headers: {"Content-Type": "application/json"},
  body: JSON.stringify({
    model: "bird_agent",
    messages: [{role: "user", content: "讲个故事"}],
    temperature: 0.7, max_tokens: 512,
    stream: true, stream_options: {include_usage: true}
  })
});

const reader = resp.body.getReader();
const dec = new TextDecoder();
let buf = "";
while (true) {
  const {done, value} = await reader.read();
  if (done) break;
  buf += dec.decode(value, {stream: true});   // 关键:{stream:true},多字节 UTF-8 可能跨 TCP 包
  let idx;
  while ((idx = buf.indexOf("\n\n")) >= 0) {   // SSE 事件以空行分隔
    const ev = buf.slice(0, idx); buf = buf.slice(idx + 2);
    for (const line of ev.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      const obj = JSON.parse(data);
      if (obj.usage) console.log("用量:", obj.usage);
      const delta = obj.choices?.[0]?.delta?.content || "";
      if (delta) process.stdout.write(delta);  // 浏览器里改成拼到 DOM
      if (obj.choices?.[0]?.finish_reason) console.log("finish:", obj.choices[0].finish_reason);
    }
  }
}
```

**流式三个坑**:

1. **必须缓冲原始字节流**,`TextDecoder` 带 `{stream: true}`——中文多字节字符可能跨 TCP 包,直接逐包 decode 会乱码(参考实现:`bench_vllm_step3vl.py`、`prompt_lab.html`)。
2. `finish_reason == "length"` 表示被 `max_tokens` 截断,前端应提示或自动加大。
3. 事件里 `delta.content` 可能为空字符串(首包/尾包),要判空。

## 4. 结构化输出(agent 必用)

让模型只回 JSON。两档:

- `response_format: {"type": "json_object"}` —— 只保证是合法 JSON,**大 JSON 输入时会被模型原样复读,不要单独用**。
- `response_format: {"type": "json_schema", "json_schema": {"name": "decision", "schema": {...}}}` —— **按 schema 逐 token 约束,生产用法**。

```js
body: JSON.stringify({
  model: "bird_agent",
  messages: [/* ... */],
  temperature: 0,
  max_tokens: 1024,
  response_format: {
    type: "json_schema",
    json_schema: {name: "decision", schema: {
      type: "object",
      properties: {
        reason: {type: "string", pattern: "^[\\u4e00-\\u9fa50-9\\uff0c\\u3002\\u3001\\uff1b\\uff1a]{4,30}$"},
        action: {enum: ["a", "b", "c"]},
        value:  {type: "number"}
      },
      required: ["reason", "action", "value"],
      additionalProperties: false
    }}
  }
})
```

**schema 模式实战要点(全是实测踩出来的)**:

- **enum/规则编号类字段不要放 properties 第一位**(引导解码按字段顺序生成,会被第一个枚举值锚定);把自由文本字段(如 reason)放最前,相当于 mini-CoT,后续字段更一致。
- **自由文本字段用 `pattern` 限定字符集和长度**(如上例 4~30 个中文/数字),否则模型会把它当分析通道写几百字撑爆 `max_tokens`。
- **不要用 `maxLength` 硬截断**——截断后模型可能陷入无限空白循环。限长走 `pattern`。
- `max_tokens` 给足(建议 1024),截断的 JSON 就是废文。
- schema 里每个字段都会在输出中出现(`required` 全列),不要指望模型「省略」字段;可空字段用 `anyOf: [{...}, {"type":"null"}]`。

## 5. 采样参数速查

| 参数 | 建议 | 说明 |
|---|---|---|
| `temperature` | agent/结构化任务 **0**;创作 0.7 | 0 = 贪心,结果可复现 |
| `top_p` | 1 | 配合 temperature 使用 |
| `max_tokens` | 结构化 512–1024;长文按需 | 超了 `finish_reason=length` 截断 |
| `stop` | ≤4 个字符串 | 命中即停 |
| `seed` | 需要严格复现时给整数 | 默认随机 |
| `presence_penalty` / `frequency_penalty` | 默认 0 | 重复抑制,一般不用动 |

不支持的参数(如 `logit_bias` 组合 min_p)可能被忽略,别依赖。

## 6. 错误与重试

| 现象 | 含义 | 处理 |
|---|---|---|
| HTTP 400 `error parsing the body` | 请求 JSON 本身坏了(常见:中文被 shell 转义搞坏) | 检查 body 序列化;代码里用 JSON.stringify,别手拼 |
| HTTP 500/503 | 引擎内部错误或重启中 | 退避重试;持续 5 分钟以上找运维 |
| `finish_reason=length` | 输出被 max_tokens 截断 | 加大 max_tokens,或缩短 prompt |
| 返回合法 JSON 但内容复读输入 | 误用了 json_object | 换 json_schema(见 §4) |
| 连接拒绝 | 服务下线/重启(启动 ~2.5 分钟) | 轮询 `/v1/models` 等就绪 |

**重试策略**:幂等(本服务无副作用),指数退避即可;agent 高频调用建议单次超时 60 s,失败 3 s 后重试,沿用上次决策兜底。

## 7. 给前端的性能预期

- 单请求:TTFT 约 0.05–0.11 s,之后 ~40 tok/s 匀速出字;1200 token prompt 的结构化决策请求总耗时 ~2.3 s。
- 并发:服务自动做 continuous batching,16 路并发聚合 ~620 tok/s,前端无需排队,直接并发发。
- **长 system prompt 每次请求都重复发也没关系**——服务端开了前缀缓存(命中时 prefill 几乎免费),前端不要做 prompt 拼接去重。
- 模型是推理型,自由文本下会先输出长篇思考(`<think>…</think>`);agent 调用请走结构化输出(顺便消灭思考),或 prompt 里要求直接作答。

## 8. 一页速查

```
GET  http://192.168.9.140:8081/v1/models              # 健康检查
POST http://192.168.9.140:8081/v1/chat/completions    # 对话(流式/非流式/结构化)
模型名:bird_agent(别名 Step3-VL-10B-AWQ-CT)
上下文:32768 tok;单流 ~40 tok/s;16 并发 ~620 tok/s
```
