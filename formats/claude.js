// formats/claude.js —— Claude Messages 格式: /v1/messages
// Claude usage 语义: input_tokens 通常不含缓存部分; 缓存读/写单列。
import { computeUsage } from "../usage.js";

const ID = "msg_mockclaude0001";

// Claude 请求: { model, messages:[{role, content}], system?, stream }
export function parseRequest(body /*, url */) {
  const messages = Array.isArray(body?.messages) ? [...body.messages] : [];
  // system 也算进输入估算
  if (body?.system) messages.push({ role: "system", content: body.system });
  return { model: body?.model, messages, stream: !!body?.stream };
}

// Claude usage: input_tokens = prompt - cached - creation (与 new-api IsClaudeUsageSemantic 一致)
function toUsage(u) {
  return {
    input_tokens: Math.max(0, u.promptTokens - u.cachedTokens - u.cacheCreationTokens),
    output_tokens: u.completionTokens,
    cache_read_input_tokens: u.cachedTokens,
    cache_creation_input_tokens: u.cacheCreationTokens,
  };
}

export function buildResponse(cfg, messages, model) {
  const u = computeUsage(cfg, messages);
  return {
    id: ID, type: "message", role: "assistant", model,
    content: [{ type: "text", text: cfg.content }],
    stop_reason: "end_turn", stop_sequence: null,
    usage: toUsage(u),
  };
}

// Claude 流式: message_start -> content_block_start -> content_block_delta* -> content_block_stop
//              -> message_delta(带 usage) -> message_stop
// send(eventName, dataObj) 发一条 SSE 事件
export async function buildStream(cfg, messages, model, send, sleep) {
  const u = computeUsage(cfg, messages);
  const usage = toUsage(u);
  send("message_start", {
    type: "message_start",
    message: {
      id: ID, type: "message", role: "assistant", model, content: [],
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: usage.input_tokens, output_tokens: 0,
               cache_read_input_tokens: usage.cache_read_input_tokens,
               cache_creation_input_tokens: usage.cache_creation_input_tokens },
    },
  });
  send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  for (const ch of (cfg.content.match(/.{1,8}/gs) || [cfg.content])) {
    if (cfg.chunkDelayMs > 0) await sleep(cfg.chunkDelayMs);
    send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ch } });
  }
  send("content_block_stop", { type: "content_block_stop", index: 0 });
  send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: usage.output_tokens },
  });
  send("message_stop", { type: "message_stop" });
}

export function buildError(cfg) {
  return { type: "error", error: { type: "mock_error", message: cfg.errorMessage } };
}

export const meta = { sse: true, namedEvents: true, usageField: "usage" };
