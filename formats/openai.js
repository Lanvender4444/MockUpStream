// formats/openai.js —— OpenAI 兼容格式: /v1/chat/completions
import { computeUsage, buildOutputText, chunkText } from "../usage.js";

const ID = "chatcmpl-mock-0001";
const CREATED = 1700000000;

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
  return {
    prompt_tokens: u.promptTokens,
    completion_tokens: u.completionTokens,
    total_tokens: u.promptTokens + u.completionTokens,
    prompt_tokens_details: details,
  };
}

// 非流式响应体
export function buildResponse(cfg, messages, model) {
  const u = computeUsage(cfg, messages);
  return {
    id: ID, object: "chat.completion", created: CREATED, model,
    choices: [{ index: 0, message: { role: "assistant", content: buildOutputText(cfg) }, finish_reason: "stop" }],
    usage: toUsage(u),
  };
}

// 流式: 通过 send(obj) 逐块发 SSE data; 末尾发 usage 块 + [DONE]
export async function buildStream(cfg, messages, model, send, sleep) {
  const u = computeUsage(cfg, messages);
  const base = { id: ID, object: "chat.completion.chunk", created: CREATED, model };
  send({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
  for (const ch of chunkText(buildOutputText(cfg))) {
    if (cfg.chunkDelayMs > 0) await sleep(cfg.chunkDelayMs);
    send({ ...base, choices: [{ index: 0, delta: { content: ch }, finish_reason: null }] });
  }
  send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  send({ ...base, choices: [], usage: toUsage(u) });
  send("[DONE]");
}

// 错误体
export function buildError(cfg) {
  return { error: { message: cfg.errorMessage, type: "mock_error", code: String(cfg.errorStatus) } };
}

export const meta = { sse: true, usageField: "usage" };
