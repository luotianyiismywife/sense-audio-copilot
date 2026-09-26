# SenseAudio API 参考记录

> ⚠️ **遇到 SenseAudio API 集成问题（参数 400、协议不兼容、能力标记等）时，优先查看本文档和官方 API 文档**：
> - 官方 API 文档：<https://docs.senseaudio.cn/api-reference/introduction>
> - 调试时以官网示例（cURL/Node.js）为基准，对比插件请求体差异。
> - **Responses API（`/v1/responses`）问题分析见根目录 [`RESPONSES_API_ISSUES.md`](../RESPONSES_API_ISSUES.md)**（工具格式扁平化、拒绝 function_call 块、tool_choice 受限等）。
>
> 本文档记录 SenseAudio 平台的 API 地址信息，供扩展开发与调试参考。
> 最后更新：2026-09-23（平台改版重探：三域认证体系 + 套餐用量数据源 + 旧端点 404）

---

## 1. API 文档

| 项目 | 地址 |
|------|------|
| API 文档 | <https://docs.senseaudio.cn/api-reference/introduction> |
| 模型列表页 | <https://docs.senseaudio.cn/guides/account/model-list-billing> |
| 注册 / 获取 API Key | <https://senseaudio.cn/api-platform/api-key> |

---

## 2. 统一基础地址

```
https://api.senseaudio.cn/v1
```

所有端点均在统一基础地址下。

---

## 3. 主要端点

| 端点 | 方法 | 用途 |
|------|------|------|
| `/v1/models` | `GET` | 模型列表（含能力标记 `supports_responses` / `supports_anthropic` 等） |
| `/v1/chat/completions` | `POST` | OpenAI 兼容对话 |
| `/v1/messages` | `POST` | Anthropic 兼容对话 |
| `/v1/responses` | `POST` | Responses API 对话（`supports_responses` 模型原生支持） |
| `/v1/embeddings` | `POST` | 向量嵌入 |

---

## 4. 代码中的引用位置

| 文件 | 常量 / 位置 |
|------|-------------|
| `src/apiModelList.ts` | `API_BASE_URL = "https://api.senseaudio.cn/v1/"` |
| `src/provider.ts` | `um?.baseUrl \|\| "https://api.senseaudio.cn/v1/"` |
| `src/gitCommit/commitMessageGenerator.ts` | `selectedModel.baseUrl \|\| "https://api.senseaudio.cn/v1/"` |
| `scripts/check-new-models.mjs` | `API_BASE_URL = "https://api.senseaudio.cn/v1/"` |
| `test/api-tests.mjs` | `BASE = "https://api.senseaudio.cn/v1"` |

---

## 5. 常见混淆说明

> **models.dev ≠ SenseAudio API 文档**

- `models.dev`（<https://models.dev/models.json>）是 **OpenRouter 维护的全球模型目录数据库**，仅用于本扩展**自动模型发现**时获取新模型的规格元数据（上下文长度、视觉能力、工具调用、推理能力等），由 `src/modelsDev.ts` 下载并缓存。
- 扩展**实际请求**走的是上方 `https://api.senseaudio.cn/v1` 地址，两者用途不同，勿混淆。

---

## 6. 已确认的平台规则与踩坑记录

> 来源：官方文档示例 + `test/api-tests.mjs` 实测（2026-08-03）+ 2026-08-06 生产排障 + 2026-08-26 官方文档核对（Anthropic/DeepSeek）。

| 规则 | 说明 |
|------|------|
| **Anthropic 端点认证头（2026-09-23 实测）** | **`x-api-key` 与 `Authorization: Bearer` 均可**（同请求仅带其一均 200，无认证头 401 `authentication_error`）；`anthropic-version` 头**非必需**（不带也 200）。官方文档写“所有接口均使用 Bearer Token”，但端点实际兼容标准 Anthropic SDK 的 `x-api-key`。**插件保持现状**（anthropic 模式发 `x-api-key` + `anthropic-version`，openai/responses 发 `Bearer`），无需改代码 |
| Anthropic 协议必带头 | `anthropic-version: 2023-06-01`（实测非必需但建议保留）+ 必须传 `max_tokens` |
| DeepSeek `tool_choice` | 传字符串 `none` / `auto` / `required`，**不要传对象形式** |
| OpenAI 端点 `thinking` | 仅接受字符串语义：`{ type: "enabled" }` / `{ type: "auto" }`（自适应；`adaptive` 会被拒绝）/ `{ type: "disabled" }` |
| **Anthropic 端点 `thinking`** | **2026-09-23 全量复测（deepseek-v4-flash-0731）**：`enabled`（无 temp）→ 200 且输出 `thinking` 块；`enabled` + temperature → **200**（2026-08-06 的 400 冲突**已修复**）；`enabled` + temp + top_p → 200；`adaptive` → 200；`disabled` → 200。**插件可简化**：无需再跳过 temperature/top_p（但保留跳过逻辑无害） |
| **Anthropic 端点 `tool_choice`（2026-09-23 实测）** | `auto`（对象形式）→ 200；`any` → 200（强制工具调用）；`none` → 200；**指定工具形式 `{type:"tool", name}` → 稳定 500**（“服务繁忙”，与 Responses 端点同款问题）。插件仅发 auto/any/none，正确 |
| **Anthropic 端点图片输入（2026-09-23 实测）** | 视觉模型（glm-5.3-flash）base64 图片 → 200 正常识别；**非视觉模型（deepseek-v4-flash-0731）发图片 → 稳定 500**（“服务繁忙”，OpenAI/Responses 端点同款）——**非视觉模型不应直接发图片**，插件已通过 ask_image 代理规避 |
| **Anthropic 端点其他参数（2026-09-23 实测）** | `top_k` → 200；`system` 字段 → 200；多轮 `tool_use`/`tool_result` 回填 → 200；历史 `thinking` 块回传 → 200；流式 SSE 事件（message_start/content_block_start/delta/stop）→ 标准 Anthropic 格式 |
| **Anthropic 模式 temperature/top_p** | **2026-08-06 实测 4 组合：enabled+temp→400、enabled+top_p→400、adaptive+temp+top_p→200、disabled+temp→200；生产复现 `trace_201493fe`。2026-09-23 复测：enabled+temp→200、enabled+temp+top_p→200，冲突已修复**。判定结论（2026-08-26）：这是 Anthropic 标准协议行为，不是平台 bug——Anthropic 官方文档（Thinking 页 *Limits and feature compatibility*）原文：*"On older models, the restriction applies only while thinking is on: `temperature` and `top_k` are incompatible with thinking, and `top_p` is allowed at values between 0.95 and 1"*。**插件已修复：仅 thinking 强制 enabled 时跳过 temperature/top_p**（`src/anthropic/anthropicApi.ts` `prepareRequestBody`，adaptive/disabled 保留温度，top_k 恒保留）。**平台侧 3 个可改进点**：① 400 报错文案含糊（"请求参数组合无效"，不如 Anthropic 官方给出 "temperature is not supported with extended thinking" 语义），排障困难；② 与自家 OpenAI 端点行为不一致（OpenAI 端点实测 200 容忍忽略）；③ 文档未提示此约束（2026-09-23 复测该约束已消失） |
| **DeepSeek 官方对 temperature+thinking 的立场** | **模型厂商官方认为二者不冲突**：① OpenAI 格式（official `/guides/thinking_mode`）：*"Thinking mode does not support the `temperature`, `top_p`, `presence_penalty`, or `frequency_penalty` parameters. Please note that, for compatibility with existing software, setting these parameters will not trigger an error but will also have no effect"*——**设置了不报错只不生效**；② Anthropic 兼容层（official `/guides/anthropic_api` 兼容表）：`temperature` **Fully Supported** (range 0.0~2.0)、`top_p` **Fully Supported**、`thinking` Supported (budget_tokens ignored)。**结论："deepseek thinking enabled 冲突"只在 Anthropic 协议形态下存在（Anthropic 标准要求拒绝），DeepSeek 官方自家端点两种格式均容忍。插件按协议形态适配即可，无需改代码** |
| **Anthropic 协议建议** | **建议优先使用 OpenAI 兼容格式**：Anthropic 端点按 Anthropic 标准对部分组合更严格（如 thinking enabled + temperature → 400），OpenAI 端点容忍该组合（设置了不报错只不生效，与 DeepSeek 官方一致）。仅在明确需要 Anthropic 原生 Messages 格式时使用 |
| 流式响应解析 | OpenAI SSE `choices[0].delta.content`；Anthropic 原生 Messages 流式事件。**两种协议不要混用解析器** |
| Responses 端点工具格式 | 工具定义需**扁平格式** `{ type: "function", name, description, parameters }`（OpenAI 嵌套 `function` 格式会被拒） |
| Responses `tool_choice` | 仅接受 `auto` / `none`（思考模式下拒绝 `required`/对象形式） |
| Anthropic 协议非全量 | `qwen3.7-max`、`kimi-k2.7-code` 不支持（`supports_anthropic=false`），以 `/v1/models` 动态标记为准 |
| qwen3.8-max 图片限制 | 图片尺寸必须 >= 10x10 像素 |

---

## 7. 用户中心 API（2026-09-23 平台改版重探）

> ⚠️ **平台已改版（2026-09-23 实测）**：旧端点 `senseaudio.cn/api/usage-summary` 与 `/api/api-keys` **均已 404**（2026-08-24 实测还是 200）。
> 用户中心已迁移为**三域三制**认证体系，套餐用量数据源变更为 `platform.senseaudio.cn/api/user/self`。

### 7.0 三域认证体系（2026-09-23 实测）

| 域 | 认证方式 | 说明 |
|----|---------|------|
| `senseaudio.cn/api/*` | `tr_session` cookie | 主站会话（页面登录态）；`/api/config` 无需认证 200；旧端点 `usage-summary`/`api-keys` 已 404 |
| `platform.senseaudio.cn/api/*` | **`Authorization: Bearer <PASETO token>`** + `x-platform: WEB` / `x-product: SenseAudio` / `x-version: 1.0.2` / `x-language: zh-cn` / `x-machine: <hash>` 头 | **不是 cookie！** token 来自 `localStorage.user.state.token`（PASETO v2.public，有效期 60 天，payload 含 user_id/role/platform=WEB/login_id）；无 token → 403 `forbidden`（`ref_code:403002`） |
| `auth.senseaudio.cn/v1/apikey/apply_token_via_public_key` | public_key 换发 | 用 `pub-*` 公钥换发**短期 API token**（24h 有效，响应含 `token` + `expireAt` epoch 秒） |

> **插件影响**：插件只有 `tr_session` cookie，**拿不到 localStorage 里的 PASETO token**（httpOnly 页面上下文），因此无法直接调用 `platform.senseaudio.cn/api/*`。旧 `tr_session` cookie 端点已 404，`balanceCheck.ts` 的余额预检与平台 Key 数量查询会全部失败（好在失败时静默降级不阻塞请求）。

### 7.1 套餐用量核心数据源：`GET platform.senseaudio.cn/api/user/self`（Bearer token）

响应里的 **`usage_infos`** 数组就是网页「Token 套餐 → 套餐用量限制」三块卡片的数据：

```jsonc
"usage_infos": [
  { "key": "credit_5h_limit",  "desc": "5小时积分",       "used_count": 0,     "pending_count": 0, "total_count": 10000, "reset_time": 1790099464 },
  { "key": "credit_7d_limit",  "desc": "每周全部模型积分", "used_count": 0,     "pending_count": 0, "total_count": 10000, "reset_time": 1790524800 },
  { "key": "credit_30d_limit", "desc": "30天积分",        "used_count": 10012, "pending_count": 0, "total_count": 10000, "reset_time": 1792166400 }
]
```

- `reset_time` 为 epoch 秒：5小时窗口 = 上次消耗积分后 +5h；每周 = 周一 00:00；30天 = 套餐生效日 +30天
- **30天已用 10012 > 上限 10000**（超限后走额外用量）

### 7.2 额外用量（余额）数据源：同响应的 `account_info`

```jsonc
"account_info": {
  "balance": 0,                    // 现金余额（备用扣减，元）
  "balance_in_flight": 0,
  "channel_balance": 0,
  "credits": [],
  "vouchers": [                     // 代金券，单位 = 积分（1 元 = 5000 积分）
    { "voucher_id": 66804, "name": "注册赠送代金券", "available": 18779586, "total": 20000000, "used": 1220414, "pending": 0, "expire_at": 1792168235 },
    ...
  ],
  "status": "NORMAL",
  "enable_extra_usage": true        // 额外用量开关
}
```

- **代金券单位是积分**：网页显示的「代金券余额 338.78 元」 = Σ可用代金券积分 / 5000
- **扣减顺序**：套餐积分 → 代金券（按到期时间先后）→ 现金余额
- `enable_extra_usage: false` 时套餐额度用尽即无法调用

### 7.3 套餐档位：`GET platform.senseaudio.cn/api/recharge/subscribe/list`（Bearer token）

`concurrent_rights` 数组含各档位限制：`credit_5h_limit`（5小时积分）/ `credit_7d_limit`（每周全部模型积分）/ `month_base_points`（30天套餐积分）及各能力并发限制（TTS/ASR/图片/视频/音乐/Agent 等）。

### 7.4 API Key 数据：`GET platform.senseaudio.cn/api/apikey/default`（Bearer token）

返回完整 key（`sk-...`，含 `public_key`/`remain_quota`/`unlimited_quota`/`used_quota`/`expired_time`）。`apikey/list` 稳定 500（已废弃或需特殊权限），网页只用 `apikey/default`。

### 7.5 旧端点状态（2026-09-23 实测，均已失效）

| 旧端点 | 现状 |
|--------|------|
| `senseaudio.cn/api/usage-summary` | **404**（已迁移/删除） |
| `senseaudio.cn/api/api-keys` | **404**（已迁移/删除） |
| `senseaudio.cn/api/auth/me` | 未复测（可能仍存在） |
| `senseaudio.cn/api/call-logs/page` | 未复测（可能仍存在） |
| `platform.senseaudio.cn/api/apikey/list` | 稳定 500（已废弃） |

> **历史记录（2026-08-24，端点尚存时）**：`/api/usage-summary` 返回 `balanceCny`/`availableBalanceCny`/`expiringBalanceCny`/`nextExpiryAt`；`/api/api-keys` 返回 key 列表（`maskedKey`/`keyPrefix`/`status`）；创建/删除 key 受 CSRF + TLS 指纹双重校验（Node.js/curl 无法绕过，仅真实浏览器可行）。这些端点现已 404，记录保留供追溯。
