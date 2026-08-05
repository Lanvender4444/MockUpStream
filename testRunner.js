// testRunner.js —— 通用 API 测试：向指定 endpoint（如 new-api）发送一批 OpenAI 兼容请求，统计成功率与延迟。
// 不关心上游内部怎么调度，只测端到端——这正是 new-api API Key 自动调度场景下的真实效果。

const DEFAULT_PROMPT = "测试";

// 拼出相对路径 + body。三种协议，对齐 formats/*/parseRequest() 的解析逻辑。
export function buildRequestBody(format, model, prompt, stream) {
  const text = prompt || DEFAULT_PROMPT;
  if (format === "openai") {
    return {
      path: "/v1/chat/completions",
      body: { model, messages: [{ role: "user", content: text }], stream: !!stream },
    };
  }
  if (format === "claude") {
    return {
      path: "/v1/messages",
      body: { model, messages: [{ role: "user", content: text }], stream: !!stream },
    };
  }
  if (format === "gemini") {
    const action = stream ? "streamGenerateContent" : "generateContent";
    return {
      path: `/v1beta/models/${encodeURIComponent(model)}:${action}`,
      body: { contents: [{ role: "user", parts: [{ text }] }] },
    };
  }
  throw new Error(`未知协议: ${format}`);
}

const REQUEST_TIMEOUT_MS = 30000;

// 单条请求：拼 URL、发 fetch、记时、判定成功/失败。
// 非流式：等 res.text() 记完整延迟(text() 而不是 json()，因为不管 captureBody 是否打开都要先把 body 读完；
//         captureBody=false 时读了也不用，但读一次是为了让连接正常关闭，不留半读的连接)。
// 流式：读到第一个 chunk 就记"首包延迟"；captureBody=false 时读完剩余流丢弃(省内存)；
//       captureBody=true 时把所有 chunk 解码拼接成完整原始 SSE 文本存进 result.body，
//       此时会等流真正读完才返回(单次模式本来就该等完整内容，不是批量模式的"越快越好")。
async function runSingleRequest({ baseUrl, format, model, token, prompt, stream, index, captureBody, channel, clientAbort, disconnectAfterChunks }) {
  const { path, body } = buildRequestBody(format, model, prompt, stream);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const start = performance.now();
  try {
    const res = await fetch(baseUrl + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (stream && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const first = await reader.read(); // 首包
      const latencyMs = Math.round(performance.now() - start);
      const result = { index, ok: res.ok, status: String(res.status), latencyMs, channel };

      // 下游断开模拟：收到首包(及少量后续帧)后，主动掐断到 new-api 的连接，
      // 让 new-api 侧看到"客户端断开" → client_gone。这里是"故意"的断开，故 ok=false、status=client_abort。
      if (clientAbort) {
        let readCount = first.done ? 0 : 1;
        const need = Math.max(1, Number(disconnectAfterChunks) || 2);
        try {
          while (readCount < need) {
            const chunk = await reader.read();
            if (chunk.done) break;
            readCount++;
          }
        } catch {}
        try { await reader.cancel(); } catch {}
        controller.abort();
        return { ...result, ok: false, status: "client_abort" };
      }

      if (captureBody) {
        let text = first.value ? decoder.decode(first.value, { stream: true }) : "";
        try {
          let chunk;
          while (!(chunk = await reader.read()).done) {
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
        } catch {}
        result.body = text;
        return result;
      }

      // 不需要保留内容: 读完剩余流丢弃, 不阻塞在这里等首包之后的计时
      (async () => { try { while (!(await reader.read()).done) {} } catch {} })();
      return result;
    }

    const text = await res.text();
    const latencyMs = Math.round(performance.now() - start);
    const result = { index, ok: res.ok, status: String(res.status), latencyMs, channel };
    if (captureBody) result.body = text;
    return result;
  } catch (e) {
    const latencyMs = Math.round(performance.now() - start);
    const status = e.name === "AbortError" ? "timeout" : "network_error";
    return { index, ok: false, status, latencyMs, channel };
  } finally {
    clearTimeout(timer);
  }
}

function summarize(requests) {
  const total = requests.length;
  const success = requests.filter((r) => r.ok).length;
  const fail = total - success;
  const byStatus = {};
  for (const r of requests) byStatus[r.status] = (byStatus[r.status] || 0) + 1;

  const okLatencies = requests.filter((r) => r.ok).map((r) => r.latencyMs).sort((a, b) => a - b);
  let latency = { min: 0, avg: 0, max: 0, p95: 0 };
  if (okLatencies.length) {
    const sum = okLatencies.reduce((a, b) => a + b, 0);
    const p95Index = Math.min(okLatencies.length - 1, Math.ceil(okLatencies.length * 0.95) - 1);
    latency = {
      min: okLatencies[0],
      avg: Math.round(sum / okLatencies.length),
      max: okLatencies.at(-1),
      p95: okLatencies[p95Index],
    };
  }
  return { total, success, fail, byStatus, latency };
}

// 并发 worker pool，向指定 endpoint 发 count 条请求。
// 每条完成立即 onEvent(progress)，是真实完成速度。
export async function runTest(opts, onEvent) {
  const { baseUrl, format, model, token, prompt, stream, count, concurrency, captureBody, channel, clientAbort, disconnectAfterChunks } = opts;
  const requests = new Array(count);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= count) return;
      const result = await runSingleRequest({ baseUrl, format, model, token, prompt, stream, index: i, captureBody, channel, clientAbort, disconnectAfterChunks });
      requests[i] = result;
      onEvent({ type: "progress", ...result });
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, count) }, () => worker());
  await Promise.all(workers);

  const summary = summarize(requests);
  onEvent({ type: "done", summary });
  return { summary, requests };
}
