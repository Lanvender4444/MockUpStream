# MockStream

> 目标：**前后端一起跑，测这个网关的完整功能（鉴权 / 渠道 / 计费 / 配额 / 日志 / 流式），但不需要任何真实厂商 API key。**
>
> **不用真实 API，用 Mock 上游测试 new-api 全链路**

---

## QuickStart 快速开始

### 1. 需要的准备

本目录提供一个现成的 mock 上游：**`mock-upstream.js`**（OpenAI 兼容，支持流式/非流式，回传 `cached_tokens` 便于测缓存计费）。

依赖：已安装 **bun**（前端本来就用它）、**Go**（跑后端）。



### 2a. 若 原始项目启动在 Docker

1. **宿主机起 mock**（`0.0.0.0` 监听已默认）：

   ```bash
   cd ./MockStream
   bun run mock-upstream.js        # 8788
   ```

2. **渠道 Base URL 填** → `http://host.docker.internal:8788`
   （Windows/Mac 的 Docker Desktop 内置这个 DNS 指向宿主机）

3. Linux 或该 DNS 不通时，给 compose 的 `new-api` 服务加一行后重建：

   ```yaml
     new-api:
       build: .
       extra_hosts:
         - "host.docker.internal:host-gateway"   # ← 加这行
   ```

4. **先验证容器能不能打到 mock**（强烈建议，省排查时间）：

   ```bash
   docker exec -it new-api sh -c "wget -qO- http://host.docker.internal:8788/v1/models"
   ```

   返回模型列表 JSON 即通。



### 2b. 若 原始项目没有启动在 Docker

#### ① 起 MockStream 上游

```bash
cd D:/MockStream
bun run mock-upstream.js          # 监听 8788
# 自定义端口： MOCK_PORT=9999 bun run mock-upstream.js
```

看到 `mock upstream listening on http://localhost:8788` 即成功。

#### ② 起 new-api 后端

```bash
cd D:/new-api # 此处为真实 new-api
go run main.go                    # 或先 go build -o new-api.exe main.go 再 ./new-api.exe
```

- 默认监听 `:3000`，SQLite 自动建库到 `./data/new-api.db`，**无需 Docker/MySQL/Redis**。
- **首次编译很慢**（依赖树巨大，Windows 上受 Defender 影响可能数分钟），终端空白是在编译不是卡死。可 `go build -v` 看进度。
- 首启日志里会打印默认管理员 `root` 的随机密码，记下来。

#### ③ 起前端（想连界面点就起）

```bash
cd D:/new-api/web # 此处为真实 new-api
bun install
bun run dev                       # Vite dev server，通常 5173，带热更新
# 或打包给后端内嵌： DISABLE_ESLINT_PLUGIN='true' VITE_REACT_APP_VERSION=$(cat ../VERSION) bun run build
```



### 3. 后台配置

浏览器打开前端 → 用 `root` + 首启密码登录：

**1. 建渠道（Channels）**

- 类型：**OpenAI**
- **代理 / Base URL：`http://localhost:8788`** ← 指向 mock
- 密钥：随便填，如 `sk-mock`
- 模型：`gpt-3.5-turbo,gpt-4o`
- 保存后可点「测试」按钮（mock 的 `/v1/models` 会响应）

**2. 配模型倍率（Model Ratio / 运营设置）**

- 确保 `gpt-3.5-turbo` 配了 `modelRatio` / `completionRatio` / `cacheRatio`
- 否则会报「模型倍率或价格未配置」（`relay/helper/price.go:78`）

**3. 建令牌（Tokens）**

- 新建 → 复制出 `sk-xxx`  

**4. 修改 TierGroups**

系统设置 → 倍率设置 修改TierGroups

```json
{
  "dev": {"groups": ["default"]},
  "pro": {"groups": ["default", "vip"]},
  "ent": {"groups": ["default", "vip", "svip"]}
}
```



### 4. 打请求验证全链路

**非流式：**

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-dev-iv8XQ3z6SbmKz9SmCdqjbFqhm4ZsfjUitexF20hggttlh4PG" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-3.5-turbo","messages":[{"role":"user","content":"测试"}]}'
```

**流式：**

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-你的令牌" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-3.5-turbo","stream":true,"stream_options":{"include_usage":true},"messages":[{"role":"user","content":"测试"}]}'
```

然后到前端看 **日志 (Logs)** 与 **用户配额**：会看到配额被扣、日志记录了 prompt/completion/cached token、倍率、消费额度。**整条流真实，只有 LLM 输出是假的。**





---





## 其他问题



### 原理

new-api 本质是个代理：

```
浏览器/客户端 ──▶ new-api（真实全流程）──▶ 上游厂商（OpenAI/Claude/...）
                     ↑                            ↑
        鉴权/配额预扣/渠道选择/格式转换/            只有这一步是真实 LLM
        SSE 流式/日志/结算 —— 全部真实
```

只要把**渠道的 Base URL** 指向一个你自己控制的**假上游**（mock），中间所有真实逻辑都会跑到，唯独真实 LLM 调用被替换成假响应。

**为什么可行（代码依据）：**
- 渠道模型有可配的 `BaseURL` 字段：`model/channel.go:34`、`GetBaseURL()` @ `model/channel.go:487`。
- OpenAI adaptor 用 `info.ChannelBaseUrl` 拼上游地址，且**支持 `http://`**（本地 mock 可用）：`relay/channel/openai/adaptor.go:95-104`。
- 请求路径拼成 `<你的BaseURL>/v1/chat/completions`。



### 能测到什么

| 功能 | 覆盖情况 |
|---|---|
| 鉴权、令牌校验、配额预扣/结算 | ✅ 真实 |
| 渠道选择、负载均衡、失败重试 | ✅ 真实（建多个 mock 渠道测）|
| 计费（含缓存命中，mock 回传 cached_tokens）| ✅ 真实 |
| 日志、消费记录、前端展示 | ✅ 真实 |
| SSE 流式转换 | ✅ 真实（mock 支持 stream）|
| 格式转换 OpenAI↔Claude/Gemini | ✅ 建对应类型渠道指向 mock |



### 三种测试粒度对比

| 方式 | 用途 | 要真 key |
|---|---|---|
| `go test ./relay/helper/` | 只验计费公式，秒级 | 否 |
| **mock 上游 + 全栈起（本教程）** | **前后端 + 全链路功能** | **否** |
| 真实渠道 | 验证真实厂商兼容性 | 是 |

「前后端一起测但没真 API」→ 用中间这行。



### 常见问题

- **报「倍率未配置」**：去运营设置给该模型配 modelRatio 等。
- **报 `distributor: tier X has no available groups for model ...`（最坑）**：
  **渠道分组和令牌分组对不上**。new-api 里两者独立配置、交集匹配，UI 无联动校验，建的时候不报错、请求时才炸。
  规则：**令牌的分组必须能被某条「提供该模型」的渠道的分组覆盖**。
  最省心：建渠道时「分组」字段把会用到的分组（`default` / `dev` / `vip`…）**一次全勾上**。
  排查顺序：① 渠道「分组」是否含令牌所在分组 → ② 渠道「模型」是否含该模型且拼写一致 → ③ 渠道是否启用。
- **请求 401/无权限**：令牌没带对，或该令牌没勾选允许的模型/分组。
- **流式没拿到 usage**：请求要带 `stream_options.include_usage:true`；mock 本身总会发 usage 块。
- **渠道测试按钮失败**：确认 mock 在跑、Base URL 没写成 `https`、端口对得上。
