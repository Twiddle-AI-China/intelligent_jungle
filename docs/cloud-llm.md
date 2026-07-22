# 接入云端 LLM

cloud 模式复用当前 `BirdAgentClient` 的 OpenAI 兼容契约。浏览器仍只调用同源
`/api/agent/v1/*`；服务端代理负责选择模型和注入密钥。

## 1. 配置上游

编辑 `config/runtime.json` 的 `agent` 段：

```json
{
  "agent": {
    "mode": "cloud",
    "timeoutSeconds": 60,
    "local": {
      "baseUrl": "http://host.docker.internal:8081/v1",
      "model": "bird_agent"
    },
    "cloud": {
      "baseUrl": "https://api.your-provider.invalid/v1",
      "model": "your-json-schema-model",
      "apiKeyEnv": "LCS_AGENT_API_KEY"
    }
  }
}
```

云端服务必须兼容 `/v1/models`、`/v1/chat/completions` 和
`response_format.type=json_schema`。不支持 JSON Schema 的服务需要另建协议适配器，
不能靠改 prompt 冒充结构化输出。

## 2. 设置密钥

临时会话可以直接导出：

```bash
export LCS_AGENT_API_KEY='由云服务商提供的值'
```

长期部署可复制受忽略的 `.env`：

```bash
cp .env.example .env
chmod 600 .env
```

然后只在 `.env` 本地文件填写值。`scripts/common.sh` 会在启动容器前加载它；
`.env` 不进入 Git。不要把密钥写进 `runtime.json`、JavaScript、Dockerfile 或命令
历史。

## 3. 重启与验收

```bash
./scripts/stop.sh
./scripts/start.sh
./scripts/verify.sh
```

cloud 模式缺少环境变量时服务会拒绝启动，而不是无提示地使用空密钥。状态接口只
返回 `mode`、`configured`、`available` 和脱敏错误类别，不返回 URL、模型密钥或
Authorization 头。

## 4. 纯规则模式

不希望发出任何 LLM 网络请求时，把 `mode` 改成 `rules`。local/cloud 段可以保留
空值，服务会忽略未选中的 provider；`/api/agent/v1/models` 返回 503，现有前端据此
立即使用确定性生态规则。`scripts/verify.sh` 会把这个 503 视为 rules 模式的正确行为。
