// testRunner.test.js —— bun test: 压测核心逻辑(resolveTarget / buildRequestBody / runBurstTest)。
import { test, expect } from "bun:test";
import { resolveTarget, buildRequestBody, runBurstTest } from "./testRunner.js";

const STATE = {
  port: 8788,
  models: [
    { id: "grok-4.5", vendor: "grok", format: "openai" },
    { id: "claude-opus-4-8", vendor: "claude", format: "claude" },
    { id: "gemini-2.5-pro", vendor: "gemini", format: "gemini" },
  ],
  channels: [
    { id: "primary", name: "主渠道", port: 8789, enabled: 1 },
    { id: "backup", name: "备用渠道", port: 8790, enabled: 1 },
  ],
};

test("resolveTarget: 不指定渠道 -> 主端口 + 模型自己的协议格式", () => {
  const r = resolveTarget(STATE, { modelId: "grok-4.5", channelId: null });
  expect(r).toEqual({ format: "openai", port: 8788 });
});

test("resolveTarget: 指定已有渠道 -> 该渠道的端口", () => {
  const r = resolveTarget(STATE, { modelId: "claude-opus-4-8", channelId: "backup" });
  expect(r).toEqual({ format: "claude", port: 8790 });
});

test("resolveTarget: gemini 模型解析出 gemini 协议", () => {
  const r = resolveTarget(STATE, { modelId: "gemini-2.5-pro", channelId: "primary" });
  expect(r).toEqual({ format: "gemini", port: 8789 });
});

test("resolveTarget: 未知 modelId 抛错", () => {
  expect(() => resolveTarget(STATE, { modelId: "no-such-model", channelId: null }))
    .toThrow(/未知模型/);
});

test("resolveTarget: 未知 channelId 抛错(不静默回退主端口)", () => {
  expect(() => resolveTarget(STATE, { modelId: "grok-4.5", channelId: "no-such-channel" }))
    .toThrow(/未知渠道/);
});

test("resolveTarget: channelId 传空字符串等同不指定渠道 -> 主端口", () => {
  const r = resolveTarget(STATE, { modelId: "grok-4.5", channelId: "" });
  expect(r).toEqual({ format: "openai", port: 8788 });
});

test("buildRequestBody: openai 协议拼出 /v1/chat/completions", () => {
  const { path, body } = buildRequestBody("openai", "grok-4.5", "hi", false);
  expect(path).toBe("/v1/chat/completions");
  expect(body).toEqual({ model: "grok-4.5", messages: [{ role: "user", content: "hi" }], stream: false });
});

test("buildRequestBody: claude 协议拼出 /v1/messages", () => {
  const { path, body } = buildRequestBody("claude", "claude-opus-4-8", "hi", true);
  expect(path).toBe("/v1/messages");
  expect(body).toEqual({ model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }], stream: true });
});

test("buildRequestBody: gemini 协议非流式 -> generateContent，stream 体现在 URL 不在 body", () => {
  const { path, body } = buildRequestBody("gemini", "gemini-2.5-pro", "hi", false);
  expect(path).toBe("/v1beta/models/gemini-2.5-pro:generateContent");
  expect(body).toEqual({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
});

test("buildRequestBody: gemini 协议流式 -> streamGenerateContent", () => {
  const { path } = buildRequestBody("gemini", "gemini-2.5-pro", "hi", true);
  expect(path).toBe("/v1beta/models/gemini-2.5-pro:streamGenerateContent");
});

test("buildRequestBody: prompt 未提供时默认「压测测试」", () => {
  const { body } = buildRequestBody("openai", "grok-4.5", undefined, false);
  expect(body.messages[0].content).toBe("压测测试");
});

test("buildRequestBody: 未知协议抛错", () => {
  expect(() => buildRequestBody("unknown-fmt", "m", "hi", false)).toThrow(/未知协议/);
});

test("runBurstTest: 全部成功时 summary 统计正确", async () => {
  const srv = Bun.serve({
    port: 0,
    fetch() {
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    },
  });
  try {
    const events = [];
    const { summary, requests } = await runBurstTest(
      { baseUrl: `http://localhost:${srv.port}`, format: "openai", model: "m", token: "sk-mock", prompt: "hi", stream: false, count: 10, concurrency: 3 },
      (e) => events.push(e)
    );
    expect(summary.total).toBe(10);
    expect(summary.success).toBe(10);
    expect(summary.fail).toBe(0);
    expect(summary.byStatus["200"]).toBe(10);
    expect(requests.length).toBe(10);
    expect(events.filter((e) => e.type === "progress").length).toBe(10);
    expect(events.at(-1).type).toBe("done");
  } finally {
    srv.stop();
  }
});

test("runBurstTest: 按状态码分组统计成功/失败", async () => {
  let n = 0;
  const srv = Bun.serve({
    port: 0,
    fetch() {
      n++;
      // 前 6 条成功, 后 4 条 503
      return n <= 6
        ? new Response(JSON.stringify({ ok: true }))
        : new Response(JSON.stringify({ error: "mock" }), { status: 503 });
    },
  });
  try {
    const { summary } = await runBurstTest(
      { baseUrl: `http://localhost:${srv.port}`, format: "openai", model: "m", token: "", prompt: "hi", stream: false, count: 10, concurrency: 5 },
      () => {}
    );
    expect(summary.total).toBe(10);
    expect(summary.success).toBe(6);
    expect(summary.fail).toBe(4);
    expect(summary.byStatus["200"]).toBe(6);
    expect(summary.byStatus["503"]).toBe(4);
    // 延迟分布只统计成功的
    expect(summary.latency.min).toBeGreaterThanOrEqual(0);
  } finally {
    srv.stop();
  }
});

test("runBurstTest: 并发数确实生效(同时在途请求数不超过 concurrency)", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const srv = Bun.serve({
    port: 0,
    async fetch() {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return new Response(JSON.stringify({ ok: true }));
    },
  });
  try {
    await runBurstTest(
      { baseUrl: `http://localhost:${srv.port}`, format: "openai", model: "m", token: "", prompt: "hi", stream: false, count: 12, concurrency: 3 },
      () => {}
    );
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1); // 确实并发了, 不是退化成串行
  } finally {
    srv.stop();
  }
});

test("runBurstTest: 网络层异常(连不上)记为 fail, status=network_error, 不中断整批", async () => {
  const { summary } = await runBurstTest(
    { baseUrl: "http://127.0.0.1:1", format: "openai", model: "m", token: "", prompt: "hi", stream: false, count: 3, concurrency: 2 },
    () => {}
  );
  expect(summary.total).toBe(3);
  expect(summary.fail).toBe(3);
  expect(summary.byStatus["network_error"]).toBe(3);
});

test("runBurstTest: Authorization 头正确带上, token 为空时不带该头", async () => {
  let seenAuth;
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      seenAuth = req.headers.get("authorization");
      return new Response(JSON.stringify({ ok: true }));
    },
  });
  try {
    await runBurstTest(
      { baseUrl: `http://localhost:${srv.port}`, format: "openai", model: "m", token: "sk-abc", prompt: "hi", stream: false, count: 1, concurrency: 1 },
      () => {}
    );
    expect(seenAuth).toBe("Bearer sk-abc");

    await runBurstTest(
      { baseUrl: `http://localhost:${srv.port}`, format: "openai", model: "m", token: "", prompt: "hi", stream: false, count: 1, concurrency: 1 },
      () => {}
    );
    expect(seenAuth).toBeNull();
  } finally {
    srv.stop();
  }
});
