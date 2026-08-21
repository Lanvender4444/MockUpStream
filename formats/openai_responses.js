// formats/openai_responses.js —— OpenAI Responses API: /v1/responses
import { computeUsage, chunkText } from "../usage.js";

const nowSec = () => Math.floor(Date.now() / 1000);
const responseId = () => `resp_mock_${Math.random().toString(16).slice(2, 14)}`;
const messageId = () => `msg_mock_${Math.random().toString(16).slice(2, 14)}`;

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      return part?.text ?? part?.input_text ?? part?.output_text ?? JSON.stringify(part ?? "");
    })
    .join(" ");
}

function inputMessages(input) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [];
  return input.map((item) => ({
    role: item?.role || "user",
    content: contentText(item?.content ?? item),
  }));
}

export function parseRequest(body /*, url */) {
  return {
    model: body?.model,
    messages: inputMessages(body?.input),
    stream: !!body?.stream,
  };
}

function toUsage(u) {
  return {
    input_tokens: u.promptTokens,
    output_tokens: u.completionTokens,
    total_tokens: u.promptTokens + u.completionTokens,
    input_tokens_details: { cached_tokens: u.cachedTokens },
    output_tokens_details: { reasoning_tokens: 0 },
  };
}

function buildMessage(id, text) {
  return {
    id,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

export function buildResponse(cfg, messages, model) {
  const id = responseId();
  const msgId = messageId();
  return {
    id,
    object: "response",
    created_at: nowSec(),
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model,
    output: [buildMessage(msgId, cfg.content)],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: null,
    store: true,
    temperature: 1,
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    truncation: "disabled",
    usage: toUsage(computeUsage(cfg, messages)),
  };
}

export async function buildStream(cfg, messages, model, send, sleep) {
  const completed = buildResponse(cfg, messages, model);
  const item = buildMessage(completed.output[0].id, "");

  send("response.created", {
    type: "response.created",
    response: { ...completed, status: "in_progress", output: [], usage: null },
  });
  send("response.output_item.added", {
    type: "response.output_item.added",
    output_index: 0,
    item,
  });

  for (const delta of chunkText(cfg.content)) {
    if (cfg.chunkDelayMs > 0) await sleep(cfg.chunkDelayMs);
    send("response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta,
    });
  }

  send("response.output_text.done", {
    type: "response.output_text.done",
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    text: cfg.content,
  });
  send("response.output_item.done", {
    type: "response.output_item.done",
    output_index: 0,
    item: completed.output[0],
  });
  send("response.completed", { type: "response.completed", response: completed });
  send(null, "[DONE]");
}

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

export const meta = { sse: true, namedEvents: true, usageField: "usage" };
