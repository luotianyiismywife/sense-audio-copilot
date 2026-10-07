<div align="center">

# SenseAudio Provider for Copilot

[English](#english) | [中文](#中文)

</div>

## English

> [!IMPORTANT]
> **This is not affiliated with, officially maintained by, or endorsed by SenseAudio.**

> [!TIP]
> **API keys available from the author.** The author sells SenseAudio API keys. Note that the SenseAudio platform does **not** support prompt cache hits, so your quota is consumed at full input-token cost on every request — it doesn't last as long as cache-enabled platforms.

Integrate [SenseAudio](https://senseaudio.cn) models into GitHub Copilot Chat as a VS Code extension.

### Usage

1. **Set API Key**: `Ctrl+Shift+P` → `SenseAudio: Manage API Keys`
2. **Show Models**: Click the settings icon in the model picker → **Language Models** panel → set your desired models to Visible
3. **Select Model**: In the Copilot Chat bottom model picker, choose a "SenseAudio" model
4. **Start chatting**

### Status Bar: Plan Usage & Token Indicator

Once installed, the status bar shows your **SenseAudio plan usage** for the current 5-hour window (e.g. `5H 65%`, or `--` before the first fetch). Hover the status bar item to see:

- **Plan usage**: 5-hour / weekly / monthly utilization (with absolute credits, e.g. `5H——65% (6,500 / 10,000 积分)`), the 5-hour reset countdown, and the current billing mode.
- **Balance**: cash balance plus gift vouchers (with the earliest expiry date).
- **Token usage**: cumulative input/output token counts, plus the cumulative cache hit count and cache hit rate for models that return cache metrics in an OpenAI-compatible format.

When the monthly plan quota is exhausted, the main text switches to the balance (e.g. `余额 ¥358.78`) so you can tell at a glance that you are now being billed from your balance.

Click the status bar item to refresh immediately.

> [!IMPORTANT]
> **Two separate billing rules** (see the [official docs](https://docs.senseaudio.cn/guides/account/token-plan)):
> - **Period quotas (5h / weekly) are rate-limit windows.** When exhausted, they simply wait for the next period to reset — they **do not consume your balance**.
> - **Plan credits (monthly) are the subscription quota.** When exhausted, the overage policy applies: if balance auto-pay is enabled, the overage is billed per-use (vouchers → cash); otherwise the account **downgrades to the Free plan**.

The status bar only appears while you are actually using a SenseAudio model: it stays hidden on startup and when other chat model providers are in use, and auto-hides after 60 seconds of inactivity.

Relevant settings: `senseaudio.showUsageInStatusBar` (default `true`), `senseaudio.showUsageInTooltip` (default `true`), `senseaudio.usageRefreshInterval` (default 5 minutes), and `senseaudio.enableThirdPartyTokenIndicator` (default `false` — controls only the advanced token counter; the plan-usage display is independent).

> [!NOTE]
> Whether non-DeepSeek models display cache data depends on whether the model API returns cache metrics in an OpenAI-compatible format. This does not indicate whether the model supports caching — caching support depends on SenseAudio.

### Git Commit Messages

Click the **magic wand** button in the Source Control (SCM) panel to auto-generate a commit message.

You can configure the model, language, number of recent commits to reference, and whether to attach context files.

### Model Temperature Presets

Switch temperature presets via the `senseaudio.modelPreset` setting (or set `senseaudio.temperature` / `senseaudio.top_p` directly with `senseaudio.modelPreset` set to `"custom"`).

Built-in presets:

| Preset | Temperature |
|--------|-------------|
| Precise | 0.0 |
| Balanced | 1.0 |
| Creative | 1.2 |
| Extra Creative | 1.7 |

You can also configure `senseaudio.temperature` and `senseaudio.top_p` directly in `settings.json` (requires `senseaudio.modelPreset` set to `"custom"`).

### Extended Vision Understanding

This extension adds **extended vision understanding** capability to **text-only models** that do not natively support vision. When you send a message with an image to these models, they can call a vision-capable model to describe the image, and then answer based on that description.

You can configure the default vision model and whether to enable thinking when describing images. By default, `qwen3.6-35b-a3b` is used to describe images. Set `senseaudio.visionProxyModel` to any vision-capable model ID (e.g. `qwen3.6-35b-a3b`, `qwen3.8-27b`, `deepseek-v4.1-flash`, `glm-5.3-flash`).

> **Scope note — how images reach the vision proxy**: the `ask_image` proxy applies to images **you paste/attach manually into the chat** (the extension declares `imageInput: true` so VS Code forwards image data to it, and non-vision models delegate to the vision proxy model). It does **not** apply to screenshots taken by VS Code's **built-in screenshot tool** (e.g. in agent mode) — screenshot analysis is handled internally by the Copilot Chat framework using GitHub Copilot's own vision models, which is outside a third-party provider's control. If your Copilot plan's vision model is unavailable, the built-in screenshot tool reports "vision model query unavailable"; this does **not** affect manual image pasting, which still works through the extension's proxy.

### Model List

The extension ships with built-in definitions for the following SenseAudio chat models (verified against the live `/v1/models` endpoint on 2026-09-29; specs from the [model page](https://docs.senseaudio.cn/guides/account/model-list)):

| Model ID | Context | Max Output | Vision |
|----------|---------|-----------|--------|
| `senseaudio-s2` | 1M | 128K | ❌ |
| `senseaudio-s2-flash` | 256K | 64K | ❌ |
| `senseaudio-s2-lite` | 256K | 64K | ❌ |
| `sensenova-6.8-flash-lite`¹ | 256K | 64K | ❌ |
| `qwen3.8-27b` | 256K | 32K | ✅ |
| `qwen3.6-35b-a3b` | 256K | 64K | ✅ |
| `deepseek-v4.1-flash` | 1M | 384K | ✅ |
| `deepseek-v4-flash-0731` | 1M | 384K | ❌ |
| `glm-5.3-flash` | 1M | 128K | ✅ |

> ¹ The official docs table lists `—` for every spec of this model, and it is absent from models.dev / OpenRouter. 256K / 64K is assumed (same class as S2-Flash/Lite); revisit if the platform publishes real values.

> All models support the OpenAI-compatible protocol. Protocol capability (Responses / Anthropic) is **detected dynamically** at startup from `GET /v1/models` — no model IDs are hardcoded. In `auto` mode, priority: Responses (if `enableResponsesApi` enabled) > Anthropic (if `enableAnthropicApi` enabled) > OpenAI.
> [!WARNING]
> The Anthropic protocol has compatibility issues with some models (e.g. DeepSeek: forced thinking + temperature/top_p returns 400 "请求参数组合无效"). **The OpenAI-compatible format is recommended**; use Anthropic only when you specifically need the native Messages format.

> [!TIP]
> Automatic model discovery is enabled by default: the extension fetches the live model list from `GET /v1/models` and hides models that are not available on your account. Image-generation models (`senseaudio-image-2.0`, `doubao-seedream-5-0`, `sensenova-u1-fast`) are excluded from the picker.

### Configuration

Available in `settings.json`:

```json
{
  "senseaudio.apiMode": "auto",
  "senseaudio.commitLanguage": "auto",
  "senseaudio.commitModel": "glm-5.3-flash",
  "senseaudio.commitMessagePrompt": "",
  "senseaudio.requestTimeout": 600000,
  "senseaudio.recentCommitsCount": 10,
  "senseaudio.commitIncludeCommitDiff": false,
  "senseaudio.commitAttachContextFiles": true,
  "senseaudio.enableAutoModelDiscovery": true,
  "senseaudio.syncModelsOnStartup": true,
  "senseaudio.maxInputTokensRatio": 1.0,
  "senseaudio.enableThirdPartyTokenIndicator": true,
  "senseaudio.enableResponsesApi": false,
  "senseaudio.enableAnthropicApi": false
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `senseaudio.commitLanguage` | `auto` | Language for Git commit messages. When set to `auto`, the language is detected from recent commit history (defaults to English if no history exists). |
| `senseaudio.commitModel` | `glm-5.3-flash` | Model ID used for commit message generation. |
| `senseaudio.commitMessagePrompt` | `""` | Custom system prompt for commit message generation. |
| `senseaudio.requestTimeout` | `600000` | Maximum time (ms) for a single API request. Default is 600000 (10 minutes). Increase if long responses time out. |
| `senseaudio.recentCommitsCount` | `10` | Number of recent commits to analyze for style reference when generating commit messages. Set to 0 to disable. |
| `senseaudio.commitIncludeCommitDiff` | `false` | Include the actual code changes (diff) of recent commits in the style reference, helping the model generate messages that better match the project's commit style. |
| `senseaudio.commitAttachContextFiles` | `true` | Attach the content of AGENTS.md and README.md from the repository root as additional context for commit message generation, helping the model better understand the project. |
| `senseaudio.visionProxyModel` | `qwen3.6-35b-a3b` | Vision model used by the `ask_image` tool when the selected model does not support vision. |
| `senseaudio.visionProxyThinking` | `false` | Enable thinking/reasoning in the vision proxy model when answering image queries. |
| `senseaudio.enableAutoModelDiscovery` | `true` | Automatically fetch the live model list from `GET /v1/models` and hide models unavailable on your account. |
| `senseaudio.syncModelsOnStartup` | `true` | Check for new SenseAudio models on startup, at most once per day. Sync results are reported as a single line in the "SenseAudio" Output channel. |
| `senseaudio.maxInputTokensRatio` | `1.0` | Ratio of the real context window declared as `maxInputTokens` (0.1 - 1.0). VS Code's agent auto-compaction triggers at ~90% of the declared value. **Recommended: 0.8** so compaction fires at ~72% of the real window, preventing context overflow on large-window BYOK models. The `context_length` sent in API requests always uses the real value. |
| `senseaudio.enableThirdPartyTokenIndicator` | `false` | Show the advanced token counter in the status bar while using SenseAudio models. The plan-usage display is independent of this setting. |
| `senseaudio.showUsageInStatusBar` | `true` | Show the plan usage (5-hour window percentage) in the status bar main text. When disabled, the status bar shows token counts instead. |
| `senseaudio.showUsageInTooltip` | `true` | Show the plan usage section (5-hour / weekly / monthly windows, reset countdown and balance) in the status bar tooltip. |
| `senseaudio.usageRefreshInterval` | `5` | Background plan-usage refresh interval in minutes (1-60). |
| `senseaudio.minBalanceCny` | `0` | Balance threshold (CNY). Total available balance (cash + vouchers) at or below this value is flagged with an error icon in the API key manager. |
| `senseaudio.balanceCheckIntervalSec` | `60` | Cache TTL (seconds) for the account info / plan usage query. 0 = always re-fetch. |
| `senseaudio.delay` | `0` | Minimum delay (ms) between consecutive API requests. 0 = no delay. |
| `senseaudio.readFileLines` | `0` | Auto-expand `read_file` ranges to at least this many lines when the model omits an explicit range. 0 = disabled. |
| `senseaudio.visionMaxRounds` | `5` | Maximum `ask_image` vision-proxy rounds per request (1-20). |
| `senseaudio.apiKeyMode` | `sticky` | Multi-key strategy: `sticky` (pin one key, switch only when it fails), `rotation` (round-robin), `single` (use only the current key). |
| `senseaudio.singleKeyFallback` | `switch` | In `single` mode, whether to auto-switch to another key when the current one is out of balance (`switch`) or always error (`error`). |
| `senseaudio.apiKeyRotationStatusCodes` | `[401, 402, 429, 503]` | HTTP status codes that mark a key as failed and rotate to the next one. |
| `senseaudio.transientRetryStatusCodes` | `[429, 500, 503]` | HTTP status codes treated as transient platform errors that trigger whole-round auto-retry. Codes that also appear in `apiKeyRotationStatusCodes` (429/503) mark the key as cooling and rotate; codes that do not (500) leave the key untouched and retry the same key — a 500 is a platform problem, not a key problem. |
| `senseaudio.transientRetryTimes` | `3` | How many times to auto-retry the whole round when every key fails with a transient error. Exponential backoff (2s/4s/8s). 0 = disable. |
| `senseaudio.apiKeyExhaustedCooldownMin` | `10` | Cooldown (minutes) for transiently exhausted keys before they can be reused. 0 = immediately reusable. |
| `senseaudio.enableResponsesApi` | `false` | Use the Responses API protocol in `auto` mode for models detected as supports_responses=true at startup (from `GET /v1/models` — dynamic, no hardcoded model IDs). **Disabled by default**: the SenseAudio Responses endpoint is still evolving (inconsistent stream event types across models, unstable tool calling, non-standard multi-round tool backfill), so models fall back to the more mature OpenAI-compatible format. Enable only to try the Responses protocol. |
| `senseaudio.enableAnthropicApi` | `false` | Use the Anthropic Messages protocol in `auto` mode for models detected as supports_anthropic=true at startup (dynamic, no hardcoded model IDs). **Disabled by default** — the Anthropic endpoint has compatibility issues with some models (e.g. DeepSeek), the more mature OpenAI-compatible format is recommended. In auto mode, priority: Responses (if enabled) > Anthropic > OpenAI. |
| `senseaudio.apiMode` | `auto` | API protocol for requests: `auto` (follow each model's default; models with supports_responses=true use the Responses API automatically), `openai` (force OpenAI format), `anthropic` (force Anthropic format — note some models have compatibility issues, e.g. DeepSeek thinking + temperature → 400; OpenAI is recommended), or `responses` (force Responses API). Applies to both chat and Git commit generation. **Also filters the model picker**: in `anthropic` mode only supports_anthropic=true models are listed, in `responses` mode only supports_responses=true models are listed, `auto`/`openai` list all. Switching this setting updates the picker **live without reloading the window**. |

> [!NOTE]
> Models with switchable thinking (e.g., DeepSeek, Qwen) provide reasoning effort levels such as `Disabled`/`High`/`Maximum`.

### Build

```bash
npm install
npm run compile
npm run build      # packages extension.vsix
```

### License

AGPL-3.0 License. This project builds upon the architecture of [opencode-go-copilot](https://github.com/OnesoftQwQ/opencode-go-copilot) (MIT) and [oai-compatible-copilot](https://github.com/JohnnyZ93/oai-compatible-copilot) (MIT).

---

## 中文

> [!IMPORTANT]
> **本插件与 SenseAudio 无关，也未获得其官方维护或认可。**

> [!TIP]
> **作者有售 API Key。** 作者出售 SenseAudio API Key。注意：SenseAudio 平台**不支持缓存命中**（prompt cache），每次请求都按完整输入 Token 计费，额度不如支持缓存的平台耐用。

将 [SenseAudio](https://senseaudio.cn) 模型集成到 GitHub Copilot Chat 的 VS Code 插件。

### 使用

1. **设置 API Key**：`Ctrl+Shift+P` → `SenseAudio: 管理 API Keys`
2. **显示模型**：在模型选择器中点击设置图标 → **语言模型** 面板 → 将需要使用的模型显示
3. **选择模型**：在 Copilot Chat 底部模型选择器中选择 "SenseAudio" 下的模型
4. **开始对话**

### 状态栏：套餐用量与 Token 指示器

安装后，使用 SenseAudio 提供的模型时，状态栏会显示**套餐当前 5 小时窗口的用量**（如 `5H 65%`，首次获取前显示 `--`）。悬停状态栏条目可查看：

- **套餐用量**：5 小时 / 周 / 月三个窗口的使用率（含绝对积分，如 `5H——65% (6,500 / 10,000 积分)`）、5 小时窗口的重置倒计时，以及当前计费模式。
- **余额**：现金余额 + 代金券（含最早到期日）。
- **Token 用量**：累计输入/输出 Token 量；当模型接口以 OpenAI 兼容格式返回缓存数据时，还会显示**累计缓存命中量**与**缓存命中率**。

当**月度套餐额度**耗尽时，主文本会切换为余额（如 `余额 ¥358.78`），一眼即可看出已开始从余额扣费。

点击状态栏条目可立即刷新。

> [!IMPORTANT]
> **两套计费规则相互独立**（详见[官方文档](https://docs.senseaudio.cn/guides/account/token-plan)）：
> - **周期额度（5 小时 / 周）是限流窗口**。耗尽后只需等待下一周期自动恢复，**不会消耗余额**。
> - **套餐积分（月度）才是订阅额度**。耗尽后走超额策略：若已开启余额自动支付，超出部分按量计费（代金券 → 现金余额）；否则账号**降级至 Free 版**。

状态栏**仅在您实际使用 SenseAudio 模型时显示**：启动时隐藏、使用其他模型提供商的模型时不显示，停止使用（空闲 60 秒）后自动隐藏。

相关设置：`senseaudio.showUsageInStatusBar`（默认 `true`）、`senseaudio.showUsageInTooltip`（默认 `true`）、`senseaudio.usageRefreshInterval`（默认 5 分钟）、`senseaudio.enableThirdPartyTokenIndicator`（默认 `false`，仅控制高级 Token 计数器，与套餐用量显示相互独立）。

> [!NOTE]
> 非 DeepSeek 的模型是否显示缓存数据取决于模型接口是否通过 OpenAI 格式返回缓存数据，这并不代表此模型是否支持缓存。模型对于缓存的支持情况取决于 SenseAudio。

### Git 提交消息

在源代码管理（SCM）面板中点击魔法棒按钮，自动生成 Git 提交消息。

可在配置里配置使用的模型、语言、参考的最近提交数量以及是否附加上下文文件。

### 扩展视觉理解

本插件为**不支持视觉理解**的**纯文本模型**添加了**扩展视觉理解**功能，当你向这些模型发送带有图片的信息时，他们可以调用支持视觉理解的模型为图片输出描述，然后再回答。

通过配置文件可更改默认使用的模型以及是否在描述图片时启用思考。默认情况下，将使用 `qwen3.6-35b-a3b` 描述图片。将 `senseaudio.visionProxyModel` 设为任意支持视觉的模型 ID（如 `qwen3.6-35b-a3b`、`qwen3.8-27b`、`deepseek-v4.1-flash`、`glm-5.3-flash`）即可。

> **适用范围说明 —— 图片如何到达视觉代理**：`ask_image` 代理作用于**你在聊天中手动粘贴/附带**的图片（扩展声明 `imageInput: true`，VS Code 会将图片数据传给扩展，非视觉模型再委托给视觉代理模型）。它**不覆盖** VS Code **内置截图工具**拍摄的截图（如 agent 模式下的截图）——截图分析由 Copilot Chat 框架内部使用 GitHub Copilot 自带的视觉模型完成，第三方提供商无法接管。如果你的 Copilot 套餐的视觉模型不可用，内置截图工具会提示"视觉模型查询暂不可用"；这**不影响**手动粘贴图片，后者仍会通过扩展的代理正常工作。

### 模型列表

扩展内置了以下 SenseAudio Chat 模型定义（2026-09-29 对照实时 `/v1/models` 核实；规格取自[模型页](https://docs.senseaudio.cn/guides/account/model-list)）：

| 模型 ID | 上下文 | 最大输出 | 视觉 |
|---------|--------|---------|------|
| `senseaudio-s2` | 1M | 128K | ❌ |
| `senseaudio-s2-flash` | 256K | 64K | ❌ |
| `senseaudio-s2-lite` | 256K | 64K | ❌ |
| `sensenova-6.8-flash-lite`¹ | 256K | 64K | ❌ |
| `qwen3.8-27b` | 256K | 32K | ✅ |
| `qwen3.6-35b-a3b` | 256K | 64K | ✅ |
| `deepseek-v4.1-flash` | 1M | 384K | ✅ |
| `deepseek-v4-flash-0731` | 1M | 384K | ❌ |
| `glm-5.3-flash` | 1M | 128K | ✅ |

> ¹ 官方文档对该模型的所有规格列均为 `—`，且 models.dev / OpenRouter 均未收录；暂按同类模型（S2-Flash/Lite）假定 256K / 64K，待平台公布真实值后修正。

> 所有模型均支持 OpenAI 兼容协议。协议能力（Responses / Anthropic）在启动时从 `GET /v1/models` **动态探测**——不硬编码模型 ID。auto 模式下优先级：Responses（若开启 `enableResponsesApi`）> Anthropic（若开启 `enableAnthropicApi`）> OpenAI。
> [!WARNING]
> Anthropic 协议对部分模型存在兼容性问题（如 DeepSeek：强制思考 + temperature/top_p 返回 400"请求参数组合无效"）。**建议优先使用 OpenAI 兼容格式**；仅在明确需要 Anthropic 原生 Messages 格式时使用。

> [!TIP]
> 自动模型发现默认开启：扩展会从 `GET /v1/models` 拉取实时模型列表，隐藏你账号下不可用的模型。图片生成模型（`senseaudio-image-2.0`、`doubao-seedream-5-0`、`sensenova-u1-fast`）不会出现在选择器中。

### 调整模型温度

通过 `senseaudio.modelPreset` 设置切换温度预设（也可将 `senseaudio.modelPreset` 设为 `"custom"` 后直接配置 `senseaudio.temperature` / `senseaudio.top_p`）。

内置 4 个预设档位：

| 档位 | 温度 |
|------|------|
| 精确 | 0.0 |
| 均衡 | 1.0 |
| 创意 | 1.2 |
| 极具创意 | 1.7 |

也可在 `settings.json` 中直接配置 `senseaudio.temperature` 和 `senseaudio.top_p`（需将 `senseaudio.modelPreset` 设为 `"custom"`）。

### 配置

可在 `settings.json` 中配置：

```json
{
  "senseaudio.apiMode": "auto",
  "senseaudio.commitLanguage": "auto",
  "senseaudio.commitModel": "glm-5.3-flash",
  "senseaudio.commitMessagePrompt": "",
  "senseaudio.requestTimeout": 600000,
  "senseaudio.recentCommitsCount": 10,
  "senseaudio.commitIncludeCommitDiff": false,
  "senseaudio.commitAttachContextFiles": true,
  "senseaudio.enableAutoModelDiscovery": true,
  "senseaudio.syncModelsOnStartup": true,
  "senseaudio.maxInputTokensRatio": 1.0,
  "senseaudio.enableThirdPartyTokenIndicator": false,
  "senseaudio.showUsageInStatusBar": true,
  "senseaudio.showUsageInTooltip": true,
  "senseaudio.usageRefreshInterval": 5,
  "senseaudio.enableResponsesApi": false,
  "senseaudio.enableAnthropicApi": false
}
```

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `senseaudio.commitLanguage` | `auto` | 提交消息语言。设为 `auto` 时将根据历史提交自动检测语言（无历史时默认英语）。 |
| `senseaudio.commitModel` | `glm-5.3-flash` | 用于生成提交消息的模型。 |
| `senseaudio.commitMessagePrompt` | `""` | 生成提交消息的自定义系统提示词。 |
| `senseaudio.requestTimeout` | `600000` | 单个 API 请求的最大等待时间（毫秒）。默认 600000（10 分钟）。生成长内容超时时可增大此值。 |
| `senseaudio.recentCommitsCount` | `10` | 生成提交消息时参考的近期提交数量，用于学习仓库提交风格。设为 0 可禁用。 |
| `senseaudio.commitIncludeCommitDiff` | `false` | 在风格参考中包含历史提交的实际代码变更（diff），帮助模型生成更符合项目提交风格的消息。 |
| `senseaudio.commitAttachContextFiles` | `true` | 将仓库根目录的 AGENTS.md 和 README.md 作为额外上下文附加到提交消息生成中，帮助模型更好地理解项目。 |
| `senseaudio.visionProxyModel` | `qwen3.6-35b-a3b` | 用于 ask_image 工具的视觉模型 ID。当所选模型不支持视觉时，该模型用于回答图片相关问题。 |
| `senseaudio.visionProxyThinking` | `false` | 在视觉代理模型回答图片查询时启用思考/推理功能。 |
| `senseaudio.enableAutoModelDiscovery` | `true` | 自动从 `GET /v1/models` 拉取实时模型列表，隐藏你账号下不可用的模型。 |
| `senseaudio.syncModelsOnStartup` | `true` | 启动时自动检查是否有新的 SenseAudio 模型（每日最多一次）。同步结果以一行日志输出到「SenseAudio」输出通道。 |
| `senseaudio.maxInputTokensRatio` | `1.0` | 每个模型声明为 `maxInputTokens` 的真实上下文窗口比例（0.1 - 1.0）。VS Code 的 agent 自动压缩约在声明的 maxInputTokens 的 90% 处触发。**建议设为 0.8** —— 可使压缩在真实窗口约 72% 处触发，防止 BYOK 大窗口模型上下文溢出。API 请求体中的 context_length 始终使用真实值。 |
| `senseaudio.enableThirdPartyTokenIndicator` | `false` | 使用 SenseAudio 模型时在状态栏显示高级 Token 计数器。套餐用量显示与此设置相互独立。 |
| `senseaudio.showUsageInStatusBar` | `true` | 在状态栏主文本显示套餐用量（5 小时窗口百分比）。关闭后状态栏改显 Token 计数。 |
| `senseaudio.showUsageInTooltip` | `true` | 在状态栏悬停提示中显示套餐用量区块（5 小时 / 周 / 月三窗口、重置倒计时与余额）。 |
| `senseaudio.usageRefreshInterval` | `5` | 后台套餐用量刷新间隔（分钟，1-60）。 |
| `senseaudio.minBalanceCny` | `0` | 余额阈值（元）。合计可用余额（现金 + 代金券）≤ 该值时在 API Key 管理界面以错误图标标记。 |
| `senseaudio.balanceCheckIntervalSec` | `60` | 账号信息 / 套餐用量查询的缓存 TTL（秒）。0 = 每次重新拉取。 |
| `senseaudio.delay` | `0` | 连续 API 请求之间的最小间隔（毫秒）。0 = 不延迟。 |
| `senseaudio.readFileLines` | `0` | 模型调用 `read_file` 未指定范围时，自动扩展到至少这么多行。0 = 禁用。 |
| `senseaudio.visionMaxRounds` | `5` | 单次请求中 `ask_image` 视觉代理的最大轮数（1-20）。 |
| `senseaudio.apiKeyMode` | `sticky` | 多 Key 策略：`sticky`（固定一个 key，仅失效时切换）、`rotation`（轮询）、`single`（仅用当前 key）。 |
| `senseaudio.singleKeyFallback` | `switch` | `single` 模式下当前 key 余额不足时是否自动切换（`switch`）或直接报错（`error`）。 |
| `senseaudio.apiKeyRotationStatusCodes` | `[401, 402, 429, 503]` | 标记 key 失效并轮换到下一个 key 的 HTTP 状态码。 |
| `senseaudio.transientRetryStatusCodes` | `[429, 500, 503]` | 视为瞬态平台错误、触发整轮自动重试的 HTTP 状态码。**同时**出现在 `apiKeyRotationStatusCodes` 中的（429/503）会标记 key 冷却并换 key；**未**出现的（500）不标记 key、不换 key，仅重试同一个 key——500 是平台问题而非 key 问题。 |
| `senseaudio.transientRetryTimes` | `3` | 全部 key 因瞬态错误失败时自动重试整轮的次数。指数退避（2s/4s/8s）。0 = 禁用。 |
| `senseaudio.apiKeyExhaustedCooldownMin` | `10` | 瞬态失效 key 在可被再次使用前的冷却时长（分钟）。0 = 立即恢复。 |
| `senseaudio.enableResponsesApi` | `false` | 当 `apiMode` 为 `auto` 时，为启动时探测到 supports_responses=true 的模型（来自 `GET /v1/models`——动态探测，不硬编码模型 ID）使用 Responses 协议。**默认关闭**：SenseAudio 的 Responses 端点仍在演进中（不同模型流式事件类型不一致、工具调用不稳定、多轮工具回填非常规），默认回退到更成熟的 OpenAI 兼容格式。仅在希望尝试 Responses 协议时开启。 |
| `senseaudio.enableAnthropicApi` | `false` | 当 `apiMode` 为 `auto` 时，为启动时探测到 supports_anthropic=true 的模型（动态探测，不硬编码模型 ID）使用 Anthropic Messages 协议。**默认关闭** —— Anthropic 端点对部分模型存在兼容性问题（如 DeepSeek），建议使用更成熟的 OpenAI 兼容格式。auto 模式下优先级：Responses（若开启）> Anthropic > OpenAI。 |
| `senseaudio.apiMode` | `auto` | 请求使用的 API 协议：`auto`（跟随各模型默认格式；supports_responses=true 的模型自动使用 Responses API）、`openai`（强制 OpenAI 格式）、`anthropic`（强制 Anthropic 格式——注意部分模型存在兼容性问题，如 DeepSeek 强制思考 + temperature → 400，建议使用 OpenAI）、`responses`（强制 Responses API 格式）。对聊天请求和 Git 提交消息生成均生效。**同时过滤模型选择器**：`anthropic` 模式仅列出 supports_anthropic=true 的模型，`responses` 模式仅列出 supports_responses=true 的模型，`auto`/`openai` 列出全部。切换该设置后模型选择器**即时刷新，无需 reload 窗口**。 |

> [!NOTE]
> 支持切换思考模式的模型（如 DeepSeek、Qwen）提供`禁用思考`/`高`/`极高`等推理强度选项。

### 编译

```bash
npm install
npm run compile
npm run build      # 打包为 extension.vsix
```

### 许可

AGPL-3.0 许可。本项目基于 [opencode-go-copilot](https://github.com/OnesoftQwQ/opencode-go-copilot)（MIT）与 [oai-compatible-copilot](https://github.com/JohnnyZ93/oai-compatible-copilot)（MIT）的架构实现。
