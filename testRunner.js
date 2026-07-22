// testRunner.js —— 压测核心逻辑：目标解析 + 请求体拼装 + 并发执行。
// 不 import store.js —— 只认调用方传进来的 state({models,channels}) 和 baseUrl，
// 因此同一份逻辑能同时服务"本机面板"(server.js 直读 store)和"CLI --host 远程压测"(GET /__state 拿到的 JSON)。

// 从 (modelId, channelId) 算出该打哪个协议、哪个端口。
// channelId 为空/null/"" -> 主端口(state.port，缺省兜底 8788)；
// channelId 指定但在 state.channels 里找不到 -> 抛错，不静默回退主端口(避免测错目标却不自知)。
export function resolveTarget(state, { modelId, channelId }) {
  const model = (state.models || []).find((m) => m.id === modelId);
  if (!model) throw new Error(`未知模型: ${modelId}`);

  if (!channelId) {
    return { format: model.format, port: state.port || 8788 };
  }
  const channel = (state.channels || []).find((c) => c.id === channelId);
  if (!channel) throw new Error(`未知渠道: ${channelId}`);
  return { format: model.format, port: channel.port };
}

const DEFAULT_PROMPT = "压测测试";

// 按协议拼出相对路径 + body。三种协议的形状分别对齐 formats/openai.js、formats/claude.js、
// formats/gemini.js 里各自 parseRequest() 的解析逻辑(反过来拼一份能被它们正确解析的请求)。
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
// 非流式：等 res.json() 记完整延迟。
// 流式：读到第一个 chunk 就记"首包延迟"，随后把剩余流读完丢弃(避免连接残留)。
async function runOne({ baseUrl, format, model, token, prompt, stream, index }) {
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
      await reader.read(); // 首包
      const latencyMs = Math.round(performance.now() - start);
      // 读完剩余流丢弃, 不阻塞在这里等首包之后的计时
      (async () => { try { while (!(await reader.read()).done) {} } catch {} })();
      return { index, ok: res.ok, status: String(res.status), latencyMs };
    }

    await res.json().catch(() => null);
    const latencyMs = Math.round(performance.now() - start);
    return { index, ok: res.ok, status: String(res.status), latencyMs };
  } catch (e) {
    const latencyMs = Math.round(performance.now() - start);
    const status = e.name === "AbortError" ? "timeout" : "network_error";
    return { index, ok: false, status, latencyMs };
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

// 并发 worker pool: 共享游标 + concurrency 个并行 worker 循环取号，直到发完 count 条。
// 每条完成立即 onEvent(progress)，是真实完成速度，不是伪进度条。
export async function runBurstTest(opts, onEvent) {
  const { baseUrl, format, model, token, prompt, stream, count, concurrency } = opts;
  const requests = new Array(count);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= count) return;
      const result = await runOne({ baseUrl, format, model, token, prompt, stream, index: i });
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
