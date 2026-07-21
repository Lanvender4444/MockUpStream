// formats.test.js —— bun test: 校验三种格式的 usage 映射与流式末块含 usage。
import { test, expect } from "bun:test";
import { computeUsage, chunkText, resolveLatencyMs } from "./usage.js";
import * as openai from "./formats/openai.js";
import * as claude from "./formats/claude.js";
import * as gemini from "./formats/gemini.js";

// 固定配置: 输入500(fixed), 输出77, 缓存命中200(fixed), 缓存写入50
const cfg = {
  content: "hello world mock",
  promptMode: "fixed", promptTokens: 500,
  completionTokens: 77,
  cacheMode: "fixed", cachedTokens: 200, cacheCreationTokens: 50,
  chunkDelayMs: 0,
};

test("computeUsage: fixed + fixed cache 夹取正确", () => {
  const u = computeUsage(cfg, []);
  expect(u.promptTokens).toBe(500);
  expect(u.completionTokens).toBe(77);
  expect(u.cacheCreationTokens).toBe(50);
  expect(u.cachedTokens).toBe(200);
});

test("computeUsage: cache 不超过输入", () => {
  const u = computeUsage({ promptMode: "fixed", promptTokens: 100, completionTokens: 0, cacheMode: "fixed", cachedTokens: 999, cacheCreationTokens: 0 }, []);
  expect(u.cachedTokens).toBe(100);
});

test("openai: usage 字段映射", () => {
  const r = openai.buildResponse(cfg, [], "gpt-x");
  expect(r.usage.prompt_tokens).toBe(500);
  expect(r.usage.completion_tokens).toBe(77);
  expect(r.usage.total_tokens).toBe(577);
  expect(r.usage.prompt_tokens_details.cached_tokens).toBe(200);
});

test("claude: input_tokens = prompt - cached - creation", () => {
  const r = claude.buildResponse(cfg, [], "claude-x");
  expect(r.usage.input_tokens).toBe(500 - 200 - 50); // 250
  expect(r.usage.output_tokens).toBe(77);
  expect(r.usage.cache_read_input_tokens).toBe(200);
  expect(r.usage.cache_creation_input_tokens).toBe(50);
});

test("gemini: usageMetadata 映射", () => {
  const r = gemini.buildResponse(cfg, [], "gemini-x");
  expect(r.usageMetadata.promptTokenCount).toBe(500);
  expect(r.usageMetadata.candidatesTokenCount).toBe(77);
  expect(r.usageMetadata.totalTokenCount).toBe(577);
  expect(r.usageMetadata.cachedContentTokenCount).toBe(200);
});

async function collectStream(fmt, named) {
  const events = [];
  const send = named
    ? (event, data) => events.push({ event, data })
    : (obj) => events.push(obj);
  await fmt.buildStream(cfg, [], "m", send, async () => {});
  return events;
}

test("openai 流式: 末尾有 usage 块 + [DONE]", async () => {
  const ev = await collectStream(openai, false);
  expect(ev.at(-1)).toBe("[DONE]");
  const usageChunk = ev.find((e) => e && e.usage);
  expect(usageChunk.usage.prompt_tokens).toBe(500);
});

test("claude 流式: message_delta 带 output_tokens, message_start 带 input_tokens", async () => {
  const ev = await collectStream(claude, true);
  const start = ev.find((e) => e.event === "message_start");
  expect(start.data.message.usage.input_tokens).toBe(250);
  const delta = ev.find((e) => e.event === "message_delta");
  expect(delta.data.usage.output_tokens).toBe(77);
  expect(ev.at(-1).event).toBe("message_stop");
});

test("gemini 流式: 末块含 usageMetadata", async () => {
  const ev = await collectStream(gemini, false);
  expect(ev.at(-1).usageMetadata.promptTokenCount).toBe(500);
  expect(ev.at(-1).candidates[0].finishReason).toBe("STOP");
});

test("parseRequest: gemini 从 path 解析 model 与 stream", () => {
  const url = new URL("http://x/v1beta/models/gemini-2.5-pro:streamGenerateContent");
  const p = gemini.parseRequest({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }, url);
  expect(p.model).toBe("gemini-2.5-pro");
  expect(p.stream).toBe(true);
});

test("buildOutputText 已移除: content 原样返回, 不被 completionTokens 截断", () => {
  const long = "这是一段很长的自定义回复".repeat(50); // 用户写的长正文
  const cfg = { content: long, completionTokens: 30, promptMode: "fixed", promptTokens: 10, cacheMode: "none" };
  const r = openai.buildResponse(cfg, [], "m");
  expect(r.choices[0].message.content).toBe(long);       // 原样, 不截断
  expect(r.usage.completion_tokens).toBe(30);            // 计费数独立
});

test("claude / gemini 也原样返回 content", () => {
  const long = "reply".repeat(100);
  const cfg = { content: long, completionTokens: 5, cacheMode: "none", promptMode: "fixed", promptTokens: 1 };
  expect(claude.buildResponse(cfg, [], "m").content[0].text).toBe(long);
  expect(gemini.buildResponse(cfg, [], "m").candidates[0].content.parts[0].text).toBe(long);
});

test("chunkText: 超长文本被限制在 <=120 块且无丢失", () => {
  const text = "a".repeat(4_000_000);
  const chunks = chunkText(text);
  expect(chunks.length).toBeLessThanOrEqual(120);
  expect(chunks.join("")).toBe(text);
});

test("resolveLatencyMs: fixed 模式直接用 latencyMs", () => {
  expect(resolveLatencyMs({ latencyMode: "fixed", latencyMs: 500 })).toBe(500);
  expect(resolveLatencyMs({ latencyMode: "fixed", latencyMs: -5 })).toBe(0); // 不允许负数
});

test("resolveLatencyMs: range + uniform 落在 [min,max] 区间内", () => {
  for (let i = 0; i < 200; i++) {
    const v = resolveLatencyMs({ latencyMode: "range", latencyDist: "uniform", latencyMin: 100, latencyMax: 300 });
    expect(v).toBeGreaterThanOrEqual(100);
    expect(v).toBeLessThanOrEqual(300);
  }
});

test("resolveLatencyMs: range + uniform 用固定 rand() 能精确算出取值", () => {
  const v = resolveLatencyMs({ latencyMode: "range", latencyDist: "uniform", latencyMin: 100, latencyMax: 300 }, () => 0.5);
  expect(v).toBe(200); // 100 + 0.5*(300-100)
});

test("resolveLatencyMs: range + normal 也夹在 [min,max] 区间内(哪怕 rand 落在极端值)", () => {
  const cfg = { latencyMode: "range", latencyDist: "normal", latencyMin: 1000, latencyMax: 5000 };
  // Box-Muller 用到的 u 接近 0 会产生很大的正态值, 验证最终还是被夹住
  const extreme = resolveLatencyMs(cfg, () => 1e-6);
  expect(extreme).toBeGreaterThanOrEqual(1000);
  expect(extreme).toBeLessThanOrEqual(5000);
  for (let i = 0; i < 200; i++) {
    const v = resolveLatencyMs(cfg, Math.random);
    expect(v).toBeGreaterThanOrEqual(1000);
    expect(v).toBeLessThanOrEqual(5000);
  }
});

test("resolveLatencyMs: max<=min 时直接返回 min, 不报错", () => {
  expect(resolveLatencyMs({ latencyMode: "range", latencyMin: 500, latencyMax: 100 })).toBe(500);
  expect(resolveLatencyMs({ latencyMode: "range", latencyMin: 500, latencyMax: 500 })).toBe(500);
});
