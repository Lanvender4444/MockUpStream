// testRunner.js —— 压测核心逻辑：目标解析 + 请求体拼装 + 并发执行。
// 不 import store.js —— 只认调用方传进来的 state({models,channels}) 和 baseUrl，
// 因此同一份逻辑能同时服务"本机面板"(server.js 直读 store)和"CLI --host 远程压测"(GET /__state 拿到的 JSON)。

// 从 (modelId, channelId) 算出该打哪个协议、哪个端口。
// channelId 为空/null/"" -> 主端口(state.port，缺省兜底 8788)；
// channelId 指定但在 state.channels 里找不到 -> 抛错，不静默回退主端口(避免测错目标却不自知)。
export function resolveTarget(state, { modelId, channelId }) {
  const model = (state.models || []).find((m) => m.id === modelId);
  if (!model) throw new Error(`未知模型: ${modelId}`);

  if (!channelId) {
    return { format: model.format, port: state.port || 8788 };
  }
  const channel = (state.channels || []).find((c) => c.id === channelId);
  if (!channel) throw new Error(`未知渠道: ${channelId}`);
  return { format: model.format, port: channel.port };
}
