// 浏览器只访问同源 Agent 代理。local/cloud/rules 由服务端 config/runtime.json
// 选择；上游地址和云端密钥都不会进入前端。
window.LCS_RUNTIME = {
  stepfunBase: '/api/agent',
};
