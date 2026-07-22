# 接入本地 LLM

本地 LLM 是独立外部依赖。仓库不包含 vLLM、LLM 镜像层或模型权重；音源服务只
要求一个可从容器访问的 OpenAI 兼容 `/v1` 端点。

## 接口要求

- `GET /v1/models` 返回 2xx；
- `POST /v1/chat/completions`；
- 支持当前客户端使用的 `response_format.type=json_schema`；
- 支持非流式 JSON 响应；
- 服务模型名与 `config/runtime.json` 的 `model` 一致。

默认沿用当前生产契约：模型别名 `bird_agent`，宿主端口 8081。音源容器通过
Docker 的 `host.docker.internal:host-gateway` 访问宿主机。

## 配置

`config/runtime.json` 保持：

```json
{
  "agent": {
    "mode": "local",
    "timeoutSeconds": 60,
    "local": {
      "baseUrl": "http://host.docker.internal:8081/v1",
      "model": "bird_agent"
    },
    "cloud": {
      "baseUrl": "",
      "model": "",
      "apiKeyEnv": "LCS_AGENT_API_KEY"
    }
  }
}
```

上面仅展示 `agent` 段；不要删除原文件的 `http` 和 `audio` 段。local 模式不会
添加 Authorization 头。

## 可选 vLLM 外部依赖示例

下面只是独立启动参考，不由本仓库执行。部署者自行准备兼容模型目录和 vLLM
镜像，并遵守相应许可：

```bash
export LLM_MODEL_DIR=/absolute/path/to/your/openai-compatible-model
docker run -d \
  --name intelligent-jungle-local-llm \
  --restart unless-stopped \
  --gpus all \
  -p 8081:8000 \
  -v "$LLM_MODEL_DIR:/model:ro" \
  vllm/vllm-openai:latest \
  --model /model \
  --served-model-name bird_agent \
  --gpu-memory-utilization 0.575 \
  --structured-outputs-config '{"backend":"xgrammar","disable_any_whitespace":true}'
```

`0.575` 是当前 DGX Spark 共享 GPU 场景的保守起点，不是所有机器的通用最优值。
不要默认打开 n-gram 投机解码：当前结构化 Agent 负载在高并发下没有稳定收益。

先独立验证上游：

```bash
curl -fsS http://127.0.0.1:8081/v1/models
```

随后重启本项目并验收：

```bash
./scripts/stop.sh
./scripts/start.sh
./scripts/verify.sh
```

若 `/v1/models` 可用但结构化请求失败，检查服务是否真的支持 `json_schema`，以及
xgrammar 是否禁用了任意空白；前端不会因为 LLM 故障停止仿真，而会回到规则层。
