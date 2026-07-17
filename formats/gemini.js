// formats/gemini.js —— Gemini 格式: /v1beta/models/{model}:generateContent 与 :streamGenerateContent
import { computeUsage, countTextTokens } from "../usage.js";

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
  return meta;
}

function candidate(text, finish) {
  return {
    content: { role: "model", parts: [{ text }] },
    finishReason: finish || null,
    index: 0,
  };
}

export function buildResponse(cfg, messages, model) {
  const u = computeUsage(cfg, messages);
  return {
    candidates: [candidate(cfg.content, "STOP")],
    usageMetadata: toUsageMetadata(u),
    modelVersion: model,
  };
}

// Gemini 流式: streamGenerateContent 默认返回 SSE(alt=sse) 或 JSON 数组。
// new-api 用 SSE(每块 "data: {json}")。最后一块含 usageMetadata。
export async function buildStream(cfg, messages, model, send, sleep) {
  const u = computeUsage(cfg, messages);
  const chunks = cfg.content.match(/.{1,8}/gs) || [cfg.content];
  for (let i = 0; i < chunks.length; i++) {
    if (cfg.chunkDelayMs > 0) await sleep(cfg.chunkDelayMs);
    const last = i === chunks.length - 1;
    const obj = { candidates: [candidate(chunks[i], last ? "STOP" : null)], modelVersion: model };
    if (last) obj.usageMetadata = toUsageMetadata(u);
    send(obj);
  }
}

export function buildError(cfg) {
  return { error: { code: Number(cfg.errorStatus), message: cfg.errorMessage, status: "MOCK_ERROR" } };
}

export const meta = { sse: true, usageField: "usageMetadata" };
export { countTextTokens };
