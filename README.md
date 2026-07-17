# Mock 上游（多模型 · 三格式 · 带控制台）

不用真实 API key，给 new-api 提供一个可视化控制的假上游：**多模型档案 + 场景预设 + OpenAI/Claude/Gemini 三种协议 + 文件持久化**。

```
浏览器/客户端 ──▶ new-api（真实全流程）──▶ 本 mock（你在网页上控制输出）
                     鉴权/配额/计费/日志/流式 全真     只有 LLM 输出是假的
```

---

## 一键启动

> 端口默认 **8788**，控制台 `http://localhost:8788/`。首次启动自动生成 `config.json`（含 3 个示例模型 + 4 个预设）。
> 下面所有命令都**在本项目根目录（MockUpStream/）里执行**，用相对路径，拉到哪儿都能跑。

### 情况 A：本地直接跑（宿主机装了 bun）

**任意平台**（在项目根目录）
```bash
bun run server.js
```

自定义端口：
- Bash / macOS / Linux：`MOCK_PORT=9999 bun run server.js`
- PowerShell：`$env:MOCK_PORT=9999; bun run server.js`
- CMD：`set MOCK_PORT=9999 && bun run server.js`

→ new-api 渠道 Base URL 填 `http://localhost:8788`。

### 情况 B：用 Docker 跑（无需本机装 bun）

**自带 compose（最简单）**——本项目根目录已含 `docker-compose.yml`：
```bash
docker compose up
```

**或一条 docker run**（把当前目录挂进容器）：
- Git Bash / macOS / Linux：
  ```bash
  docker run --rm -it -p 8788:8788 -v "$PWD":/app -w /app oven/bun:latest bun run server.js
  ```
- PowerShell：
  ```powershell
  docker run --rm -it -p 8788:8788 -v ${PWD}:/app -w /app oven/bun:latest bun run server.js
  ```
- CMD：
  ```bat
  docker run --rm -it -p 8788:8788 -v %cd%:/app -w /app oven/bun:latest bun run server.js
  ```

→ 若 new-api 也在容器里，渠道 Base URL 填 **`http://host.docker.internal:8788`**（Docker Desktop 内置该 DNS）；若把本项目并入 new-api 的 compose 网络，则用服务名 `http://mock-upstream:8788`。

---

## 控制台用法

打开 `http://localhost:8788/`：

- **左栏 模型列表**：新建 / 复制 / 删除；点一行进入编辑；进页面自动选中第一个。
- **右栏 编辑器**：改模型名、协议格式、回复内容、输入/输出/缓存 token、延迟、流式块间隔、注入错误码+概率。改完点**保存**（整表 upsert）。
- **预设按钮**（正常基准 / 高缓存命中 / 超长上下文 / 错误超时）：点一下**一次性填满整表**，仍需点保存写入。
- **Base URL / endpoint 提示**：直接复制到 new-api 渠道；Docker 下把 `localhost` 换成 `host.docker.internal`。
- **最近请求**：实时表格，看每次调用的模型/格式/流/token/错误。

配置写入 `config.json`，重启不丢。

---

## 三种协议 / endpoint

| 格式 | new-api 渠道类型 | endpoint | usage 语义 |
|---|---|---|---|
| openai | OpenAI（含 grok/deepseek/qwen/kimi 等兼容） | `POST /v1/chat/completions` | `prompt_tokens / completion_tokens / prompt_tokens_details.cached_tokens` |
| claude | Anthropic / Claude | `POST /v1/messages` | `input_tokens(=prompt−cached−creation) / output_tokens / cache_read_input_tokens / cache_creation_input_tokens` |
| gemini | Gemini | `POST /v1beta/models/{model}:generateContent`（流式 `:streamGenerateContent`） | `usageMetadata.promptTokenCount / candidatesTokenCount / cachedContentTokenCount` |

> **响应格式由请求打到哪个 endpoint 决定**，不是看模型的 format 字段。format 字段只影响面板分组和 `/v1/models` 列表。

---

## 目录结构

```
MockUpStream/
├── server.js            # 入口 + 路由分发
├── store.js             # config.json 读写 / 模型·预设增删改
├── presets.js           # 4 个内置场景预设
├── usage.js             # 格式无关的 token 计算
├── formats/
│   ├── openai.js
│   ├── claude.js
│   └── gemini.js
├── vendor/alpine.min.js # 本地 Alpine（无联网依赖）
├── panel.html           # 控制台
├── docker-compose.yml   # 独立 Docker 运行（相对挂载）
├── config.json          # 持久化（自动生成，可删除以重置）
└── formats.test.js      # bun test
```

跑测试：`bun test`

---

## 快速自测（不经 new-api，直接打 mock）

```bash
# OpenAI
curl -s http://localhost:8788/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"grok-4.5","messages":[{"role":"user","content":"hi"}]}'
# Claude
curl -s http://localhost:8788/v1/messages -H 'Content-Type: application/json' \
  -d '{"model":"claude-opus","messages":[{"role":"user","content":"hi"}]}'
# Gemini
curl -s "http://localhost:8788/v1beta/models/gemini-2.5-pro:generateContent" -H 'Content-Type: application/json' \
  -d '{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}'
```

---

## 常见问题

- **端口被占用（EADDRINUSE）**：`MOCK_PORT=9999 bun run server.js`，或杀掉占用 8788 的旧进程。
- **想重置全部配置**：删掉 `config.json` 重启即可。
- **Docker 下渠道连不上**：Base URL 别用 `localhost`，用 `host.docker.internal:8788` 或 compose 服务名 `mock-upstream:8788`。
- **命令行 curl 传中文预设名失败**：Windows 终端编码问题，与本工具无关；控制台网页（fetch UTF-8）和 new-api（发模型名）都正常。
- **new-api 侧分组 / Tier 路由报错**：那是 new-api 自身的渠道分组或 Tier 映射问题，与本 mock 无关（检查渠道分组是否覆盖令牌所属分组/Tier）。
