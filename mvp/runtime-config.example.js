// 独立发行版固定访问同源代理。实际 local/cloud/rules 选择写在
// config/runtime.json；云端密钥只放 LCS_AGENT_API_KEY 环境变量。
window.LCS_RUNTIME = {
  stepfunBase: '/api/agent',
};
