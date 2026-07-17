// usage.js —— 从模型配置 + 请求算出"格式无关"的 token 中间量。
// 各 formats/*.js 再把它映射成自家 usage 字段。

// 极简 token 估算：字符数 / 4。messages 可能是 OpenAI/Claude 形状或 Gemini contents。
export function countTextTokens(text) {
  return Math.max(1, Math.ceil((text || "").length / 4));
}

// 从已解析的统一 messages(数组, 每项有 content 字符串)估算输入 token
export function estimatePromptTokens(messages = []) {
  const text = messages
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")))
    .join(" ");
  return countTextTokens(text);
}

// 计算格式无关的 token 中间量。
//   cfg      : 模型配置
//   messages : 解析后的统一消息数组(用于 auto 估算)
// 返回 { promptTokens, completionTokens, cachedTokens, cacheCreationTokens }
export function computeUsage(cfg, messages) {
  const promptTokens =
    cfg.promptMode === "fixed"
      ? Number(cfg.promptTokens) || 0
      : estimatePromptTokens(messages);

  let cachedTokens = 0;
  if (cfg.cacheMode === "ratio") {
    cachedTokens = Math.floor(promptTokens * (Number(cfg.cacheRatio) || 0));
  } else if (cfg.cacheMode === "fixed") {
    cachedTokens = Number(cfg.cachedTokens) || 0;
  }
  const cacheCreationTokens = Number(cfg.cacheCreationTokens) || 0;

  // 夹取: 缓存命中 + 缓存写入 不能超过输入总量, 各自 >= 0
  const clampedCreation = Math.max(0, Math.min(cacheCreationTokens, promptTokens));
  const clampedCached = Math.max(0, Math.min(cachedTokens, promptTokens - clampedCreation));

  return {
    promptTokens,
    completionTokens: Number(cfg.completionTokens) || 0,
    cachedTokens: clampedCached,
    cacheCreationTokens: clampedCreation,
  };
}

// 是否应触发注入错误(概率)
export function shouldInjectError(cfg) {
  return Number(cfg.errorStatus) > 0 && Math.random() * 100 < Number(cfg.errorRate);
}
