# Seedance / 火山方舟视频生成任务响应格式核对

检索日期：2026-08-11（Asia/Singapore）  
范围：火山方舟 `api/v3/contents/generations/tasks` 异步内容生成接口，以及当前 New-API Doubao task adaptor 的实际解析行为。

## 结论

1. 提交任务的官方响应最小且标准的形态就是 `{"id":"cgt-..."}`。火山方舟公开 API 文档只声明 `id`；官方 Go SDK 还预留了可选的 `safety_identifier`，但 New-API 当前只反序列化 `id`。
2. 查询任务的火山原生状态枚举是 `queued`、`running`、`succeeded`、`failed`、`cancelled`，没有 `pending` 或 `processing`。后两者只是 New-API 为兼容其它上游接受的别名。
3. 成功响应的关键结果位于 `content.video_url`，用量位于 `usage.completion_tokens` / `usage.total_tokens`；任务失败时是顶层 `error: {code,message}`，官方失败示例省略了 `content` 和 `usage`。
4. `framespersecond` 确实是不带下划线的全小写字段；官方文档、官方 Go SDK 和 New-API 三方一致。
5. 当前 New-API 只有在 `succeeded` 分支读取 `content.video_url` 和两个 token 字段；只有在 `failed` 分支读取 `error.message`。因此 Mock 的结算测试必须最终返回 `succeeded`。

## 一手来源

- [火山方舟：创建视频生成任务 API](https://api.volcengine.com/api-docs/view?action=CreateContentsGenerationsTasks&serviceCode=ark&version=2024-01-01)
- [火山方舟：查询视频生成任务信息](https://api.volcengine.com/api-docs/view?action=GetContentsGenerationsTask&serviceCode=ark&version=2024-01-01)
- [火山方舟官方 Go SDK v1.2.46：content generation 数据结构](https://github.com/volcengine/volcengine-go-sdk/blob/v1.2.46/service/arkruntime/model/content_generation.go#L67-L174)
- [火山方舟官方 Go SDK v1.2.46：两个 HTTP 调用](https://github.com/volcengine/volcengine-go-sdk/blob/v1.2.46/service/arkruntime/content_generation.go#L13-L41)
- [火山方舟官方 Go SDK v1.2.46：通用 Usage 结构](https://github.com/volcengine/volcengine-go-sdk/blob/v1.2.46/service/arkruntime/model/common.go#L41-L47)
- [火山方舟官方 Go SDK v1.2.46：HTTP 错误结构](https://github.com/volcengine/volcengine-go-sdk/blob/v1.2.46/service/arkruntime/model/error.go#L9-L35)
- [New-API 当前 Doubao adaptor](https://github.com/QuantumNous/new-api/blob/3d5dc36f1d85ccae8d5cb2864764011795b559b5/relay/channel/task/doubao/adaptor.go#L67-L103)

官方 Go SDK 版本固定为 `v1.2.46`（2026-08-06 发布）；New-API 固定到检索时 `main` 的 commit `3d5dc36f1d85ccae8d5cb2864764011795b559b5`，避免以后 `main` 变化导致证据漂移。

## 端点与鉴权

官方 SDK 默认 Base URL 是 `https://ark.cn-beijing.volces.com/api/v3`，再拼接 `/contents/generations/tasks`：

- `POST /api/v3/contents/generations/tasks`
- `GET /api/v3/contents/generations/tasks/{id}`

两者都使用 API Key 鉴权；New-API 实际发送 `Authorization: Bearer <key>`、`Accept: application/json` 和 `Content-Type: application/json`。Mock 不校验鉴权不会影响 adaptor 联调。

## 提交任务响应

公开文档的响应参数只有 `id`，官方示例为：

```json
{
  "id": "cgt-2025****-**"
}
```

官方 Go SDK 的完整接收结构为：

```json
{
  "id": "cgt-2025****-**",
  "safety_identifier": "optional"
}
```

其中 `safety_identifier` 标记为可选；正常 Mock 默认只返回 `id` 最接近公开示例，也完全符合 New-API。New-API 的 `responsePayload` 只有 `ID string json:"id"`，`id` 为空会进入 `invalid_response`。

## 查询任务响应字段

下面是官方 Go SDK `GetContentGenerationTaskResponse` 暴露的当前字段全集。公开 API 文档只展示其中视频任务常用的核心字段；SDK 中多出的字段用于新版 Seedance 能力或同一 contents-generation 资源下的其它生成任务。

| JSON 字段 | 类型 | 条件/含义 |
| --- | --- | --- |
| `id` | string | 任务 ID |
| `model` | string | 实际使用的模型名称与版本；如果提交用 Endpoint ID，这里不是原 Endpoint ID |
| `safety_identifier` | string | 可选 |
| `status` | string | `queued/running/cancelled/succeeded/failed` |
| `error` | object | 可选，任务失败时返回；内部为 `code`、`message` |
| `content` | object | 输出内容；Seedance 使用 `video_url`，开启尾帧返回时还有 `last_frame_url`；SDK 还定义 `file_url` |
| `usage` | object | 用量；视频文档明确展示 `completion_tokens`、`total_tokens` |
| `subdivisionlevel` | string | 可选，注意没有下划线；偏通用生成任务字段 |
| `fileformat` | string | 可选，注意没有下划线；偏通用生成任务字段 |
| `frames` | integer | 与 `duration` 二选一；提交指定 `frames` 时返回 |
| `framespersecond` | integer | 视频帧率；字段名确认是不带下划线的 `framespersecond` |
| `resolution` | string | 生成视频分辨率 |
| `ratio` | string | 生成视频宽高比 |
| `duration` | integer | 秒；与 `frames` 二选一 |
| `created_at` | integer | Unix 秒时间戳 |
| `updated_at` | integer | Unix 秒时间戳 |
| `seed` | integer | 可选，实际使用的随机种子 |
| `revised_prompt` | string | 可选，改写后的提示词 |
| `service_tier` | string | 可选 |
| `execution_expires_after` | integer | 可选 |
| `priority` | integer | 可选 |
| `generate_audio` | boolean | 可选 |
| `draft` | boolean | 可选 |
| `draft_task_id` | string | 可选 |
| `tools` | array | 可选，元素至少含 `type` |

两处文档类型不一致应按 SDK/实际 JSON 处理：公开页面把 `duration` 写成 `string`，同时把 `created_at` 示例写成带引号的值；官方 SDK 分别使用 `int64`，New-API 也使用 `int`/`int64`，所以 Mock 应返回 JSON 数字。

### `content`

官方 SDK 的结构是：

```json
{
  "video_url": "https://...",
  "last_frame_url": "https://...",
  "file_url": "https://..."
}
```

对 Seedance 视频 Mock：

- 成功时返回 `video_url`。
- 只有提交了 `return_last_frame: true` 时才应增加 `last_frame_url`。
- `file_url` 不是 Seedance 视频结果的必需字段，不应默认伪造。

### `usage`

官方视频 API 成功示例是：

```json
{
  "completion_tokens": 35800,
  "total_tokens": 35800
}
```

官方 Go SDK 当前给查询任务复用了通用 `Usage`，还可接收 `prompt_tokens`、`prompt_tokens_details` 和 `completion_tokens_details`。这些字段不是 New-API Seedance 结算所需字段，Mock 不应无根据地默认填充。

New-API 自己的 `responseTask` 额外声明了：

```json
{
  "usage": {
    "completion_tokens": 0,
    "total_tokens": 0,
    "tool_usage": {
      "web_search": 0
    }
  }
}
```

需要注意：`usage.tool_usage.web_search` 是 New-API 当前愿意解析的扩展，但官方 Go SDK 的 `GetContentGenerationTaskResponse.Usage` 并未声明 `tool_usage`。因此它可以作为工具调用场景的兼容字段，不能当作所有真实 Seedance 响应都固定存在的字段。

## 按状态的真实形态

### `succeeded`

官方公开成功示例的语义等价 JSON 为：

```json
{
  "id": "cgt-2024****-**",
  "model": "doubao-****-**",
  "status": "succeeded",
  "created_at": 1718049470,
  "updated_at": 1718049470,
  "content": {
    "video_url": "https://xxx"
  },
  "usage": {
    "completion_tokens": 35800,
    "total_tokens": 35800
  }
}
```

真实服务还会按任务参数返回 `seed`、`resolution`、`ratio`、`duration` 或 `frames`、`framespersecond` 等字段；这些字段是否出现取决于模型、请求参数和服务版本，不能为了“字段齐全”而给每个任务无条件塞空值。

### `failed`

官方公开失败示例明确省略 `content`、`usage` 和视频规格字段：

```json
{
  "id": "cgt-2024****-**",
  "model": "doubao-****-**",
  "status": "failed",
  "error": {
    "code": "OutputVideoSensitiveContentDetected",
    "message": "The request failed because the output video may contain sensitive information.Request ID: {id}"
  },
  "created_at": 1718049470,
  "updated_at": 1718049470
}
```

因此失败时返回 `content: {"video_url":""}` 或 `usage: {"completion_tokens":0,...}` 虽然 New-API 能反序列化，但不像官方失败示例。要对齐应直接省略这些字段。

### `queued` / `running`

官方文档列出了两个状态，但没有给出中间态的完整 JSON 样例。能够确定的是它们没有最终视频 URL，也没有失败 `error`。保守、最接近真实语义的最小体是：

```json
{
  "id": "cgt-2024****-**",
  "model": "doubao-****-**",
  "status": "queued",
  "created_at": 1718049470,
  "updated_at": 1718049470
}
```

服务可能同时回显已经确定的规格字段（例如 `resolution`、`ratio`、`duration`）；官方契约没有保证中间态一定包含或一定省略这些可选字段。Mock 可回显请求规格，但不应在中间态返回 `content.video_url`、最终 `usage` 或 `error`。

### `cancelled`

`cancelled` 是官方状态，表示取消成功，24 小时后自动删除；只有排队中的任务支持取消。Doubao adaptor 不会调用取消端点，而且 New-API 当前 switch 没有处理 `cancelled`，会把它落到默认分支并当成进行中（30%）。因此本 Mock 若只服务该 adaptor，不需要主动产生 `cancelled`。

## New-API `responseTask` 全字段和实际用途

当前 New-API 声明并解析：

```json
{
  "id": "",
  "model": "",
  "status": "",
  "content": { "video_url": "" },
  "seed": 0,
  "resolution": "",
  "duration": 0,
  "ratio": "",
  "framespersecond": 0,
  "service_tier": "",
  "tools": [{ "type": "" }],
  "usage": {
    "completion_tokens": 0,
    "total_tokens": 0,
    "tool_usage": { "web_search": 0 }
  },
  "error": { "code": "", "message": "" },
  "created_at": 0,
  "updated_at": 0
}
```

实际状态处理逻辑：

- `pending` / `queued` → queued，10%。
- `processing` / `running` → in progress，50%。
- `succeeded` → success，100%，此时才读取 `content.video_url`、`usage.completion_tokens`、`usage.total_tokens`。
- `failed` → failure，100%，读取 `error.message`。
- 其它值（包括官方的 `cancelled`）→ in progress，30%。

`seed`、`resolution`、`duration`、`ratio`、`framespersecond`、`service_tier`、`tools` 和 `usage.tool_usage` 虽已反序列化，但当前 `ParseTaskResult` 没有用它们结算或推进状态。New-API 的价格档仍在提交阶段从原始请求元数据计算，而不是读取查询响应的 `resolution`。

## HTTP 层错误与任务失败不是一回事

任务已创建后生成失败，查询接口仍返回任务对象，顶层是 `status: "failed"` 和紧凑的 `error: {code,message}`。

请求本身失败（鉴权、参数、配额、服务错误）则返回非 2xx，官方 SDK 接收的响应体为：

```json
{
  "error": {
    "code": "AuthenticationError",
    "message": "...",
    "param": "",
    "type": "Unauthorized"
  }
}
```

2026-08-11 对官方端点使用无效测试 Key 做的无计费探测得到 `401 Unauthorized`，响应头包含 `content-type: application/json; charset=utf-8`、`x-error-code: AuthN_AuthenticationError`、`x-request-id: ...`，响应体正是上述四字段 `error` 对象。Mock 的通用注入错误若要仿真 HTTP 层，建议至少补齐 `param` 和 `type`；但 New-API 的正常 Seedance 轮询核心测试不依赖这两个字段。

## 对当前 Mock 的复核建议

按本次证据，当前实现方向正确的部分包括：

- POST 只回 `{id}`。
- 成功才返回 `content` 和 `usage`。
- 失败返回 `error.code/message` 并省略结果与用量。
- `duration` / `frames` 二选一。
- `return_last_frame` 控制 `last_frame_url`。
- `framespersecond` 拼写正确。
- 请求参数在创建时快照，轮询按 `queued → running → succeeded/failed` 推进。

仍应注意：

- HTTP 注入错误体应增加 `error.param` 与 `error.type`，才能贴近真实方舟网关错误。
- 不要把 `pending`、`processing` 当作火山原生返回值；它们仅是 New-API 兼容别名。
- 不要默认产生 `cancelled`，否则当前 New-API 会错误地继续轮询。
- `usage.tool_usage` 只在确有工具调用场景时返回，不应成为每次 Seedance 成功响应的固定字段。

