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

  const completionTokens = Number(cfg.completionTokens) || 0;
  // 图片 token 总开关: imageEnabled 关闭时一律 0(响应不含任何图片 token，行为同纯文字)。
  // 开启后再夹界: 输入图片 <= 输入总量; 输出图片 <= 输出总量。
  // new-api 计费时会把图片输入从 promptTokens、图片输出从 completionTokens 里劈出来单独计价，
  // 所以这里必须是"子集"关系，否则文字段会被算成负数(new-api 侧再兜底夹 0)。
  const imageOn = !!Number(cfg.imageEnabled);
  const imageInputTokens = imageOn
    ? Math.max(0, Math.min(Number(cfg.imageInputTokens) || 0, promptTokens))
    : 0;
  const imageOutputTokens = imageOn
    ? Math.max(0, Math.min(Number(cfg.imageOutputTokens) || 0, completionTokens))
    : 0;

  return {
    promptTokens,
    completionTokens,
    cachedTokens: clampedCached,
    cacheCreationTokens: clampedCreation,
    imageInputTokens,
    imageOutputTokens,
  };
}

// 是否应触发注入错误(概率)
// 由 errorEnabled 显式控制开关，不再依赖 errorStatus>0 来隐含"关闭"语义
export function shouldInjectError(cfg) {
  if (!Number(cfg.errorEnabled)) return false;
  return Math.random() * 100 < Number(cfg.errorRate);
}

// 渠道级门禁: 渠道被关掉(enabled=0) -> 恒失败, 模拟"渠道挂了"; 否则按 errorRate 概率失败, 模拟偶发故障。
// 跟模型自己的 errorRate 是两码事——渠道管链路通不通, 模型管返回内容对不对, 互不影响也可以叠加。
export function shouldChannelFail(channel, rand = Math.random) {
  if (!channel) return false;
  if (!channel.enabled) return true;
  return rand() * 100 < Number(channel.errorRate);
}

// Box-Muller: 从 rand()(默认 Math.random，可注入以便测试)产出一个标准正态分布随机数。
function gaussian(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// 算这次响应该延迟多少 ms —— 应用在流式/非流式共同的"发出响应前"那一刻，两种请求都吃得到。
//   fixed: 直接用 latencyMs。
//   range: 在 [latencyMin, latencyMax] 里取一个数——uniform 是均匀随机，normal 是以区间中点为均值、
//          区间六分之一为标准差的正态分布(±3σ 基本落在区间内)，最后夹一次界防止极端尾部溢出。
// rand 可注入(测试用固定伪随机源)，不传就是 Math.random。
export function resolveLatencyMs(cfg, rand = Math.random) {
  if (cfg.latencyMode !== "range") return Math.max(0, Number(cfg.latencyMs) || 0);

  const min = Math.max(0, Number(cfg.latencyMin) || 0);
  const max = Math.max(min, Number(cfg.latencyMax) || 0);
  if (max <= min) return min;

  if (cfg.latencyDist === "normal") {
    const mean = (min + max) / 2;
    const stddev = (max - min) / 6;
    const v = mean + stddev * gaussian(rand);
    return Math.round(Math.min(max, Math.max(min, v)));
  }
  return Math.round(min + rand() * (max - min));
}

// 把 content 切成"至多 maxChunks 块"(每块 >=8 字符)，让长正文也能顺畅流式，
// 不影响 content 本身(原样、不截断)。
export function chunkText(text, maxChunks = 120) {
  if (!text) return [""];
  const size = Math.max(8, Math.ceil(text.length / maxChunks));
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}
