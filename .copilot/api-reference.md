# SenseAudio 平台 API 实测参考

> ⚠️ **本文档全部基于实测**（2026-09-29，用真实 key 逐项验证），不是对官方文档的转抄。
> 官方文档：<https://docs.senseaudio.cn/api-reference/introduction>（部分内容滞后或与实际不符，以本文实测为准）。
> 复测脚本：`test/api-tests.mjs`（三协议全量）、`test/test-responses-recheck.mjs`（Responses 行为）。
>
> 最后更新：2026-09-29（三协议标准符合性全量实测 + 端点存在性探测）

---

## 1. 基础信息

| 项目 | 值 |
|------|-----|
| API 基础地址 | `https://api.senseaudio.cn/v1` |
| 认证方式 | `Authorization: Bearer <API_KEY>`（Anthropic 端点也接受 `x-api-key`） |
| API 文档 | <https://docs.senseaudio.cn/api-reference/introduction> |
| 模型列表页 | <https://docs.senseaudio.cn/guides/account/model-list> |
| 获取 API Key | <https://senseaudio.cn/api-platform/api-key> |

---

## 2. 端点存在性（2026-09-29 实测探测）

### 2.1 存在的端点

| 端点 | 方法 | 用途 | 实测 |
|------|------|------|------|
| `/v1/models` | GET | 模型列表 | ✅ 200 |
| `/v1/models/{id}` | GET | 单模型详情 | ✅ 200 |
| `/v1/chat/completions` | POST | OpenAI 兼容对话 | ✅ 200 |
| `/v1/messages` | POST | Anthropic 兼容对话 | ✅ 200 |
| `/v1/responses` | POST | OpenAI Responses 兼容对话 | ✅ 200 |
| `/v1/audio/transcriptions` | POST | 语音识别（multipart/form-data） | ✅ 存在（非 multipart 报 400 "parse file failed"） |

### 2.2 不存在的端点（404，勿再使用）

| 端点 | 说明 |
|------|------|
| `/v1/embeddings` | **404**（旧文档误记，平台无向量嵌入端点） |
| `/v1/completions`（GET/POST） | 404（无 legacy completions） |
| `/v1/files` | 404 |
| `/v1/images/generations` | 404（图片生成走独立端点，见官方文档 image 节） |
| `/v1/usage`、`/v1/dashboard/billing/usage` | 404（用量查询走 `platform.senseaudio.cn`，见 §7） |

---

## 3. 模型列表 `GET /v1/models`

**实测响应字段集**（全部 llm 条目的字段名并集）：

```
id, display_name, object, type, mode, protocols, created, owned_by, desc
```

> ⚠️ **不返回任何规格/能力字段**：无 `context_length`、`max_completion_tokens`、`supports_vision`、`supports_reasoning`、`supports_tools`。
> 规格需查[官方模型页](https://docs.senseaudio.cn/guides/account/model-list)；视觉能力经 models.dev 判定（见 `src/models/visionModels.ts`）。

- `mode` 区分模态：`llm` / `stt` / `tts` / `image` / `video` / `music` / `voice_clone` / …（**只有 `mode === "llm"` 是对话模型**）
- `protocols` 数组推导协议能力：`["chat_completions", "responses", "messages"]` → 三协议全支持
- **2026-09-29 实测**：9 个 llm 模型的 `protocols` 均为三协议全支持

### 当前 llm 模型（2026-09-29 实测，9 个）

| 模型 ID | 视觉 | 上下文/输出（官方文档） |
|---------|------|----------------------|
| `senseaudio-s2` | ❌ | 1M / 128K |
| `senseaudio-s2-flash` | ❌ | 256K / 64K |
| `senseaudio-s2-lite` | ❌ | 256K / 64K |
| `sensenova-6.8-flash-lite` | ❌ | 文档为 `—`（暂按 256K/64K 假定） |
| `qwen3.8-27b` | ✅ | 256K / 32K |
| `qwen3.6-35b-a3b` | ✅ | 256K / 64K |
| `deepseek-v4.1-flash` | ✅ | 1M / 384K |
| `deepseek-v4-flash-0731` | ❌ | 1M / 384K |
| `glm-5.3-flash` | ✅ | 1M / 128K |

> 视觉判定来源：models.dev（与 OpenRouter `architecture.input_modalities` 交叉验证一致）。
> `/v1/models` **不校验余额**（余额 < 0 也 200），不能作可用性判据。

---

## 4. 三协议标准符合性（2026-09-29 全量实测）

> 测试模型 `glm-5.3-flash`，共 30+ 项对照测试。结论：**三协议均高度符合各自标准**，仅一个共同缺口（见 4.4）。

### 4.1 OpenAI 协议 `/v1/chat/completions` — 11/11 全通过 ✅

| 标准特性 | 实测 |
|---------|------|
| 基础对话 / 多模态 `content` 数组 | ✅ |
| 嵌套工具格式 `{type:"function",function:{...}}` | ✅ |
| `tool_choice`: `auto` / `required` / **`{type:"function",function:{name}}`** | ✅ 命名形式可用且**真的强制指定工具** |
| 多轮 `tool_calls` + `tool` role 回填 | ✅ |
| `stop` / `response_format` / `n` / `frequency_penalty` / `presence_penalty` / `seed` | ✅ |

**平台特有参数**（非 OpenAI 标准）：
- `thinking`: `{type:"enabled"}` / `{type:"auto"}`（自适应）/ `{type:"disabled"}`——**仅接受字符串语义**，`adaptive` 会被拒绝
- `reasoning_effort`: `low` / `medium` / `high` / `xhigh` / `max` / `none`（`disabled` 会 400，正确值是 `none`）

### 4.2 Anthropic 协议 `/v1/messages` — 12/13 ✅

| 标准特性 | 实测 |
|---------|------|
| 基础对话 / `system` 顶层字段 / `max_tokens`（必传） | ✅ |
| `tool_use` / `tool_result` 块回填 | ✅ |
| `tool_choice`: `{type:"auto"}` / `{type:"any"}` / `{type:"none"}` | ✅ |
| `thinking`: `{type:"enabled",budget_tokens}` / `{type:"adaptive"}` / `{type:"disabled"}` | ✅ |
| 图片块（标准 `source:{type:"base64",media_type,data}` 结构） | ✅ |
| `stop_sequences` / `top_k` / `metadata` / **assistant 预填充** | ✅ |
| **`tool_choice: {type:"tool",name}`** | ❌ **稳定 500**（见 4.4） |

**认证**：`x-api-key` 与 `Authorization: Bearer` 均可；`anthropic-version` 头非必需（建议保留）。

**thinking + temperature 组合**（历史踩坑，已修复）：
- 2026-08-06 实测：`enabled` + temperature → 400 "请求参数组合无效"
- 2026-09-23 复测：**已修复**，`enabled` + temp/top_p → 200
- 插件仍保留"thinking 强制 enabled 时跳过 temperature/top_p"的逻辑（无害，符合 Anthropic 标准）

### 4.3 Responses 协议 `/v1/responses` — 11/12 ✅

| 标准特性 | 实测 |
|---------|------|
| 基础对话 / `instructions` 顶层字段 | ✅ |
| **扁平工具格式** `{type:"function",name,description,parameters}` | ✅（这是 Responses 标准格式，与 Chat Completions 的嵌套格式不同**不是平台问题**） |
| **顶层 `function_call` item 回填**（标准写法） | ✅ **模型正确理解工具历史** |
| `tool_choice`: `auto` / `none` / `required` | ✅ |
| `input_image` 块 | ✅ |
| `max_output_tokens` / `reasoning:{effort}` / `text.format` / `store` / `parallel_tool_calls` | ✅ |
| **`tool_choice: {type:"function",name}`** | ❌ **稳定 500**（见 4.4） |

**⚠️ 纠正上游遗留的两个错误结论**（2026-09-29 实测推翻）：

| 上游文档说 | 实测事实 |
|-----------|---------|
| "拒绝 `function_call` / `function_call_output` 内容块" | **错**。**顶层** item（`{type:"function_call",call_id,name,arguments}` + `{type:"function_call_output",call_id,output}`）完全可用。上游用的是错误写法（塞进 `assistant.content` 数组） |
| "工具格式与自家 OpenAI 端点不一致是问题" | **不是问题**。Responses 扁平 / Chat Completions 嵌套——这正是 OpenAI 官方规范，两端点本来就不同 |

**流式推理事件类型因模型而异**（网关透传各模型后端事件，未统一转换）：
- 部分模型：`response.reasoning_summary_text.delta`
- 部分模型：`response.reasoning_text.delta`
- glm-5.3-flash 实测：`response.reasoning_part.added` / `response.reasoning_text.delta` / `response.reasoning_text.done` / `response.reasoning_part.done`
- 插件已兼容多种事件类型 ✅

### 4.4 唯一共同缺口：命名 tool_choice（确定性缺陷，非瞬时繁忙）

```
OpenAI:     tool_choice: {type:"function", function:{name:"get_weather"}}  → 200 ✅（且真的强制指定工具）
Anthropic:  tool_choice: {type:"tool", name:"get_weather"}                 → 500 ❌（8/8 次全失败）
Responses:  tool_choice: {type:"function", name:"get_weather"}             → 500 ❌（8/8 次全失败）
```

**证据**（排除"平台繁忙"解释）：
- 交错对照实验：同一时刻、同一模型、同一工具，间隔 0.5s 连发——`auto`/`any`/`required` 全 200，**只有命名形式 500**
- 重复 6 次 + 交错 2 轮，命名形式 **8/8 全 500**
- 报错文案 `"服务繁忙，请稍后再试"`（`ref_code:500000`）是**误导性包装**——实际是网关层对"指定具体工具"路由的确定性缺陷

**插件影响：无**（插件从不发送命名形式，`responsesApi` 把具名归入 `auto`，`anthropicApi` 不处理具名）。

---

## 5. 错误响应格式（实测）

| 场景 | HTTP | 响应体 |
|------|------|--------|
| 余额不足 | 402 | `{"code":"INSUFFICIENT_BALANCE","message":"余额不足"}`（**不消耗 token**） |
| 计费账户冻结（封号） | 400 | `{"code":"billing","message":"计费账户已被冻结","ref_code":400901}` |
| 无效 key | 401 | — |
| 无效模型 ID | 4xx | 含 `error.message` |
| 命名 tool_choice | 500 | `{"code":"internal","message":"服务繁忙，请稍后再试","ref_code":500000}` |
| 非视觉模型发图片 | 500 | 同上（三端点同款） |
| public_key 不存在 | — | `rpc error: code = NotFound desc = notfound.apikey_not_exists`（auth 域） |

---

## 6. 代码中的引用位置

| 文件 | 常量 / 位置 |
|------|-------------|
| `src/models/apiModelList.ts` | `API_BASE_URL = "https://api.senseaudio.cn/v1/"` |
| `src/provider/provider.ts` | `um?.baseUrl \|\| "https://api.senseaudio.cn/v1/"` |
| `src/gitCommit/commitMessageGenerator.ts` | `selectedModel.baseUrl \|\| "https://api.senseaudio.cn/v1/"` |
| `scripts/dev/check-new-models.mjs` | `API_BASE_URL = "https://api.senseaudio.cn/v1/"` |
| `test/api-tests.mjs` | `BASE = "https://api.senseaudio.cn/v1"` |

---

## 7. 用户中心 API（platform.senseaudio.cn，2026-09-23 实测）

> 三域认证体系：`senseaudio.cn/api/*`（cookie）/ `platform.senseaudio.cn/api/*`（Bearer PASETO）/ `auth.senseaudio.cn`（public_key 换发）。

### 7.1 `GET platform.senseaudio.cn/api/user/self`（套餐用量核心数据源）

认证：`Authorization: Bearer <PASETO token>` + 必需头 `x-platform: WEB` / `x-product: SenseAudio`（缺则 403 `ref_code:403002`）。

token 来源：浏览器 `localStorage` 的 `user.state.token`（PASETO v2.public，60 天有效）。

响应关键字段：

```jsonc
"usage_infos": [   // 三窗口用量（5h/周/月）
  { "key": "credit_5h_limit",  "desc": "5小时积分",  "used_count": 0, "pending_count": 0, "total_count": 10000, "reset_time": 1790099464 },
  { "key": "credit_7d_limit",  "desc": "每周全部模型积分", ... },
  { "key": "credit_30d_limit", "desc": "30天积分",   ... }
],
"account_info": {
  "balance": 0,                  // 现金余额（元）
  "vouchers": [ ... ],           // 代金券（单位=积分，1 元 = 1,000,000 积分）
  "status": "NORMAL",
  "enable_extra_usage": true     // 超额开关
}
```

> ⚠️ **单位陷阱**：代金券 `available` 的换算是 **1 元 = 1,000,000 积分**（2026-09-27 实测校正；曾误用 5000 导致 200 倍误差）。
> 两套计费规则严格区分：周期额度（5h/周）是**限流窗口**（耗尽等恢复、不扣余额）；套餐积分（月度）才是**订阅额度**（耗尽走超额策略）。

### 7.2 `POST auth.senseaudio.cn/v1/apikey/apply_token_via_public_key`

用 `pub-*` 公钥换发短期 API token（实测 30 分钟有效期）。请求体 `{"public_key":"pub-..."}`。

### 7.3 已失效端点（勿再使用）

| 旧端点 | 现状 |
|--------|------|
| `senseaudio.cn/api/usage-summary` | 404（2026-09-23 实测） |
| `senseaudio.cn/api/api-keys` | 404 |
| `platform.senseaudio.cn/api/apikey/list` | 稳定 500（已废弃） |

---

## 8. 常见混淆说明

> **models.dev ≠ SenseAudio API**

- `models.dev`（<https://models.dev/models.json>）是 OpenRouter 维护的全球模型目录，仅用于本扩展**自动模型发现**（规格元数据）与**视觉能力判定**（`src/models/visionModels.ts`）
- 扩展实际请求走 `https://api.senseaudio.cn/v1`，两者用途不同

> **`/v1/models` 不校验余额**：余额 < 0 也返回 200，不能作为 key 可用性判据。手动检测用最小真实聊天请求（`say ok` + `max_tokens=8`，余额不足时被 402 拦截不耗 token）。
