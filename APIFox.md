---
title: 默认模块
language_tabs:
  - shell: Shell
  - http: HTTP
  - javascript: JavaScript
  - ruby: Ruby
  - python: Python
  - php: PHP
  - java: Java
  - go: Go
toc_footers: []
includes: []
search: true
code_clipboard: true
highlight_theme: darkula
headingLevel: 2
generator: "@tarslib/widdershins v4.0.30"

---

# 默认模块

Base URLs:

# Authentication

# MockMock

## POST Mock-流式

POST /v1/chat/completions

> Body 请求参数

```json
{
  "model": "gpt-3.5-turbo",
  "stream": true,
  "messages": [
    {
      "role": "user",
      "content": "测试"
    }
  ]
}
```

### 请求参数

|名称|位置|类型|必选|说明|
|---|---|---|---|---|
|Authorization|header|string| 否 |none|
|Content-Type|header|string| 否 |none|
|body|body|object| 是 |none|

> 返回示例

> 200 Response

```json
{"id":"chatcmpl-mock-0001","object":"chat.completion","created":1700000000,"model":"gpt-3.5-turbo","choices":[{"index":0,"message":{"role":"assistant","content":"这是来自 mock 上游的假回复，用于测试 new-api 全链路计费与日志。"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":30,"total_tokens":31,"prompt_tokens_details":{"cached_tokens":0}}}
```

### 返回结果

|状态码|状态码含义|说明|数据模型|
|---|---|---|---|
|200|[OK](https://tools.ietf.org/html/rfc7231#section-6.3.1)|none|Inline|

### 返回数据结构

# 数据模型

