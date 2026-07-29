// formats/openai_image.js —— OpenAI 生图格式: /v1/images/generations 与 /v1/images/edits
// 返回 Images API 形态(data:[{b64_json}] + usage:{input_tokens/output_tokens/input_tokens_details})，
// 模拟 gpt-image-1：输出是纯图片，output_tokens 即图片输出 token(上游不给输出模态明细)。
// new-api 的图片 relay handler 会把 output_tokens 记为 CompletionTokenDetails.ImageTokens，
// 再按 imageCompletionRatio 单独计价。
import { computeUsage } from "../usage.js";

// 1x1 透明 PNG，占位假图，仅为让响应"长得像一张图"。
const FAKE_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const nowSec = () => Math.floor(Date.now() / 1000);

// 生图请求: { model, prompt, n?, size?, ... }。prompt 转成伪 message 供 auto 估算输入 token。
export function parseRequest(body /*, url */) {
  const prompt = typeof body?.prompt === "string" ? body.prompt : "";
  return {
    model: body?.model,
    messages: prompt ? [{ role: "user", content: prompt }] : [],
    n: Math.max(1, Number(body?.n) || 1),
    stream: false, // 生图走非流式(gpt-image-1 的 partial_images 流式此处不模拟)
  };
}

// Images API 的 usage 形态(与 chat 的 prompt_tokens/completion_tokens 不同)。
//   input_tokens        = 输入总量(promptTokens)
//   output_tokens       = 图片输出 token(纯图，取整段输出)
//   input_tokens_details= { text_tokens, image_tokens }
function toImageUsage(u) {
  const outputTokens = u.completionTokens;
  const imageIn = u.imageInputTokens;
  const textIn = Math.max(0, u.promptTokens - imageIn);
  // 输出模态明细：真实 gpt-image 会返回 output_tokens_details.{image_tokens,text_tokens}。
  // 未单独配图片输出时,生图端点默认整段输出即图片。
  const imageOut = u.imageOutputTokens > 0 ? u.imageOutputTokens : outputTokens;
  const textOut = Math.max(0, outputTokens - imageOut);
  return {
    total_tokens: u.promptTokens + outputTokens,
    input_tokens: u.promptTokens,
    output_tokens: outputTokens,
    input_tokens_details: { text_tokens: textIn, image_tokens: imageIn },
    output_tokens_details: { text_tokens: textOut, image_tokens: imageOut },
  };
}

export function buildResponse(cfg, messages, model, n = 1) {
  const u = computeUsage(cfg, messages);
  const data = [];
  for (let i = 0; i < n; i++) data.push({ b64_json: FAKE_PNG_B64 });
  return {
    created: nowSec(),
    data,
    usage: toImageUsage(u),
  };
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

export const meta = { sse: false, usageField: "usage", imagesApi: true };
