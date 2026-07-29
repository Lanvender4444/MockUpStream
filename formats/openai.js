// formats/openai.js —— OpenAI 兼容格式: /v1/chat/completions
import { computeUsage, chunkText } from "../usage.js";

const ID = "chatcmpl-mock-0001";
// 每次调用取当前 Unix 秒；不能用常量，否则会固定成服务器启动那一刻的时间
const nowSec = () => Math.floor(Date.now() / 1000);

// 解析请求 -> { model, messages:[{content}], stream }
export function parseRequest(body /*, url */) {
  return {
    model: body?.model,
    messages: Array.isArray(body?.messages) ? body.messages : [],
    stream: !!body?.stream,
  };
}

function toUsage(u) {
  const details = { cached_tokens: u.cachedTokens };
  if (u.cacheCreationTokens > 0) details.cache_creation_tokens = u.cacheCreationTokens;
  // 输入图片明细照常给(方便测图片输入计价)。
  if (u.imageInputTokens > 0) details.image_tokens = u.imageInputTokens;
  const usage = {
    prompt_tokens: u.promptTokens,
    completion_tokens: u.completionTokens,
    total_tokens: u.promptTokens + u.completionTokens,
    prompt_tokens_details: details,
  };
  // 输出侧**刻意不给** completion_tokens_details.image_tokens——真实 gpt-image 走 chat 就不吐
  // 输出明细,正好用来测 new-api "无明细 + 配了图片输出倍率 → 整段 completion 按图片计"兜底。
  // 图片输出的逐字段明细在生图端点 formats/openai_image.js 的 output_tokens_details 里给。
  return usage;
}

// 非流式响应体。content 原样返回(不被 completionTokens 截断)。
export function buildResponse(cfg, messages, model) {
  const u = computeUsage(cfg, messages);
  return {
    id: ID, object: "chat.completion", created: nowSec(), model,
    choices: [{ index: 0, message: { role: "assistant", content: cfg.content }, finish_reason: "stop" }],
    usage: toUsage(u),
  };
}

// 流式: 把 content 分块(至多 120 块)逐块发; 末尾发 usage 块 + [DONE]
export async function buildStream(cfg, messages, model, send, sleep) {
  const u = computeUsage(cfg, messages);
  const base = { id: ID, object: "chat.completion.chunk", created: nowSec(), model };
  send({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
  for (const ch of chunkText(cfg.content)) {
    if (cfg.chunkDelayMs > 0) await sleep(cfg.chunkDelayMs);
    send({ ...base, choices: [{ index: 0, delta: { content: ch }, finish_reason: null }] });
  }
  send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  send({ ...base, choices: [], usage: toUsage(u) });
  send("[DONE]");
}

// 错误体
export function buildError(cfg) {
  return {
    error: {
      message: cfg.errorMessage,
      type: Number(cfg.errorStatus) >= 500 ? "server_error" : "invalid_request_error",
      param: null,
      code: String(cfg.errorStatus),
    },
  };
}

export const meta = { sse: true, usageField: "usage" };
