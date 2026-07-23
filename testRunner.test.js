// testRunner.test.js —— bun test: 通用 API 测试核心逻辑(buildRequestBody / runTest)。
import { test, expect } from "bun:test";
import { buildRequestBody, runTest } from "./testRunner.js";

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

test("buildRequestBody: gemini 协议非流式 -> generateContent", () => {
  const { path, body } = buildRequestBody("gemini", "gemini-2.5-pro", "hi", false);
  expect(path).toBe("/v1beta/models/gemini-2.5-pro:generateContent");
  expect(body).toEqual({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
});

test("buildRequestBody: gemini 协议流式 -> streamGenerateContent", () => {
  const { path } = buildRequestBody("gemini", "gemini-2.5-pro", "hi", true);
  expect(path).toBe("/v1beta/models/gemini-2.5-pro:streamGenerateContent");
});

test("buildRequestBody: prompt 未提供时默认「测试」", () => {
  const { body } = buildRequestBody("openai", "grok-4.5", undefined, false);
  expect(body.messages[0].content).toBe("测试");
});

test("buildRequestBody: 未知协议抛错", () => {
  expect(() => buildRequestBody("unknown-fmt", "m", "hi", false)).toThrow(/未知协议/);
});

test("runTest: 全部成功", async () => {
  let callCount = 0;
  const srv = Bun.serve({
    port: 0,
    fetch() {
      callCount++;
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    },
  });
  try {
    const events = [];
    const { summary, requests } = await runTest(
      { baseUrl: `http://127.0.0.1:${srv.port}`, format: "openai", model: "m", token: "sk-mock", prompt: "hi", stream: false, count: 10, concurrency: 3 },
      (e) => events.push(e)
    );
    expect(summary.total).toBe(10);
    expect(summary.success).toBe(10);
    expect(summary.fail).toBe(0);
    expect(requests.length).toBe(10);
    expect(events.filter((e) => e.type === "progress").length).toBe(10);
    expect(events.at(-1).type).toBe("done");
    expect(callCount).toBe(10);
  } finally {
    srv.stop();
  }
});

test("runTest: 按状态码分组统计成功/失败", async () => {
  let n = 0;
  const srv = Bun.serve({
    port: 0,
    fetch() {
      n++;
      return n <= 6
        ? new Response(JSON.stringify({ ok: true }))
        : new Response(JSON.stringify({ error: "mock" }), { status: 503 });
    },
  });
  try {
    const { summary } = await runTest(
      { baseUrl: `http://127.0.0.1:${srv.port}`, format: "openai", model: "m", token: "", prompt: "hi", stream: false, count: 10, concurrency: 5 },
      () => {}
    );
    expect(summary.total).toBe(10);
    expect(summary.success).toBe(6);
    expect(summary.fail).toBe(4);
    expect(summary.byStatus["200"]).toBe(6);
    expect(summary.byStatus["503"]).toBe(4);
    expect(summary.latency.min).toBeGreaterThanOrEqual(0);
  } finally {
    srv.stop();
  }
});

test("runTest: 并发数确实生效", async () => {
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
    await runTest(
      { baseUrl: `http://127.0.0.1:${srv.port}`, format: "openai", model: "m", token: "", prompt: "hi", stream: false, count: 12, concurrency: 3 },
      () => {}
    );
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1);
  } finally {
    srv.stop();
  }
});

test("runTest: 网络层异常记为 fail", async () => {
  const { summary } = await runTest(
    { baseUrl: "http://127.0.0.1:1", format: "openai", model: "m", token: "", prompt: "hi", stream: false, count: 3, concurrency: 2 },
    () => {}
  );
  expect(summary.total).toBe(3);
  expect(summary.fail).toBe(3);
  expect(summary.byStatus["network_error"]).toBe(3);
});

test("runTest: Authorization 头正确带上", async () => {
  let seenAuth;
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      seenAuth = req.headers.get("authorization");
      return new Response(JSON.stringify({ ok: true }));
    },
  });
  try {
    await runTest(
      { baseUrl: `http://127.0.0.1:${srv.port}`, format: "openai", model: "m", token: "sk-abc", prompt: "hi", stream: false, count: 1, concurrency: 1 },
      () => {}
    );
    expect(seenAuth).toBe("Bearer sk-abc");

    await runTest(
      { baseUrl: `http://127.0.0.1:${srv.port}`, format: "openai", model: "m", token: "", prompt: "hi", stream: false, count: 1, concurrency: 1 },
      () => {}
    );
    expect(seenAuth).toBeNull();
  } finally {
    srv.stop();
  }
});

test("runTest: captureBody 默认 false 时不保留响应体", async () => {
  const srv = Bun.serve({
    port: 0,
    fetch() { return new Response(JSON.stringify({ ok: true, hello: "world" })); },
  });
  try {
    const { requests } = await runTest(
      { baseUrl: `http://localhost:${srv.port}`, format: "openai", model: "m", token: "", prompt: "hi", stream: false, count: 1, concurrency: 1 },
      () => {}
    );
    expect(requests[0].body).toBeUndefined();
  } finally {
    srv.stop();
  }
});

test("runTest: captureBody=true 时非流式保留完整响应体原文", async () => {
  const srv = Bun.serve({
    port: 0,
    fetch() { return new Response(JSON.stringify({ ok: true, hello: "world" })); },
  });
  try {
    const { requests } = await runTest(
      { baseUrl: `http://localhost:${srv.port}`, format: "openai", model: "m", token: "", prompt: "hi", stream: false, count: 1, concurrency: 1, captureBody: true },
      () => {}
    );
    expect(requests[0].body).toBe(JSON.stringify({ ok: true, hello: "world" }));
  } finally {
    srv.stop();
  }
});

test("runTest: captureBody=true 时流式请求按到达顺序拼接完整原始 SSE 文本", async () => {
  const srv = Bun.serve({
    port: 0,
    fetch() {
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("data: chunk1\n\n"));
          controller.enqueue(encoder.encode("data: chunk2\n\n"));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  try {
    const { requests } = await runTest(
      { baseUrl: `http://localhost:${srv.port}`, format: "openai", model: "m", token: "", prompt: "hi", stream: true, count: 1, concurrency: 1, captureBody: true },
      () => {}
    );
    expect(requests[0].body).toBe("data: chunk1\n\ndata: chunk2\n\ndata: [DONE]\n\n");
  } finally {
    srv.stop();
  }
});
