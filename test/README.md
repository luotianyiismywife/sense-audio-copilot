# SenseAudio 测试脚本

> 所有测试运行前需先 `npm run compile`（除 `api-tests.mjs` 外，其余测试从 `out/` 加载编译产物）。

## 测试清单

| 脚本 | 类型 | 说明 |
|------|------|------|
| `api-tests.mjs` | 联网 | 三协议完整测试（OpenAI / Anthropic / Responses），需真实 API Key |
| `test-plan-usage.mjs` | 离线 | **套餐用量快照**（29 项断言）：窗口归一化、百分比、超额判定、三态计费模式、倒计时、摘要格式化、真实 API 夹具回归 |
| `test-transient-retry.mjs` | 离线 | **瞬态错误分类**（13 项断言）：500 命中重试但不命中轮换（平台问题不换 key）、429/503 两者都命中、400/403 都不命中、401/402 仅轮换 |
| `test-vision-history.mjs` | 离线 | 跨轮视觉历史编解码 + 双 API 转换器闭环（含 DeepSeek 空 reasoning_content 回归） |
| `test-anthropic-tool-result-merge.mjs` | 离线 | Anthropic 连续工具结果合并（issue #87：3 个并行 tool_use 结果合并为单条 user 消息） |
| `test-apply-token.mjs` | 联网 | 令牌应用测试 |
| `test-banned-detect.mjs` | 联网 | 封号检测测试 |
| `test-banned-rotation.mjs` | 联网 | 封号轮换测试 |
| `test-model-diff.mjs` | 联网 | 模型差异测试 |
| `test-responses-recheck.mjs` | 联网 | Responses 协议复检 |
| `test-vision-check.mjs` | 联网 | 视觉能力检查 |

## 运行

```bash
npm run compile

# 离线测试（无需 API Key）
node test/test-plan-usage.mjs
node test/test-transient-retry.mjs
node test/test-vision-history.mjs
node test/test-anthropic-tool-result-merge.mjs

# 联网测试（需 API Key）
node test/api-tests.mjs <API_KEY> [openai|anthropic|responses|all]
```

---

## `api-tests.mjs` 详情

三协议完整测试脚本，用于验证 SenseAudio 平台 API 的兼容性。

- `<API_KEY>`: SenseAudio API key（`sk_tr_...`）
- filter 可选: `openai` | `anthropic` | `responses` | `all`（默认 `all`）

### 覆盖场景

| 协议 | 编号 | 场景 |
|------|------|------|
| OpenAI | 1 | 非流式对话（含 reasoning_content / usage） |
| OpenAI | 2 | 流式对话（text + reasoning + usage chunk） |
| OpenAI | 3 | 流式工具调用（tool_calls） |
| OpenAI | 4 | 多轮工具回填（tool_calls + tool role） |
| OpenAI | 5 | thinking 参数（enabled/disabled）、GLM reasoning_effort |
| Anthropic | 6 | 非流式对话（thinking + text blocks） |
| Anthropic | 7 | 流式对话（SSE 事件序列） |
| Anthropic | 8 | 流式工具调用（tool_use） |
| Anthropic | 9 | thinking 参数（adaptive/disabled） |
| Anthropic | 9b | temperature/top_p 与 thinking 组合规则（enabled→400 / adaptive / disabled→200，生产 bug 回归 + 规则验证） |
| Responses | 10 | 非流式对话（output_text + usage） |
| Responses | 11 | 流式对话（三模型：qwen3.7-max / deepseek-v4-flash-0731 / qwen3.8-max） |
| Responses | 12 | 流式工具调用（function_call，扁平工具格式） |
| Responses | 13 | 工具调用文本化回填 |
| Responses | 14 | reasoning 参数（effort none/high） |
| Responses | 15 | 图片输入（qwen3.8-max） |
| 公共 | 16 | 错误处理（无效模型 / 协议不支持的模型） |

## 2026-08-03 实测结果

| 部分 | 结果 |
|------|------|
| OpenAI | ✅ 13/13 通过 |
| Anthropic | ✅ 13/13 通过 |
| Responses | ✅ 18+6 通过（修正工具格式后全通过） |

## 关键发现（平台差异，插件已适配）

1. **Responses 端点工具格式与 OpenAI 不同（现存扁平化问题）**：
   - OpenAI: `{"type":"function","function":{"name","description","parameters"}}`（嵌套）
   - Responses: `{"type":"function","name","description","parameters"}`（**扁平**）
   - 如果按 OpenAI 格式传给 Responses 端点，会报：
     `InvalidParameter: The parameters, when provided as a dict, must confirm to a valid openai-compatible JSON schema. Please check the schema definition for tool`
   - 插件 `ResponsesApi.prepareRequestBody` 已使用扁平格式 ✅
   - 本测试脚本第 12/13 项使用 `FLAT_TOOLS`（扁平格式）

2. **qwen3.8-max 图片限制**：图片尺寸必须 >= 10x10 像素（1x1 测试图被拒绝，报 `height:1 or width:1 must be larger than 10`）

3. **推理事件类型因模型而异**：
   - qwen3.7-max / qwen3.8-max: `response.reasoning_summary_text.delta`
   - deepseek-v4-flash-0731: `response.reasoning_text.delta`
   - 插件已兼容两种 ✅

4. **Anthropic 协议非全量且部分模型有 bug**：qwen3.7-max、kimi-k2.7-code 不支持（supports_anthropic=false）；部分模型（如 DeepSeek 系列）在 Anthropic 模式下强制思考 + temperature/top_p → 400"请求参数组合无效"（2026-08-06 实测，插件已修复为仅强制思考时跳过温度）。**建议优先使用 OpenAI 兼容格式**

5. **Responses 端点其他差异**：
   - 拒绝 function_call / function_call_output 内容块 → 需文本化回填 `[tool_call]` / `[tool_result]`
   - tool_choice 仅接受 `auto` / `none`（`required`/对象形式在思考模式下被拒）
   - 多轮工具调用参数拼接通过 `function_call_arguments.delta/done` 事件
