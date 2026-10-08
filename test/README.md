# SenseAudio 测试脚本

> 所有测试运行前需先 `npm run compile`（除 `api-tests.mjs` 外，其余测试从 `out/` 加载编译产物）。
>
> **凭据一律从命令行参数或环境变量读取，不写入仓库**：
> `SENSEAUDIO_API_KEY` / `SENSEAUDIO_PUBLIC_KEY` / `SENSEAUDIO_TEST_BANNED_KEY` / `SENSEAUDIO_TEST_NORMAL_KEY`

## 测试清单

| 脚本 | 类型 | 说明 |
|------|------|------|
| `api-tests.mjs` | 联网 | 三协议完整测试（OpenAI / Anthropic / Responses），需真实 API Key |
| `test-plan-usage.mjs` | 离线 | **套餐用量快照**（29 项断言）：窗口归一化、百分比、超额判定、三态计费模式、倒计时、摘要格式化、真实 API 夹具回归 |
| `test-transient-retry.mjs` | 离线 | **瞬态错误分类**（23 项断言）：500 命中重试但不命中轮换（平台问题不换 key）、429/503 两者都命中、400/403 都不命中、401/402 仅轮换、`upstream_stream_error`（400）按平台侧瞬态处理 |
| `test-vision-history.mjs` | 离线 | 跨轮视觉历史编解码 + 双 API 转换器闭环（含 DeepSeek 空 reasoning_content 回归） |
| `test-anthropic-tool-result-merge.mjs` | 离线 | Anthropic 连续工具结果合并（issue #87：3 个并行 tool_use 结果合并为单条 user 消息） |
| `test-batch-import.mjs` | 离线 | **批量导入解析器**（14 项断言）：`key---credential---备注;` 格式、空字段、备注含分隔符、容错 |
| `test-cloud-sync-auto-push.mjs` | 离线 | **云同步 payload 去重**（16 项断言）：`syncPayloadHasChanged` 空值/版本/长度/逐字段/顺序分支，`undefined` 与 `""` 等价、`updatedAt` 不参与比较 |
| `test-cloud-sync-flow.mjs` | 离线 | **云同步 push/pull 集成**（22 项断言）：mock fetch + mock vscode 驱动生产 `pushToCloud`/`pullFromCloud`（新建/PATCH/短路/合并/静默/缓存失效回退/服务端时间戳回归） |
| `test-cloud-sync-e2e.mjs` | 联网 | **云同步真实端到端**（16 项断言）：真实 GitHub Gist API 驱动生产代码，验证请求体格式/响应结构/`updated_at`/内容往返；需 gist 权限凭据，无凭据时 SKIP |
| `test-banned-detect.mjs` | 离线 | 封号检测（纯逻辑模拟，无网络请求） |
| `test-banned-rotation.mjs` | 离线 | 封号轮换（纯逻辑模拟，无网络请求） |
| `test-apply-token.mjs` | 联网 | public_key 换发短期 token（`auth.senseaudio.cn`） |
| `test-model-diff.mjs` | 联网 | 内置清单 vs `/v1/models` 差异（内置清单从编译产物读取，不会脱节） |
| `test-responses-recheck.mjs` | 联网 | Responses 协议复检（工具格式扁平化 / function_call 块 / tool_choice 行为） |
| `test-vision-check.mjs` | 联网 | 视觉能力检查（生成合法 PNG 测图片输入） |

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
node test/test-batch-import.mjs
node test/test-cloud-sync-auto-push.mjs
node test/test-cloud-sync-flow.mjs
node test/test-banned-detect.mjs
node test/test-banned-rotation.mjs

# 云同步真实端到端（需 GitHub gist 权限凭据；无凭据时 SKIP 退出 0）
npm run test:e2e
# 凭据来源：GITHUB_TOKEN / GH_TOKEN 环境变量，或 `gh auth token`

# 联网测试（需 API Key，从参数或环境变量读取）
node test/api-tests.mjs <API_KEY> [openai|anthropic|responses|all]
SENSEAUDIO_API_KEY=<key> node test/test-model-diff.mjs
SENSEAUDIO_API_KEY=<key> node test/test-vision-check.mjs [MODEL_ID]
SENSEAUDIO_API_KEY=<key> node test/test-responses-recheck.mjs
SENSEAUDIO_PUBLIC_KEY=<pub-key> node test/test-apply-token.mjs
```

---

## `api-tests.mjs` 详情

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
