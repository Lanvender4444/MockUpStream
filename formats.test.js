// formats.test.js —— bun test: 校验三种格式的 usage 映射与流式末块含 usage。
import { test, expect } from "bun:test";
import { computeUsage } from "./usage.js";
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
