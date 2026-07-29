// formats/gemini.js —— Gemini 格式: /v1beta/models/{model}:generateContent 与 :streamGenerateContent
import { computeUsage, countTextTokens, chunkText } from "../usage.js";

// 1x1 透明 PNG 占位假图，让 Gemini 生图响应"长得像一张图"(inlineData part)。
const FAKE_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// Gemini 请求: { contents:[{role, parts:[{text}]}], systemInstruction? }, model 在 URL path 里
export function parseRequest(body, url) {
  const contents = Array.isArray(body?.contents) ? body.contents : [];
  const messages = contents.map((c) => ({
    role: c.role,
    content: (c.parts || []).map((p) => p.text || "").join(""),
  }));
  if (body?.systemInstruction) {
    const t = (body.systemInstruction.parts || []).map((p) => p.text || "").join("");
    if (t) messages.push({ role: "system", content: t });
  }
  // model 与 stream 从 path 解析: /v1beta/models/gemini-2.5-pro:streamGenerateContent
  const m = (url?.pathname || "").match(/\/models\/([^:]+):(\w+)/);
  const model = m ? decodeURIComponent(m[1]) : body?.model;
  const stream = m ? m[2] === "streamGenerateContent" : false;
  return { model, messages, stream };
}

function toUsageMetadata(u) {
  const meta = {
    promptTokenCount: u.promptTokens,
    candidatesTokenCount: u.completionTokens,
    totalTokenCount: u.promptTokens + u.completionTokens,
  };
  if (u.cachedTokens > 0) meta.cachedContentTokenCount = u.cachedTokens;
  // 输入模态明细: new-api 按 modality 把 IMAGE 归到图片输入、TEXT 归到文字输入。
  if (u.imageInputTokens > 0) {
    const textIn = Math.max(0, u.promptTokens - u.imageInputTokens);
    meta.promptTokensDetails = [
      { modality: "TEXT", tokenCount: textIn },
      { modality: "IMAGE", tokenCount: u.imageInputTokens },
    ];
  }
  // 输出模态明细: candidatesTokensDetails[IMAGE] 就是生图输出 token，new-api 据此单独计价。
  // 忠实复现真实 gemini：生图响应里**只 itemize IMAGE 模态、不单列 TEXT**——文字部分隐含在
  // candidatesTokenCount 里，由下游 completion - image 反推(所以真实响应的 text_tokens 会等于
  // 整个 completion，除非下游修了 GetCompletionTextTokens)。
  if (u.imageOutputTokens > 0) {
    meta.candidatesTokensDetails = [{ modality: "IMAGE", tokenCount: u.imageOutputTokens }];
  }
  return meta;
}

// withImage=true 时追加一个 inlineData 图片 part(模拟 gemini 生图 / nano-banana 输出)。
function candidate(text, finish, withImage = false) {
  const parts = [];
  if (text) parts.push({ text });
  if (withImage) parts.push({ inlineData: { mimeType: "image/png", data: FAKE_PNG_B64 } });
  if (parts.length === 0) parts.push({ text: "" });
  return {
    content: { role: "model", parts },
    finishReason: finish || null,
    index: 0,
  };
}

export function buildResponse(cfg, messages, model) {
  const u = computeUsage(cfg, messages);
  return {
    candidates: [candidate(cfg.content, "STOP", u.imageOutputTokens > 0)],
    usageMetadata: toUsageMetadata(u),
    modelVersion: model,
  };
}

// Gemini 流式: streamGenerateContent 默认返回 SSE(alt=sse) 或 JSON 数组。
// new-api 用 SSE(每块 "data: {json}")。最后一块含 usageMetadata。
export async function buildStream(cfg, messages, model, send, sleep) {
  const u = computeUsage(cfg, messages);
  const chunks = chunkText(cfg.content);
  for (let i = 0; i < chunks.length; i++) {
    if (cfg.chunkDelayMs > 0) await sleep(cfg.chunkDelayMs);
    const last = i === chunks.length - 1;
    const obj = { candidates: [candidate(chunks[i], last ? "STOP" : null, last && u.imageOutputTokens > 0)], modelVersion: model };
    if (last) obj.usageMetadata = toUsageMetadata(u);
    send(obj);
  }
}

export function buildError(cfg) {
  return { error: { code: Number(cfg.errorStatus), message: cfg.errorMessage, status: Number(cfg.errorStatus) >= 500 ? "UNAVAILABLE" : "INVALID_ARGUMENT" } };
}

export const meta = { sse: true, usageField: "usageMetadata" };
export { countTextTokens };
