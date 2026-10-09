# SenseAudio 测试脚本

> 所有测试运行前需先 `npm run compile`（从 `out/` 加载编译产物）。
>
> **凭据一律从命令行参数或环境变量读取，不写入仓库**：
> `SENSEAUDIO_API_KEY` / `SENSEAUDIO_PUBLIC_KEY`
>
> **联网探测脚本已移至 `scripts/dev/`**（`probe-*.mjs`）——它们不是自动化测试（无断言，仅打印结果），
> 详见 [scripts/dev/](../scripts/dev/)。

## 测试清单

| 脚本 | 类型 | 说明 |
|------|------|------|
| `test-plan-usage.mjs` | 离线 | **套餐用量快照**（29 项断言）：窗口归一化、百分比、超额判定、三态计费模式、倒计时、摘要格式化、真实 API 夹具回归 |
| `test-transient-retry.mjs` | 离线 | **错误分类规则**（15 项断言，errorRules 四元组）：code 精确匹配（billing→rotatePersist / upstream_stream_error→retrySameKey / INSUFFICIENT_BALANCE→rotatePersist）、statusCode 兑底、code 优先于 statusCode（400 复用）、规则可配置、`markApiKeyExhausted` 按 action 决定冷却/持久化 |
| `test-vision-history.mjs` | 离线 | 跨轮视觉历史编解码 + 双 API 转换器闭环（含 DeepSeek 空 reasoning_content 回归） |
| `test-anthropic-tool-result-merge.mjs` | 离线 | Anthropic 连续工具结果合并（issue #87：3 个并行 tool_use 结果合并为单条 user 消息） |
| `test-anthropic-image-index.mjs` | 离线 | **Anthropic 图片索引顺序**（3 项断言）：图片索引按 part 顺序内联分配，与 `collectLocalImages` 存储顺序一致（回归：曾延迟分配导致混排时索引错位） |
| `test-anthropic-vision-order.mjs` | 离线 | **Anthropic 视觉历史顺序**（2 项断言）：缓冲的工具结果先于视觉历史输出，视觉 tool_use 紧跟其 tool_result（回归：曾先推视觉历史导致顺序颠倒） |
| `test-image-dimensions.mjs` | 离线 | **图片尺寸解析**（5 项断言）：PNG / GIF / JPEG / WebP 尺寸解析（回归：PNG 签名检测错误导致返回 unknown） |
| `test-batch-import.mjs` | 离线 | **批量导入解析器**（14 项断言）：`key---credential---备注;` 格式、空字段、备注含分隔符、容错 |
| `test-cloud-sync-auto-push.mjs` | 离线 | **云同步 payload 去重**（18 项断言）：`syncPayloadHasChanged` 空值/版本/长度/逐字段/顺序分支，`undefined` 与 `""` 等价、`updatedAt` 不参与比较、旧字段名 `cookie` 兼容 |
| `test-cloud-sync-flow.mjs` | 离线 | **云同步 push/pull 集成**（22 项断言）：mock fetch + mock vscode 驱动生产 `pushToCloud`/`pullFromCloud`（新建/PATCH/短路/合并/静默/缓存失效回退/服务端时间戳回归） |
| `test-cloud-sync-e2e.mjs` | 联网 | **云同步真实端到端**（16 项断言）：真实 GitHub Gist API 驱动生产代码，验证请求体格式/响应结构/`updated_at`/内容往返；需 gist 权限凭据，无凭据时 SKIP |

## 运行

```bash
npm run compile

# 离线测试（无需 API Key）
npm run test:offline
# 或逐个运行
node test/test-plan-usage.mjs
node test/test-transient-retry.mjs
node test/test-vision-history.mjs
node test/test-anthropic-tool-result-merge.mjs
node test/test-anthropic-image-index.mjs
node test/test-anthropic-vision-order.mjs
node test/test-image-dimensions.mjs
node test/test-batch-import.mjs
node test/test-cloud-sync-auto-push.mjs
node test/test-cloud-sync-flow.mjs

# 云同步真实端到端（需 GitHub gist 权限凭据；无凭据时 SKIP 退出 0）
npm run test:e2e
# 凭据来源：GITHUB_TOKEN / GH_TOKEN 环境变量，或 `gh auth token`
```

---

## 联网探测脚本（`scripts/dev/probe-*.mjs`）

> 这些脚本**不是自动化测试**（无断言，仅打印结果供人工判断），需真实 API Key，已移至 `scripts/dev/`。

| 脚本 | 说明 |
|------|------|
| `probe-api.mjs` | 三协议完整探测（OpenAI / Anthropic / Responses） |
| `probe-model-diff.mjs` | 内置清单 vs `/v1/models` 差异（内置清单从编译产物读取，不会脱节） |
| `probe-responses.mjs` | Responses 协议复检（工具格式扁平化 / function_call 块 / tool_choice 行为） |
| `probe-vision.mjs` | 视觉能力检查（生成合法 PNG 测图片输入） |
| `probe-apply-token.mjs` | public_key 换发短期 token（`auth.senseaudio.cn`） |

```bash
node scripts/dev/probe-api.mjs <API_KEY> [openai|anthropic|responses|all]
SENSEAUDIO_API_KEY=<key> node scripts/dev/probe-model-diff.mjs
SENSEAUDIO_API_KEY=<key> node scripts/dev/probe-vision.mjs [MODEL_ID]
SENSEAUDIO_API_KEY=<key> node scripts/dev/probe-responses.mjs
SENSEAUDIO_PUBLIC_KEY=<pub-key> node scripts/dev/probe-apply-token.mjs
```

---

## `probe-api.mjs` 详情

三协议完整测试脚本，用于验证 SenseAudio 平台 API 的兼容性。

- `<API_KEY>`: SenseAudio API key
- filter 可选: `openai` | `anthropic` | `responses` | `all`（默认 `all`）

### 模型可配置（默认取当前在售模型）

| 环境变量 | 默认值 | 用途 |
|----------|--------|------|
| `SENSEAUDIO_TEST_MODEL` | `deepseek-v4.1-flash` | 主测试模型（OpenAI / Anthropic 协议） |
| `SENSEAUDIO_TEST_THINKING_MODEL` | `glm-5.3-flash` | thinking + reasoning_effort 测试 |
| `SENSEAUDIO_TEST_VISION_MODEL` | `qwen3.6-35b-a3b` | 图片输入测试 |
| `SENSEAUDIO_TEST_RESP_MODELS` | `glm-5.3-flash,deepseek-v4-flash-0731,qwen3.8-27b` | Responses 协议测试（逗号分隔） |

### 覆盖场景

| 协议 | 编号 | 场景 |
|------|------|------|
| OpenAI | 1 | 非流式对话（含 reasoning_content / usage） |
| OpenAI | 2 | 流式对话（text + reasoning + usage chunk） |
| OpenAI | 3 | 流式工具调用（tool_calls） |
| OpenAI | 4 | 多轮工具回填（tool_calls + tool role） |
| OpenAI | 5 | thinking 参数（enabled/disabled）、reasoning_effort |
| Anthropic | 6 | 非流式对话（thinking + text blocks） |
| Anthropic | 7 | 流式对话（SSE 事件序列） |
| Anthropic | 8 | 流式工具调用（tool_use） |
| Anthropic | 9 | thinking 参数（adaptive/disabled） |
| Anthropic | 9b | temperature/top_p 与 thinking 组合规则（enabled→400 / adaptive / disabled→200，生产 bug 回归 + 规则验证） |
| Responses | 10 | 非流式对话（output_text + usage） |
| Responses | 11 | 流式对话（多模型，见上表） |
| Responses | 12 | 流式工具调用（function_call，扁平工具格式） |
| Responses | 13 | 工具调用文本化回填 |
| Responses | 14 | reasoning 参数（effort none/high） |
| Responses | 15 | 图片输入（视觉模型） |
| 公共 | 16 | 错误处理（无效模型 ID） |

## 关键发现（平台差异，插件已适配）

1. **Responses 端点工具格式与 OpenAI 不同（现存扁平化问题）**：
   - OpenAI: `{"type":"function","function":{"name","description","parameters"}}`（嵌套）
   - Responses: `{"type":"function","name","description","parameters"}`（**扁平**）
   - 如果按 OpenAI 格式传给 Responses 端点，会报：
     `InvalidParameter: The parameters, when provided as a dict, must confirm to a valid openai-compatible JSON schema. Please check the schema definition for tool`
   - 插件 `ResponsesApi.prepareRequestBody` 已使用扁平格式 ✅
   - 本测试脚本第 12/13 项使用 `FLAT_TOOLS`（扁平格式）

2. **图片尺寸限制**：部分模型要求图片 >= 10x10 像素（1x1 测试图被拒绝，报 `height:1 or width:1 must be larger than 10`）

3. **推理事件类型因模型而异**：
   - 部分模型: `response.reasoning_summary_text.delta`
   - 部分模型: `response.reasoning_text.delta`
   - 插件已兼容两种 ✅

4. **Anthropic 协议对部分模型有 bug**：部分模型（如 DeepSeek 系列）在 Anthropic 模式下强制思考 + temperature/top_p → 400"请求参数组合无效"（2026-08-06 实测，插件已修复为仅强制思考时跳过温度）。**建议优先使用 OpenAI 兼容格式**

5. **Responses 端点其他差异**：
   - 拒绝 function_call / function_call_output 内容块 → 需文本化回填 `[tool_call]` / `[tool_result]`
   - tool_choice 的具名形式（`{type:"function",name}`）返回稳定 500，插件从不发送
   - 多轮工具调用参数拼接通过 `function_call_arguments.delta/done` 事件
