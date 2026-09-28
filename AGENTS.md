# SenseAudio Copilot Provider — AGENTS.md

> **所有更改必须通过 `npm run compile` / `npx tsc --noEmit` 编译检查无错误通过。**  
> **每次更改后，必须同步更新本文档 (`AGENTS.md`) 以反映代码变更。**

---

## 目录

1. [项目详细介绍](#1-项目详细介绍)
2. [详细逻辑架构](#2-详细逻辑架构)
3. [程序文件索引](#3-程序文件索引)
4. [函数定义大全](#4-函数定义大全)
5. [编译与构建](#5-编译与构建)
6. [开发规范](#6-开发规范)

---

## 1. 项目详细介绍

### 1.1 概述

**SenseAudio Copilot Provider** 是一个 VS Code 扩展，它将 SenseAudio 平台的 AI 语言模型集成到 GitHub Copilot Chat 中。用户可以在 VS Code 的 Copilot Chat 界面中选择并使用 SenseAudio 提供的各种模型（如 DeepSeek、GLM、Qwen、MiMo、MiniMax、Kimi 等系列），享受智能代码补全、聊天对话、Git 提交消息生成等功能。

### 1.2 核心能力

| 能力 | 说明 |
|------|------|
| **Chat 模型提供商** | 实现 `LanguageModelChatProvider` 接口，向 VS Code 注册为 `senseaudio` 厂商 |
| **多 API Key 轮询** | 支持多个 API Key（SecretStorage 加密存储 `senseaudio.apiKeys`），三种模式：`sticky`（默认，固定使用一个 key，仅失效时切下一个并钉住——前缀缓存命中率最高，切换后不自动切回）/ `rotation`（轮询使用、跳过不可用 key）/ `single`（仅用当前 key；`senseaudio.singleKeyFallback`（默认 `switch`）下**仅在余额不足（402）时**自动切换到下一个可用 key 并经 `setActiveKeyByValue` 设为当前使用 + 右下角弹窗提示——401 无效 Key / 429 限流 / 503 繁忙等其他错误不切换、走 single 专属报错文案；`error` 下任何错误都直接报错不切换）。**被动检测**：按请求错误（402 余额不足 / 401 无效 Key / 429 限流 / 503 服务端繁忙，状态码与文本 patterns 均可配置）判定 key 失效并切换——**402/401 持久化 `available=false`（确定性），429/503 仅内存冷却不持久化（瞬态，冷却到期自动恢复）**。**手动检测**：`senseaudio.manageApiKeys` 命令 QuickPick 管理（增删/设为当前/绑定 cookie/重置失效/检测可用性——最小真实聊天请求 `say ok`，实测余额不足时 402 拦截不耗 token）。**UI 增强**：表单式批量导入（三元组 key/cookie/备注，逐条输入）、检测二级界面（列出全部 key 状态 + "检测所有"选项）、编辑 API Key（三字段 value/cookie/label，冲突校验）、**轮询模式下隐藏"设为当前使用"**（★ Current 标记与动作项均仅 single 模式显示）、批量导入时已存在 key 自动更新 cookie 不重复添加、**所有 key 管理界面（主界面 / 检测二级界面 / 删除·设当前·编辑·绑定·清除 cookie 的 key 选择界面）均显示账号余额**（登录 PASETO token 经 `getAccountInfoCached` TTL 缓存查询 `platform.senseaudio.cn/api/user/self`，余额按**账号**粒度、所有 key 共享：现金余额显示 `$(coin)/$(error) 充值 ¥X.XX`（> `minBalanceCny` 为 coin、≤ 为 error），代金券可用显示 `$(gift) 赠送 ¥Y.YY`（> 0 时显示，附 `（至 YYYY-MM-DD）` 最早到期日，本地时区格式化），查询失败显示 `$(warning) 余额未知`）。**全部 key 用尽时**：轮换循环跟踪每个 key 的失败原因，报错列出脱敏 key + 原因（如 `sk_****abcd: 服务端繁忙 (503)`），并区分"瞬态失败请稍后重试"（429/503）与"确定性失败请检测"（402/401）；`pickNextApiKey` 无可用 key 的兜底报错同样列出每个 key 的原因（`buildAllKeysUnavailableDetail`）。**瞬态自动重试**：全部 key 均因瞬态错误（默认 429/500/503，状态码可配置 `senseaudio.transientRetryStatusCodes`，与触发轮换的状态码解耦）失败时，按 `senseaudio.transientRetryTimes`（默认 3）自动重试整轮——指数退避等待（2s/4s/8s，上限 8s）且**重试前清空瞬态冷却**（`resetExhaustedKeys(secrets,false)`，否则冷却期间 `pickNextApiKey` 会跳过全部 key 使重试无效），重试次数用尽后才报错。**平台侧错误不换 key**：500 Internal Server Error 是平台问题而非 key 问题——它命中瞬态重试但**不**命中轮换状态码，因此**不标记 key、不换 key**，仅退避后重试同一个 key（日志 `key.transientRetrySameKey`）。**瞬态判定（`isTransientRetryError`）**：错误命中瞬态重试状态码但原因非瞬态（如 500→`api_error`）时，规范化为 `server_error` 仅内存冷却不持久化，保证整轮重试可重新选 key。旧版单 key `senseaudio.apiKey` 自动迁移。`/v1/models` 实测不校验余额（余额 < 0 也 200），模型列表/启动同步用任意有效 key 即可 |
| **云同步（GitHub Gist）** | key/cookie/备注 三元组跨机器云同步：使用 VS Code 内置的 GitHub 登录（`vscode.authentication.getSession("github", ["gist"])`，无需 PAT）获取 token，将三元组存储到一个**私密 Gist**（`public: false`，文件名 `senseaudio-keys.json`，description 标记 `senseaudio-copilot key sync (do not edit manually)`）。**手动推送**（`senseaudio.syncPush`）：本地 store → Gist（未登录时弹登录界面）；**手动拉取**（`senseaudio.syncPull`）：Gist → 本地 store；**启动自动拉取**（`senseaudio.cloudSyncAutoPull`，默认开启）：静默检查云端 `updatedAt` 是否比本地上次同步时间（`globalState` 的 `senseaudio.lastCloudSyncAt`）新，是则拉取覆盖本地并弹窗提示，未登录时静默跳过不弹登录界面。**Gist 定位**：优先 `globalState` 缓存的 gist id（`senseaudio.cloudSyncGistId`，PATCH 404 时回退）→ 按 description 标记遍历用户 Gist 列表（前 3 页）→ 均无则创建新 Gist。**合并策略（拉取）**：云端为源——按 key 值对齐，云端条目覆盖本地 cookie/label，云端有本地无的追加、本地有云端无的删除；**可用性状态（available/lastCheckedAt）为本地数据不同步**，按 key 值保留本地检测结果；activeIndex 按 key 值跟随。无变更时不写 store 仅更新同步时间戳。实现集中在 `src/cloud/cloudSync.ts` |
| **多模型支持** | 内置 16 个模型定义，覆盖 6 大模型系列，统一通过推理强度选择器切换思考模式。支持自动模型发现：开启后从 API 获取模型列表，自动过滤不可用模型并发现新增模型 |
| **自动模型发现** | 通过 `senseaudio.enableAutoModelDiscovery` 配置（默认开启）。启动时从 `/v1/models` 获取当前可用模型 ID 列表及能力标记（含 `supports_responses`），过滤内置模型列表（不可用模型自动隐藏）。新增模型元数据以 **`/v1/models` 完整元数据为主源**（`context_length` / `max_completion_tokens` / `supports_vision` / `supports_reasoning` / `supports_tools`），models.dev 仅提供友好名称与回退规格——**models.dev 未收录或拉取失败时不再降级为 128K 上下文 / 4096 输出兜底**（2026-09-03 修复：曾导致 glm-5.3-flash 等自动发现模型上下文显示缩水为 102K、4096 输出上限被推理耗尽后正文为空，Copilot Chat 报 "Sorry, no response was returned."）；两源均未知输出上限时不发送 `max_completion_tokens`（交由服务端默认值）。`thinkingMode` 从 `supports_reasoning` 推断（支持推理→switchable，不支持→always）。API 不可用时静默回退到全量内置列表。内存缓存（5 分钟 TTL）。**按 API 模式过滤**：模型列表还会按 `senseaudio.apiMode` 过滤——`auto`/`openai` 显示全部（所有模型均支持 OpenAI 格式），`anthropic` 仅显示 `supports_anthropic=true` 的模型，`responses` 仅显示 `supports_responses=true` 的模型；能力集合为空（API 探测失败）时回退显示全部。**动态刷新**：通过 `onDidChangeLanguageModelChatInformation` 事件（VS Code 1.125+），切换 `apiMode` / `enableAutoModelDiscovery` 设置时自动重新拉取模型列表并刷新选择器，**无需 reload 窗口** |
| **启动模型同步** | 通过 `senseaudio.syncModelsOnStartup` 配置（默认开启）。每次 VS Code 打开时自动检查 API 是否有新模型，**每日最多同步一次**（`globalState` 记录上次同步日期）。同步结果以**一行日志**输出到「SenseAudio」输出通道（`models.sync` 标签，含状态/说明），**不写任何文件**（v1.7.0 起不再写工作区 `.copilot/model-sync-log.md`——该文件会污染用户仓库，见 issue #1）。无 API Key、API 不可用时记录失败事件且不标记为已同步（下次打开重试） |
| **三协议 API 模式** | 同时支持 **OpenAI 兼容格式** (`/chat/completions`)、**Anthropic 格式** (`/v1/messages`) 和 **Responses API 格式** (`/v1/responses`)。可通过设置 `senseaudio.apiMode`（默认 `auto`）手动切换：`auto` 跟随各模型默认格式，`openai` 强制 OpenAI 格式，`anthropic` 强制 Anthropic 格式，`responses` 强制 Responses 格式。开关对聊天请求和 Git 提交消息生成均生效。启动时自动读取 `/v1/models` 的 `supports_responses` / `supports_anthropic` 字段并**缓存动态标记**（不硬编码模型 ID，未来新支持协议的模型自动生效）。**auto 模式优先级**：`enableResponsesApi`（默认关闭）→ `enableAnthropicApi`（默认关闭）→ 兜底 OpenAI。默认关闭原因：① SenseAudio 的 Responses 端点仍在演进（不同模型流式事件类型不一致、工具调用不稳定、多轮工具回填非常规）；② **Anthropic 格式对部分模型存在兼容性 bug**（如 DeepSeek 系列强制思考 + temperature/top_p → 400"请求参数组合无效"，2026-08-06 实测，插件已修复仅强制思考时跳过温度）。**建议默认使用更成熟的 OpenAI 兼容格式** |
| **流式推理** | 支持 SSE (Server-Sent Events) 流式响应，实时输出文本和工具调用 |
| **Thinking/推理** | 支持模型的推理过程展示 ("thinking" 状态)，包括 XML think 块解析 |
| **工具调用 (Tool Calling)** | 支持 VS Code 的 LanguageModelToolCallPart 机制 |
| **图片代理 (Tool-based)** | 为不支持视觉的模型注入 `ask_image` 工具，模型可自主选择调用视觉模型（默认 Kimi K2.6）回答关于图片的具体问题，支持两轮 API 请求完成"调用工具→提问→获取答案→继续回答"的完整流程。与旧版 `describe_image` 不同，`ask_image` 允许模型针对图片提出具体问题（如"按钮是什么颜色？"），视觉模型会针对性回答。视觉模型 ID、查询提示词和思考模式均可通过设置配置；视觉代理会在同一个 thinking 块中显示“正在根据图片提问：[问题]”并实时追加视觉模型流式输出。**跨轮视觉历史持久化（v1.8.0）**：每轮视觉代理完成后输出私有 MIME（`application/vnd.opencodego.vision-tool-history+json`）的 `LanguageModelDataPart`，VS Code 自动带入下一轮对话；下次请求 `convertMessages`（OpenAI/Anthropic）识别该 DataPart 并重建标准 tool call + tool result 消息，模型不会忘记之前看过的图片 |
| **上下文窗口声明** | `maxInputTokens` 按真实上下文窗口的**可配置比例**声明（内置模型与自动发现模型均适用，默认 `1.0` 即完整窗口，可通过设置 `senseaudio.maxInputTokensRatio` 调整，范围 0.1–1.0，**建议 0.8**）。VS Code agent 模式的自动压缩（`chat.summarizeAgentConversationHistory.enabled`，约在 `maxInputTokens` 的 90% 触发）在比例 0.8 时于真实上下文的约 **72%** 处触发，避免按完整上下文（如 1M token）声明时压缩永不触发的问题。`context_length` / `max_completion_tokens` 保持真实值不变（用于 API 请求体） |
| **Token 计数** | 使用 `o200k_base` tiktoken 分词器精确统计 token 用量 |
| **状态栏** | 实时显示当前会话 token 使用量、累计用量、缓存命中率 |
| **原生 Token 指示器** | 始终启用，向 Copilot Chat 原生 Token 指示器报告 token 用量。通过发送 MIME 类型为 `usage` 的 `LanguageModelDataPart`（TextEncoder 编码 JSON）实现，无需自建状态栏。依赖 VS Code/Copilot Chat 1.116+ 对外部模型 `usage` data part 的识别 |
| **高级 Token 指示器** | 可通过 `senseaudio.enableThirdPartyTokenIndicator` 配置（**默认关闭**）控制 VS Code 状态栏中的高级Token计数器。关闭后仅显示原生指示器（原生指示器始终上报）。**状态栏可见性由 `isStatusBarEnabled()` 决定 = 高级 Token 指示器 OR 套餐用量显示（`showUsageInStatusBar` / `showUsageInTooltip`）**——不能只用 `enableThirdPartyTokenIndicator` 把关，否则套餐用量功能将永远不可见。状态栏**仅在用户实际使用本插件提供的模型时显示**：启动时隐藏，发起 senseaudio 模型请求时显示，停止使用（空闲 60 秒）后自动隐藏，避免使用其他模型时残留上下文信息 |
| **套餐用量与余额显示** | 状态栏主文本显示**套餐用量**（对标上游 opencode-go-copilot 的 `Go 5H 65%`）：额度内显示 `$(pulse) 5H 65%`（5 小时限流窗口），额度耗尽显示 `$(pulse) 余额 ¥358.78`；悬停提示展示 5h/周/月三窗口（`5H——0% (0 / 10,000 积分)`）+ 5h 重置倒计时 + 余额 + 计费模式说明。**两套计费规则严格区分**（官方文档 token-plan）：① **周期额度**（5h/周）是**限流窗口**，耗尽后等下一周期自动恢复、**不消耗余额**；② **套餐积分**（月度 `credit_30d_limit`）才是**订阅额度**，耗尽后走超额策略——`enable_extra_usage=true` 则按量计费（代金券→现金），否则**降级 Free 版**。三态 `billingMode`：`plan`/`extra`/`free`。数据源 `GET platform.senseaudio.cn/api/user/self`（Bearer 登录 PASETO token），TTL 缓存 + **失败保留旧快照**（静默降级）。后台轮询（`senseaudio.usageRefreshInterval` 默认 5 分钟）+ 点击状态栏/`senseaudio.checkUsage` 命令强制刷新。配置：`showUsageInStatusBar`（默认开，关闭则主文本改显 Token 计数）、`showUsageInTooltip`（默认开）。**⚠️ 单位陷阱**：代金券积分 `1 元 = 1,000,000 积分`（`POINTS_PER_CNY`，2026-09-27 实测校正，曾误用 5000 导致 200 倍误差），与套餐积分**不是同一单位**。实现见 `src/balance/planUsage.ts`，设计/移植指南见 `docs/plan-usage-design.md` |
| **Git 提交消息生成** | 一键生成 Conventional Commit 格式的 Git 提交消息，支持 `auto` 语言模式自动从历史提交检测语言 |
| **多仓库支持** | 支持多根工作区 (multi-root) 中多个 Git 仓库的提交消息生成 |
| **模型预设** | 支持通过命令面板快速切换 temperature/top_p 预设（🎯 Precise/⚖️ Balanced/🔥 Creative），也支持手动自定义输入 |
| **国际化** | 内置简体中文 (zh-cn) 中英文双语界面 |
| **重试机制** | **两层重试，职责分离**：① **HTTP 层**（`executeWithRetry`，`senseaudio.retry.*`）——同一请求退避重试，默认 2 次，仅覆盖**网关错误**（502/504）与网络错误；② **整轮层**（`tryTransientRetryRound`，`senseaudio.transientRetry*`）——重跑整个 key 轮换循环，默认 3 次，覆盖平台错误（429/500/503）。**两层刻意不重叠**：429/500/503 只走整轮层（可换 key 或重试同一 key），避免 `maxAttempts × (transientRetryTimes+1)` 次尝试导致长时间挂起 |
| **请求延迟** | 可配置的请求间隔延迟，避免触发 API 限流 |
| **超时控制** | 可配置的请求超时时间（默认 10 分钟） |
| **立即取消** | 取消请求时通过 `reader.cancel()` 立即中断流式读取，停止后台接收 |
| **视觉代理配置** | 支持通过设置 `senseaudio.visionProxyModel`、`senseaudio.visionProxyThinking` 配置图片代理所使用的视觉模型和思考模式。`senseaudio.visionProxyThinking` 默认关闭，关闭时内部请求通过 `modelOptions.thinking={ type: "disabled" }` / `reasoning_effort="disabled"` 禁用视觉模型思考，最终 OpenAI 兼容请求体发送 `thinking: { type: "disabled" }`。**视觉模型仅从本供应商（senseaudio）查找**（`findVisionModel` 多级回退匹配裸 ID/完整 ID，修复 issue #3——`selectChatModels` 裸 ID 精确匹配带 vendor 前缀的完整 identifier 会落空）。**视觉代理模型动态选择**：`senseaudio.setVisionProxyModel` 命令从 `/v1/models` 动态加载 `supports_vision=true` 的模型列表（实测含 kimi-k2.5/k2.6/k2.7-code、qwen3.8-max、seed-2.1-turbo/pro），QuickPick 选择代替手填；API 不可用时回退手填 |
| **安装欢迎页 (Walkthrough)** | 引导向导（3 个步骤：设置 API Key、显示模型、高级设置），**仅可手动打开**（命令面板 → Welcome: Open Walkthrough）。**不再自动弹出**（2026-09-18 移除首次安装自动打开逻辑——未配置 key 时启动/请求均静默，不弹任何引导界面） |

### 1.3 模型清单

> **自动模型发现**（默认开启）会从 API 获取当前可用模型列表，自动隐藏不在列表中的内置模型，并从 models.dev 自动添加 API 返回的新模型。以下为全量内置模型定义，实际显示情况取决于 API 可用性。

#### 内置模型

| 系列 | 模型 ID | 视觉 | 推理强度选择器 | API 格式 |
|------|---------|------|----------------|----------|
| GLM | `glm-5.3`, `glm-5.3-flash`⁷, `glm-5.2`, `glm-5.1`, `glm-5` | ❌/✅⁷ | `禁用思考` / `高` / `最大` (5.2/5.3 系列) / `思考`（5.1/5 不支持思考切换） | OpenAI |
| Kimi | `kimi-k2.5`, `kimi-k2.6`, `kimi-k2.7-code`¹ | ✅ | `思考`（不支持思考切换） | OpenAI |
| DeepSeek | `deepseek-v4-pro`, `deepseek-v4-flash`, `deepseek-v4-flash-0731`³ | ❌ | `禁用思考` / `高` / `极高` | OpenAI / Responses⁵ |
| MiMo | `mimo-v2.5-pro` | ❌ | `禁用思考` / `思考` | OpenAI |
| MiniMax | `minimax-m2.7`, `minimax-m2.5` | ❌ | `思考`（不支持思考切换） | OpenAI |
| Qwen | `qwen3.7-max`⁴, `qwen3.8-max`⁶ | ❌/✅⁶ | `禁用思考` / `思考` | OpenAI / Responses⁵ |

> ¹ `kimi-k2.7-code` 不支持设置 Temperature/Top-p 参数。
> ¹⁰ `kimi-k2.6` 仅接受 `top_p=0.95`（传其他值返回 400 "field TopP invalid, only 0.95 is allowed for this model"，2026-09-19 实测）。模型定义新增 `fixedTopP: 0.95`，provider 在注入 temperature/top_p 后自动覆盖用户/预设配置的 top_p。
> ² GLM-5.2 支持通过 reasoning_effort 设置 thinking 强度 (high/max)，GLM-5.1/GLM-5 不支持 thinking 切换。
> ³ `deepseek-v4-flash-0731` 同时支持 OpenAI 与 Responses 协议（supports_responses=true）。
> ⁴ `qwen3.7-max` 仅支持 OpenAI/Responses 协议（supports_anthropic=false）。
> ⁵ Responses 能力**动态探测**：启动时读取 `/v1/models` 的 `supports_responses` 标记，不硬编码模型 ID——未来任何模型获得 Responses 支持都会自动生效。协议**默认关闭**（`enableResponsesApi=false`），默认使用 OpenAI 兼容格式。
> ⁶ `qwen3.8-max`（测试中）支持文本与图像输入（视觉 ✅），1M 上下文 / 131.1K 输出，原生支持 Responses API。

> ⁷ `glm-5.3-flash`（2026-09-03 内置化）支持文本与图像输入（视觉 ✅），1M 上下文 / 131K 输出，支持思考切换；`glm-5.3` 为纯文本版本，规格相同。

> 模型清单来源于 [SenseAudio 模型页](https://docs.senseaudio.cn/guides/account/model-list-billing)。图片生成模型（`qwen-image-2.0`、`wan2.7-image`）不适用于 Chat，已排除。

在模型选择器中，内置模型归入 `SenseAudio` 分组（`family="SenseAudio"`）。

> 所有模型在模型选择器中均显示**一个条目**，通过**推理强度选择器**（中文标签）切换思考模式。  
> - `thinkingMode="switchable"`：用户可选择`禁用思考`、`自动`或启用思考（强度可配置）  
> - `thinkingMode="adaptive"`：仅`禁用思考`和`自动`两档选择，无强制启用思考选项  
> - `thinkingMode="always"`：推理始终启用，选择器中不显示`禁用思考`选项（模型特性）  
> 
> **关于图像输入：** 所有模型（包括非视觉模型）的 `imageInput` 能力均声明为 `true`，以确保 VS Code 始终传递图片数据。非视觉模型通过内部的 `ask_image` 工具代理机制处理图片，不直接支持视觉输入。

---

## 2. 详细逻辑架构

### 2.1 总体数据流

```
┌─────────────────────────────────────────────────────────────────────┐
│                        VS Code Copilot Chat                         │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  用户发送消息 → LanguageModelChatProvider                     │  │
│  │                    ↓                                          │  │
│  │  SenseAudioChatModelProvider (provider/provider.ts)           │  │
│  │   1. 获取模型配置 (getBuiltInModelConfig)                     │  │
│  │   2. 获取 API Key (SecretStorage)                             │  │
│  │   3. 计算 Token 用量 (provideToken → statusBar)               │  │
│  │   3b. 可选: 向 Copilot Chat 原生 Token 指示器报告用量          │  │
│  │       (LanguageModelDataPart, MIME type "usage", VS Code 1.116+)│  │
│  │   4. 应用请求延迟 (delay)                                     │  │
│  │   5. 构建请求 → API 路由选择                                  │  │
│  │      ├─ apiMode="openai"     → OpenaiApi                    │  │
│  │      ├─ apiMode="anthropic"  → AnthropicApi                 │  │
│  │      └─ apiMode="responses"  → ResponsesApi                 │  │
│  │   6. 发送 HTTP 请求 (fetch with undici + 超时控制)             │  │
│  │   7. 流式解析响应 → Progress<LanguageModelResponsePart2>      │  │
│  │   7b. 零正文预算耗尽检测（finish_reason=length/max_tokens      │  │
│  │       且正文为空 → 抛友好错误，不再静默返回空流）             │  │
│  │      ├─ LanguageModelTextPart     (文本)                      │  │
│  │      ├─ LanguageModelThinkingPart (推理过程)                  │  │
│  │      └─ LanguageModelToolCallPart (工具调用)                  │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                        Git 提交消息生成                              │
│  SCM 标题栏按钮 → generateCommitMsg()                              │
│    → 获取 Git Diff (gitUtils.ts)                                   │
│    → 获取最近提交风格参考                                          │
│    → 构建 prompt → 调用 API (OpenaiApi/AnthropicApi/ResponsesApi)  │
│    → 流式输出到 SCM InputBox                                       │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 扩展激活流程

```
activate(context)
  ├── logger.init()                         ← 创建 LogOutputChannel
  ├── TokenizerManager.initialize()         ← 加载 o200k_base.tiktoken
  ├── initStatusBar()                       ← 创建状态栏条目（默认隐藏）
  ├── new SenseAudioChatModelProvider()      ← 创建 Provider 实例
  ├── vscode.lm.registerLanguageModelChatProvider("senseaudio", provider)
  ├── registerCommands(context, provider)    ← 委托 src/commands/registerCommands.ts
  │   ├── onDidChangeConfiguration 监听       ← apiMode / enableAutoModelDiscovery 变化时刷新模型列表
  │   └── 注册 12 条命令:
  │       ├── senseaudio.setApiKey                ← 设置 API Key
  │       ├── senseaudio.manageApiKeys            ← 多 Key 管理 QuickPick
  │       ├── senseaudio.setVisionProxyModel      ← 选择视觉代理模型
  │       ├── senseaudio.getApiKey                ← 打开 SenseAudio 官网获取 Key
  │       ├── senseaudio.openSettings             ← 打开扩展设置页
  │       ├── senseaudio.generateGitCommitMessage ← 生成提交消息
  │       ├── senseaudio.abortGitCommitMessage    ← 中止生成
  │       ├── senseaudio.setModelPreset           ← 设置模型预设
  │       ├── senseaudio.syncPush                 ← 推送 key/cookie/备注 到云端 Gist
  │       ├── senseaudio.syncPull                 ← 从云端 Gist 拉取 key/cookie/备注
  │       └── senseaudio.checkUsage               ← 查询套餐用量与余额（也绑定状态栏点击）
  ├── syncModelsOnStartup(context)           ← 启动模型同步（每日最多一次，结果以一行日志输出）
  ├── autoPullOnStartup(context)             ← 启动云同步自动拉取（静默，云端更新时覆盖本地）
  └── 注册 dispose 清理
```

> `initStatusBar(context, getLoginToken)` 同时启动**套餐用量后台轮询**（`startUsagePolling`），
> 状态栏主文本显示 5h 窗口用量、悬停提示显示三窗口 + 余额（见 4.15）。

### 2.3 聊天请求处理流程

```
provideLanguageModelChatResponse(model, messages, options, progress, token)
  │
  ├── 1. 解析模型 ID → getBuiltInModelConfig(model.id)
  │       格式: "baseId"（无 :: 后缀）
  │       所有模型注册为单一条目
  │       内置模型查找失败时回退到 getAutoDiscoveredModelConfig(model.id)
  │
  ├── 2. 应用用户配置的 reasoningEffort
  │       ├── "disabled" → 关闭思考（always 模型除外）
  │       ├── "adaptive" → 开启思考，自动模式（OpenAI 端点发送 thinking: { type: "auto" }，Anthropic 端点发送 { type: "adaptive" }）
  │       ├── "enabled" → 开启思考，使用默认推理力度
  │       ├── "high"/"max" → 开启思考，指定推理力度
  │
  ├── 2b. 注入 temperature/top_p（模型预设或自定义设置）
  │       ├── preset 模式 → 注入预设的 temperature（不传入 top_p，由模型使用默认值）
  │       └── custom 模式 → 注入用户自定义的 temperature 和 top_p（如有设置）
  │
  ├── 2c. 注入 vision 配置
  │       └── modelConfig.vision = um?.vision ?? false
  │
  ├── 3. 确定 API 模式 (apiMode: "openai" | "anthropic" | "responses")
  │       ├── 读取设置 senseaudio.apiMode (auto/openai/anthropic/responses)
  │       ├── "openai"/"anthropic"/"responses" → 强制使用对应协议
  │       ├── "auto" → 优先级探测：
  │       │   ├── enableResponsesApi=true 且模型 ∈ supports_responses 集合 → responses
  │       │   ├── enableAnthropicApi=true 且模型 ∈ supports_anthropic 集合 → anthropic
  │       │   └── 否则 → openai
  │       └── 默认（两开关均关闭）→ 全部使用 openai
  │
  ├── 4. 记录请求开始日志
  │
  ├── 5. 更新状态栏 Token 用量
  │
  ├── 6. 应用请求延迟 (delay)
  │
  ├── 7. 确保至少一个 API Key 存在（ensureApiKey → keyManager.getApiKeyStore）
  │       └── 无 key 时静默返回 undefined → 抛出 "SenseAudio API key not found"（不弹任何输入框）
  │
  ├── 8. 创建请求超时 AbortController
  │      └── 连接 VS Code 取消令牌 → abort()
  │
  ├── 9. 创建 undici fetch (自定义 bodyTimeout)
  │
  ├── 9b. 获取 Response body reader 后，注册取消回调
  │      └── `token.onCancellationRequested` / `signal.addEventListener("abort")`
  │      └── 调用 `reader.cancel()` 立即中断流，使 `reader.read()` 返回 `{ done: true }`
  │
  │
  ├── 9c. **多 Key 轮换循环**（外层 while(true)，每轮选一个 key，`failedKeys` 跟踪各 key 失败原因）:
  │       ├── pickNextApiKey(secrets, apiKeyMode)
  │       │   ├── sticky → 从轮询游标环形扫描第一个可用 key，游标钉住不前移（固定使用；失效后切下一个并钉住，不自动切回）
  │       │   ├── rotation → 从轮询游标环形扫描第一个可用 key，游标前移
  │       │   ├── single → active key；不可用且 singleKeyFallback=switch 且本轮原因为 balance（402，shouldSingleKeyFallbackSwitch 判定）→ 降级 rotation 选下一个可用 key + setActiveKeyByValue 设为当前 + 成功后弹窗提示；其他原因（401/429/503）不切换 → single 专属报错
  │       │   └── 全部不可用 → 报错列出脱敏 key+原因（buildAllKeysUnavailableDetail，如 `sk_****abcd: 服务端繁忙 (503)`）
  │       ├── 用当前 key 构造 requestHeaders → executeApiRequest()（见步骤 10 协议分发）
  │       ├── 成功 → break 循环；曾不可用 → 自愈置可用
  │       └── 失败: isKeyRotationError(err)（状态码 [401]/[402]/[429]/[503] 或文本 patterns 可配置）
  │           ├── isTransientRetryError(err)（状态码匹配 transientRetryStatusCodes，默认 [429,500,503]）→ reason 规范化为瞬态（仅内存冷却不持久化）
  │           ├── getKeyRotationReason(err) → 402/401 → markApiKeyExhausted(持久化 available=false) + continue 换 key
  │           ├── 429/503 → markApiKeyExhausted(仅内存冷却，不持久化) + continue 换 key
  │           ├── 取消/超时/其他错误（400/403/网络/IMAGE_SENSITIVE）→ 抛给外层 catch，不轮换
  │           ├── **500 等平台侧瞬态错误（命中重试但未命中轮换）→ 不标记 key、不换 key，退避后重试同一 key**
  │           └── failedKeys.size >= keys.length → 报错：列出脱敏 key+原因；含瞬态(429/503)提示"请稍后重试"，否则提示"用管理命令检测"
  │               └── 瞬态且未达 transientRetryTimes 上限 → 清空瞬态冷却 + 指数退避等待(2s/4s/8s) + 清空 failedKeys + continue 重试整轮
  │
  ├── 10. 根据 apiMode 路由（executeApiRequest）:
  │
  │     ├── OpenAI 模式:
  │     │   ├── OpenaiApi.convertMessages()    ← 消息格式转换
  │     │   ├── OpenaiApi.prepareRequestBody()  ← 构建请求体
  │     │   ├── POST /chat/completions          ← 发送请求
  │     │   ├── executeWithRetry()              ← 可重试
  │     │   └── OpenaiApi.processStreamingResponse()
  │     │       ├── SSE 行解析 ("data: ...")
  │     │       ├── processDelta() → 处理每个 delta
  │     │       │   ├── 推理内容 (thinking/reasoning/reasoning_content)
  │     │       │   ├── XML think 块解析 (<think>...</think>)
  │     │       │   ├── 文本内容 → LanguageModelTextPart
  │     │       │   └── 工具调用 → LanguageModelToolCallPart
  │     │       └── 用量统计 (usage chunk)
  │     │
  │     └── Anthropic 模式:
  │         ├── AnthropicApi.convertMessages()   ← 消息格式转换
  │         ├── AnthropicApi.prepareRequestBody() ← 构建请求体
  │         ├── POST /v1/messages               ← 发送请求
  │         ├── executeWithRetry()               ← 可重试
  │         └── AnthropicApi.processStreamingResponse()
  │             ├── SSE 行解析 ("data: ...")
  │             └── processAnthropicChunk()
  │                 ├── content_block_start → 块开始
  │                 ├── content_block_delta → 增量内容
  │                 │   ├── text_delta      → 文本
  │                 │   ├── thinking_delta  → 推理
  │                 │   └── input_json_delta → 工具参数
  │                 └── content_block_stop/message_stop → 结束
  │
  │     └── Responses 模式 (POST /v1/responses):
  │         ├── ResponsesApi.convertMessages()   ← 消息格式转换（input 数组，仅 input_text/output_text/input_image）
  │         ├── ResponsesApi.prepareRequestBody() ← 构建请求体（instructions/reasoning/tools，工具用扁平格式）
  │         ├── POST /v1/responses               ← 发送请求
  │         ├── executeWithRetry()               ← 可重试
  │         └── ResponsesApi.processStreamingResponse()
  │             ├── SSE 行解析 ("data: ...")
  │             └── processResponsesEvent()
  │                 ├── response.output_item.added → function_call 缓冲（按 output_index）
  │                 ├── response.reasoning_summary_text.delta / reasoning_text.delta → 推理内容（因模型而异）
  │                 ├── response.output_text.delta → 文本
  │                 ├── response.function_call_arguments.delta/done → 工具参数
  │                 └── response.completed → usage 统计
  │
  ├── 11. 图片代理拦截处理:
  │       └── handleInterceptedToolCall()
  │           ├── 检查 interceptedToolCall（循环，最多 visionMaxRounds 次）
  │           ├── 发出同一 thinking 块: "正在根据图片提问：[问题]" + 视觉模型流式输出
  │           ├── 调用 callVisionModel() 获取描述（可选实时转发文本到 thinking 块）
  │           ├── 关闭 thinking 块
  │           ├── 输出跨轮视觉历史 DataPart（createVisionToolHistoryPart，封装 id/name/args/result/reasoningContent）
  │           │   └── VS Code 自动带入下一轮对话（私有 MIME application/vnd.opencodego.vision-tool-history+json）
  │           ├── 用户取消则跳过本轮
  │           ├── 创建独立 AbortController 用于本轮请求
  │           │   ├── 保留 temperature/reasoning_effort 等原始参数
  │           │   ├── Anthropic 模式额外恢复 system 和 thinking 配置
  │           │   ├── Responses 模式使用文本化回填（output_text/input_text）
  │           │   └── DeepSeek 兼容注入 reasoning_content
  │           ├── 注入工具: 本轮注入 VS Code 原生工具 + ask_image（+ ask_with_multi_image 当 >=2 张图时）
  │           └── 循环: 若模型再次调用 ask_image 则继续下一轮，无限追问
  │
  ├── 12. 错误处理:
  │        ├── 用户取消（token.isCancellationRequested）→ 直接重新抛出
  │        ├── 超时（abortController.signal.aborted）→ 友好超时提示
  │        ├── 连接被终止 → 友好终止提示
  │        └── 其他错误 → 原样抛出
  │
  └── 12. finally: 清理定时器, 记录请求结束日志
```

### 2.4 Thinking/推理内容处理

```
推理内容来源 (OpenAI 模式):
  ├── choice.thinking (对象/字符串)
  ├── delta.reasoning_content (字符串)
  ├── delta.reasoning (对象)
  ├── delta.thinking (对象)
  └── reasoning_details[] (OpenRouter 格式)
      ├── reasoning.summary → summary 字段
      ├── reasoning.text    → text 字段
      └── reasoning.encrypted → "[REDACTED]"

处理机制:
  1. bufferThinkingContent(text) → 积累到 _thinkingBuffer
  2. 每 100ms 定时刷新 → LanguageModelThinkingPart
  3. XML think 块 (<think>...</think>) → processXmlThinkBlocks()
  4. 文本内容出现时 → reportEndThinking()

回传机制 (OpenAI 模式 convertMessages):
  - includeReasoningInRequest=true 时，assistant 消息**始终**设置 reasoning_content
    （有真实推理内容用内容，否则空字符串兜底）——DeepSeek thinking 模式要求每个
    assistant 消息必须携带该字段；VS Code 回传历史时不含 LanguageModelThinkingPart，
    缺失字段会 400（"The reasoning_content in the thinking mode must be passed
    back to the API"，2026-08-11 实测）
```

### 2.5 工具调用处理

```
工具调用流 (OpenAI 模式):
  delta.tool_calls[]
    ├── index: 工具调用索引
    ├── id: 调用 ID
    ├── function.name: 函数名
    └── function.arguments: JSON 参数 (可能分片)

处理机制:
  1. _toolCallBuffers Map<index, {id, name, args}>
  2. stream 分片拼接 args
  3. tryEmitBufferedToolCall() → 参数可解析 JSON 时立即发射
  4. flushToolCallBuffers() → finish_reason 时强制发射剩余
  5. adjustReadFileParameters() → 自动扩增 read_file 行数
  ask_image 拦截: 不在 tryEmit/flush 中发出，改为设置 interceptedToolCall
```

### 2.6 图片代理（ask_image Tool）流程

```
非视觉模型收到含图片的消息:
  │
  ├── 1. convertMessages()
  │      模型 vision=false，有 image → 替换为 "[The user sent an image (imageIndex=N)... I MUST call the ask_image tool...]"
  │      原图数据存入实例的 _localImages 数组
  │      同时递归扫描 tool result 内嵌的图片一并存入
  │      记录 _hasImages = true，保存 _originalApiMessages
  │
  ├── 2. prepareRequestBody()
  │      有 _localImages → 注入 ask_image 工具定义到 tools 列表
  │      设置 tool_choice = "auto"（DeepSeek 等模型拒绝强制 tool_choice）
  │
  ├── 3. 第一次 API 请求（含 ask_image + VS Code 原生工具）
  │      └── 模型自主决定是否调用 ask_image
  │
  ├── 4. processDelta() / processAnthropicChunk() / processResponsesEvent() 拦截
  │      ask_image 和 ask_with_multi_image 被缓存到 interceptedToolCall（不在 progress 中发出）
  │      tryEmitBufferedToolCall() 和 flushToolCallBuffers() 同时跳过 ask_image/ask_with_multi_image
  │
  └── 5. handleInterceptedToolCall() 循环（多轮追问）
         for round = 1 to visionMaxRounds:
           ├── 读取 interceptedToolCall
           ├── 发出 LanguageModelThinkingPart("正在根据图片提问：[问题]\n...")
           ├── 使用模型的具体 query 调用 callVisionModel()，并将视觉模型文本流实时追加到同一 thinking 块
           │   └── 发送图片 + 查询到视觉模型，收集流式回答
           ├── 关闭 thinking
           ├── 输出跨轮历史 DataPart（createVisionToolHistoryPart）:
           │   ├── 封装 { version: 1, entry: { id, name, args, result, reasoningContent? } }
           │   ├── MIME: application/vnd.opencodego.vision-tool-history+json
           │   ├── reasoningContent 取自 OpenAI 模式的 _capturedReasoningContent（DeepSeek 兼容）
           │   └── VS Code 自动把该 DataPart 带入下一轮对话
           ├── 构建本轮消息: 追加 assistant(tool_call) + tool(result)
           ├── 注入工具: VS Code 原生工具 + ask_image（两者共存）
           ├── 发送 API 请求并流式处理
           ├── 若模型再次调用 ask_image → 继续循环
           └── 若模型未调 ask_image → 结束

跨轮恢复（下一轮请求的 convertMessages）:
  ├── OpenAI 模式: parseVisionToolHistoryPart(part) → toOpenAIVisionToolMessages(entry)
  │   └── 重建 [{role:"assistant", tool_calls:[...], reasoning_content?}, {role:"tool", tool_call_id, content}]，插到该消息正常内容之前
  └── Anthropic 模式: parseVisionToolHistoryPart(part) → toAnthropicVisionToolMessages(entry)
      └── 重建 [{role:"assistant", content:[{type:"tool_use",...}]}, {role:"user", content:[{type:"tool_result",...}]}]，在 system 处理与工具结果合并缓冲之前
```

#### 多轮请求特点

- **支持无限追问**: 模型拿到图片描述后可以继续调用 ask_image 追问细节（最多 `visionMaxRounds` 次，默认 5）
- **工具共存**: 每轮同时注入 VS Code 原生工具（read_file 等）+ ask_image，模型可混合使用
- **图片数据生命周期**: 图片存于 API 实例的 `_localImages` 数组，请求结束后随实例 GC 自动回收
- **跨轮视觉历史持久化（v1.8.0）**: 每轮视觉代理完成后输出私有 MIME `application/vnd.opencodego.vision-tool-history+json` 的 `LanguageModelDataPart`（`historyPart.ts` 的 `createVisionToolHistoryPart`），VS Code 自动带入下一轮对话；下次请求 `convertMessages` 经 `parseVisionToolHistoryPart` 识别并重建标准 tool call/tool result 消息（`historyCodec.ts` 的 `toOpenAIVisionToolMessages` / `toAnthropicVisionToolMessages`）——模型跨轮记住之前看过的图片，不会重复调用 ask_image 或忘记图片内容
- **OpenAI 模式**: 使用 `tool_calls` + `tool` role 消息格式构建每轮
- **Anthropic 模式**: 使用 `tool_use` + `tool_result` content block 格式构建每轮；**连续工具结果合并（v1.8.0）**: VS Code 可能把每个工具结果作为独立消息传入，Anthropic 协议要求同一 assistant `tool_use` 对应的全部 `tool_result` 必须在紧随的同一条 user 消息里——`convertMessages` 缓冲纯工具结果消息（`pendingToolResults`），合并为单条 user 消息输出，避免 400 "tool_use ids were found without tool_result blocks immediately after"
- **Responses 模式**: 使用文本化回填（assistant `output_text` `[tool_call] name(args) [/tool_call]` + user `input_text` `[tool_result] ... [/tool_result]`，因端点拒绝 function_call 块）。**工具定义需扁平格式**：Responses 端点要求 `{ type: "function", name, description, parameters }`（OpenAI 端点的嵌套 `function` 格式会被拒绝，报 `InvalidParameter: ...valid openai-compatible JSON schema`）——`ResponsesApi.prepareRequestBody` 已按扁平格式注入，且工具定义来自 VS Code 转换后的扁平结构
- **参数保留**: 每轮保留 temperature、top_p、thinking 模式等原始参数
- **DeepSeek 兼容**: 对 DeepSeek 模型的 assistant tool_call 消息注入 reasoning_content 字段

### 2.6 Git 提交消息生成流程

```
generateCommitMsg(secrets, scm?)
  ├── 检测 Git 扩展和仓库
  ├── 获取 Git Diff (gitUtils.getGitDiff)
  │   ├── 优先 staged diff (git diff --cached)
  │   └── 回退 unstaged diff (git diff)
  ├── 多仓库处理:
  │   ├── 0 个有变化的仓库 → 提示用户
  │   ├── 1 个 → 直接生成
  │   └── 多个 → QuickPick 选择
  ├── 构建 Prompt:
  │   ├── 系统提示词 (可自定义，强调直接输出不包含解释)
  │   ├── 最近提交风格参考
  │   │   ├── 默认: 仅提交标题 (git log --format=%s)
  │   │   └── 可选: 同时包含每次提交的 diff (senseaudio.commitIncludeCommitDiff)
  │   ├── 语言检测: auto 模式时告知模型匹配历史 commit 语言风格
  │   ├── 用户当前输入 (SCM InputBox)
  │   └── Git Diff 内容
  ├── 调用 API（多 key 轮换循环）:
  │   ├── ensureApiKeyEntry → pickNextApiKey (rotation/sticky/single + fallback：single 仅余额不足(402)时切换并设为当前)
  │   ├── OpenaiApi.createMessage() / AnthropicApi.createMessage() / ResponsesApi.createMessage()
  │   ├── 流式输出到 SCM InputBox
  │   └── 轮换错误 → 换 key 重试（已有部分输出则不换）；用户取消 → 中止
  └── 清理: 移除 ``` 标记和 <think> 标签
```

---

## 3. 程序文件索引

### 3.1 目录结构

> **2026-09-27 结构重构**：`src/` 按职责分类到子目录（`api/` `provider/` `keys/` `balance/` `models/` `commands/` `core/` `ui/` `cloud/` `typings/`），
> 三个巨型文件（`provider.ts` 1410 行 / `extension.ts` 1015 行 / `keyManager.ts` 636 行）已拆分；
> 三协议适配器重复的 SSE 解析与取消回调上提到 `api/sse.ts`。
> `scripts/` 按用途分为 `build/`（构建）与 `dev/`（调试），测试脚本统一移入 `test/`。

```
src/
├── extension.ts                          # 扩展入口（仅编排：初始化 + 注册 Provider + 委托命令注册 + 启动任务）
├── api/                                  # 协议适配层
│   ├── commonApi.ts                      # API 抽象基类（图片存储、工具调用拦截、thinking 缓冲、共享辅助）
│   ├── sse.ts                            # 共享 SSE 流解析（iterateSseEvents / consumeSseStream）
│   ├── httpClient.ts                     # 共享 HTTP 请求样板（postJson，三协议 createMessage 共用）
│   ├── openai/
│   │   ├── openaiApi.ts                  # OpenAI 兼容 API 实现
│   │   └── openaiTypes.ts                # OpenAI 类型定义
│   ├── anthropic/
│   │   ├── anthropicApi.ts               # Anthropic API 实现
│   │   └── anthropicTypes.ts             # Anthropic 类型定义
│   └── responses/
│       ├── responsesApi.ts               # Responses API 实现 (POST /v1/responses)
│       └── responsesTypes.ts             # Responses 类型定义
├── provider/                             # Chat Provider 实现
│   ├── provider.ts                       # SenseAudioChatModelProvider（VS Code 接口 + 请求编排）
│   ├── requestOptions.ts                 # 推理强度 / temperature / apiMode 决策
│   ├── rotation.ts                       # 多 key 轮换循环（瞬态整轮重试）
│   ├── apiDispatch.ts                    # 三协议分发与流式处理
│   ├── visionRounds.ts                   # ask_image 图片代理多轮（含三协议轮次构建）
│   └── errors.ts                         # 错误文案、瞬态重试、原生 token 指示器、零正文检测
├── keys/                                 # 多 API Key 管理
│   ├── keyManager.ts                     # barrel（统一导出，保持既有导入路径）
│   ├── types.ts                          # ApiKeyEntry / ApiKeyStore / ApiKeyMode / SingleKeyFallback
│   ├── config.ts                         # 模式、状态码、patterns、冷却与重试次数配置
│   ├── state.ts                          # 模块级可变状态（store 缓存、轮询游标、瞬态冷却表）
│   ├── store.ts                          # SecretStorage 读写、旧版单 key 迁移、增删改
│   ├── selection.ts                      # 主 key 获取、轮询/粘性选择、single fallback 判定
│   ├── health.ts                         # 瞬态冷却、轮换错误判定、失效原因、状态更新
│   └── mask.ts                           # 脱敏显示辅助
├── balance/                              # 余额 / 账号
│   ├── balanceCheck.ts                   # barrel（统一导出）
│   ├── config.ts                         # 阈值 / TTL 配置与通用工具
│   ├── accountInfo.ts                    # 平台用户中心账号信息（登录 PASETO token）+ 到期日格式化 + POINTS_PER_CNY
│   ├── planUsage.ts                      # 套餐用量快照（5h/周/月窗口 + 余额 + 计费模式，对标上游 goUsage.ts）
│   └── availability.ts                   # key 可用性手动检测（最小真实聊天请求）
├── models/                               # 模型定义与发现
│   ├── models.ts                         # 内置模型定义清单
│   ├── modelsDev.ts                      # models.dev 元数据拉取与查询
│   ├── apiModelList.ts                   # API 模型列表获取（/v1/models）
│   ├── modelSync.ts                      # 启动模型同步（每日一次，一行日志）
│   └── provideModel.ts                   # 模型信息提供函数（含自动发现）
├── commands/                             # 命令与 QuickPick UI
│   ├── registerCommands.ts               # 全部命令注册 + 配置变更监听
│   ├── apiKeyManagerUi.ts                # manageApiKeys 主入口（渲染菜单 + 分发动作）
│   ├── apiKeyDisplay.ts                  # key 展示辅助（余额格式化 / 详情行 / QuickPick 项，三界面共用）
│   ├── apiKeyFlows.ts                    # key 管理交互流程（增删改/导入/检测/cookie）
│   ├── checkUsageCommand.ts              # 套餐用量查询命令（senseaudio.checkUsage）
│   ├── visionProxyCommand.ts             # 视觉代理模型选择
│   └── modelPresetCommand.ts             # 模型温度预设选择
├── core/                                 # 基础设施
│   ├── logger.ts                         # 日志系统
│   ├── localize.ts                       # 国际化/本地化
│   ├── types.ts                          # TypeScript 类型定义
│   ├── utils.ts                          # 通用工具函数
│   └── versionManager.ts                 # 版本信息管理
├── ui/
│   └── statusBar.ts                      # 状态栏管理（受 enableThirdPartyTokenIndicator 控制）
├── cloud/
│   └── cloudSync.ts                      # 云同步（GitHub Gist）：推送/拉取/启动自动拉取
├── gitCommit/
│   ├── commitMessageGenerator.ts         # Git 提交消息生成
│   └── gitUtils.ts                       # Git 工具函数
├── tokenizer/
│   ├── tokenizerManager.ts               # Tokenizer 管理 (o200k_base)
│   ├── provideToken.ts                   # Token 计数函数
│   └── imageUtils.ts                     # 图片尺寸解析
├── vision/
│   ├── types.ts                          # Vision proxy 类型定义
│   ├── historyCodec.ts                   # 跨轮视觉历史编解码（serialize/deserialize/toOpenAI/toAnthropic）
│   ├── historyPart.ts                    # 跨轮视觉历史 DataPart 创建/解析（私有 MIME）
│   └── imageProxy.ts                     # 图片代理核心 (ask_image)
└── typings/                              # VS Code proposed API 类型声明（仅编译期）
    ├── vscode.proposed.chatProvider.d.ts
    ├── vscode.proposed.languageModelDataPart.d.ts
    └── vscode.proposed.languageModelThinkingPart.d.ts

resources/
└── walkthrough/                          # 安装欢迎页 (Walkthrough) 文档
    ├── set-api-key.md                    # 步骤 1：设置 API Key
    ├── set-api-key.nls.zh-cn.md          # 步骤 1 中文版
    ├── show-models.md                    # 步骤 2：显示模型
    ├── show-models.nls.zh-cn.md          # 步骤 2 中文版
    ├── advanced-settings.md              # 步骤 3：高级设置
    └── advanced-settings.nls.zh-cn.md    # 步骤 3 中文版

scripts/
├── build/                                # 构建相关
│   ├── clean.mjs                         # 清理 out/（compile 前置，防止陈旧产物进 VSIX）
│   ├── build-info.mjs                    # 编译元信息生成（out/build-info.json + .copilot/build-log.md，compile 后自动运行）
│   ├── package-vsix.mjs                  # VSIX 打包（npm run build），输出名固定 <name>-<version>.vsix
│   └── copy-tokenizer.js                 # 拷贝/下载 tokenizer 资源（postinstall）
└── dev/                                  # 开发调试
    ├── check-new-models.mjs              # 检查 API 新模型
    ├── check-settings.mjs                # 设置项一致性核对（声明 vs 使用，挂到 compile）
    └── audit-all.mjs                     # 完整审计（npm run audit，7 项检查）

.vscode/                                  # 调试配置（F5 启动扩展宿主）
├── launch.json                           # Run Extension（preLaunchTask: npm: compile）
└── tasks.json                            # compile / watch / test:offline 任务

docs/
├── multi-api-key-design.md               # 多 Key 轮换与失效切换（当前实现）
├── plan-usage-design.md                  # 套餐用量与余额显示设计
├── responses-api-issues.md               # Responses 协议已知问题
└── archive/                              # 历史设计归档
    └── multi-api-key-design-v1.9-cookie-precheck.md  # 含已废弃 cookie 预检架构的旧版设计

test/                                     # 测试脚本（运行前需 npm run compile）
├── api-tests.mjs                         # 三协议 API 完整测试（OpenAI/Anthropic/Responses，第 9b 项含生产 400 回归用例）
├── test-plan-usage.mjs                   # 套餐用量快照测试（29 项断言）
├── test-transient-retry.mjs              # 瞬态错误分类测试（18 项断言，含 500 不换 key 回归）
├── test-vision-history.mjs               # 跨轮视觉历史编解码 + 双 API 转换器闭环测试
├── test-anthropic-tool-result-merge.mjs  # Anthropic 连续工具结果合并测试（issue #87 场景）
├── test-apply-token.mjs                  # 令牌应用测试
├── test-banned-detect.mjs                # 封号检测测试
├── test-banned-rotation.mjs              # 封号轮换测试
├── test-model-diff.mjs                   # 模型差异测试
├── test-responses-recheck.mjs            # Responses 协议复检
├── test-vision-check.mjs                 # 视觉能力检查
└── README.md                             # 测试说明与平台差异记录（含 Responses 扁平化问题）

.copilot/
└── build-log.md                          # 编译日志（每次 npm run compile 由 scripts/build/build-info.mjs 追加，含版本号+时区）
```

### 3.2 文件详细说明

| 文件 | 行数 | 职责 |
|------|------|------|
| `extension.ts` | ~42 | 扩展激活/停用。**仅编排**：初始化日志/分词器/状态栏、注册 Provider、委托 `registerCommands()`、触发启动任务（模型同步 / 云同步自动拉取） |
| `api/commonApi.ts` | ~560 | `CommonApi<TMessage,TRequestBody>` 抽象基类（图片存储、工具调用拦截、thinking 缓冲、流式状态重置）；公共访问器 `localImages` / `originalApiMessages` / `systemContent` / `capturedReasoningContent` 供视觉代理使用；**三协议共享辅助**（2026-09-28 去重）：`collectLocalImages()`（图片收集）、`applyTemperature()`、`mergeExtraParams()`、`runSseStream()`（SSE 消费骨架） |
| `api/sse.ts` | ~148 | **共享 SSE 流解析**（2026-09-27 新增）：`iterateSseEvents()` 异步生成器 + `consumeSseStream()` 回调式消费，统一 reader 生命周期、`data:` 前缀解析、`[DONE]` 哨兵、取消回调注册与 finally 清理。三协议适配器共用，消除 5 处重复 |
| `api/httpClient.ts` | ~39 | **共享 HTTP 请求样板**（2026-09-28 新增）：`postJson()` 统一三协议 `createMessage` 的 fetch + 非 2xx 抛错（错误消息含状态码/状态文本/响应体/URL） |
| `api/openai/openaiApi.ts` | ~505 | OpenAI 格式 API 实现 (消息转换/请求构建/流式处理/图片代理/跨轮视觉历史重建)；`captureUsage()` 独立处理用量（OpenAI + DeepSeek 两种格式） |
| `api/openai/openaiTypes.ts` | ~66 | OpenAI 类型定义 |
| `api/anthropic/anthropicApi.ts` | ~487 | Anthropic 格式 API 实现 (消息转换/请求构建/流式处理/图片代理/跨轮视觉历史重建/**连续工具结果合并**) |
| `api/anthropic/anthropicTypes.ts` | ~119 | Anthropic 类型定义 |
| `api/responses/responsesApi.ts` | ~539 | Responses API 格式实现 (消息转换/请求构建/流式处理/图片代理/文本化工具回填) |
| `api/responses/responsesTypes.ts` | ~117 | Responses 类型定义 |
| `provider/provider.ts` | ~341 | `SenseAudioChatModelProvider`：VS Code 接口实现（`provideLanguageModelChatInformation` / `provideTokenCount` / `provideLanguageModelChatResponse`）+ 请求编排（模型配置解析、延迟、超时、取消、错误分类、状态栏生命周期）。具体逻辑委托给同目录模块 |
| `provider/requestOptions.ts` | ~106 | 请求参数决策：`applyReasoningEffort()`（thinking 模式）、`applyTemperature()`（预设/自定义/fixedTopP）、`resolveApiMode()`（auto 模式能力探测） |
| `provider/rotation.ts` | ~196 | `runKeyRotationLoop()`：多 key 轮换循环（选 key → 执行 → 轮换错误换 key / 瞬态整轮退避重试 / 全部失败报错列脱敏原因） |
| `provider/apiDispatch.ts` | ~221 | `executeApiRequest()`：三协议分发（openai/anthropic/responses）、请求体构建、`executeWithRetry`、流式处理、零正文预算耗尽检测、视觉代理后续轮次触发 |
| `provider/visionRounds.ts` | ~528 | `handleInterceptedToolCall()`：ask_image 图片代理多轮（thinking 块展示提问 + 视觉模型流式转发 + 跨轮历史 DataPart + 三协议轮次构建 `runOpenAIRound`/`runAnthropicRound`/`runResponsesRound`） |
| `provider/errors.ts` | ~136 | `REASON_TEXT`、`buildAllKeysUnavailableDetail()`、`tryTransientRetryRound()`、`checkZeroAnswerBudgetExhausted()`、`reportNativeUsage()`、`getRequestedReasoningEffort()` |
| `keys/keyManager.ts` | ~56 | barrel：统一导出 `keys/` 下全部 API（保持既有 `../keys/keyManager` 导入路径不变） |
| `keys/types.ts` | ~34 | `ApiKeyEntry` / `ApiKeyStore` / `ApiKeyMode` / `SingleKeyFallback` / `KeyDisplayStatus` |
| `keys/config.ts` | ~61 | 模式、轮换状态码、错误 patterns、瞬态重试状态码、冷却时长、重试次数配置读取 |
| `keys/state.ts` | ~30 | 模块级可变状态：store 缓存、轮询游标、瞬态冷却表（独立成文件避免循环依赖） |
| `keys/store.ts` | ~194 | SecretStorage 读写与旧版单 key 迁移、`addApiKey`/`addApiKeys`/`removeApiKey`/`setActiveKey`/`setKeyCookie`/`updateApiKey` |
| `keys/selection.ts` | ~110 | `getPrimaryApiKey` / `pickNextApiKey`（rotation 前移 / sticky 钉住）/ `shouldSingleKeyFallbackSwitch` / `setActiveKeyByValue` |
| `keys/health.ts` | ~216 | 瞬态冷却（`getTransientExhaustedInfo`）、`isApiKeyEligible`、`isKeyRotationError`、`isTransientRetryError`、`getKeyRotationReason`、`getKeyUnavailableReason`、`markApiKeyExhausted`/`markApiKeyAvailable`/`updateKeyAvailability`/`resetExhaustedKeys`、`getKeyDisplayStatus` |
| `keys/mask.ts` | ~18 | `maskApiKey` / `maskCookie` 脱敏 |
| `balance/balanceCheck.ts` | ~21 | barrel：统一导出 `balance/` 下全部 API |
| `balance/config.ts` | ~26 | 余额阈值 / TTL 配置读取 + `toNumber`（金额字符串转 number 防御） |
| `balance/accountInfo.ts` | ~200 | 平台用户中心账号信息：`queryAccountInfo`（`GET platform.senseaudio.cn/api/user/self`，Bearer PASETO token）、`getAccountInfoWithStatus`（带状态：ok/unauthorized/error）、`getAccountInfoCached`（TTL 缓存）、`formatExpiryDate`（代金券到期日）、`POINTS_PER_CNY`（1 元 = 1,000,000 积分）、`AccountInfo` / `PlanUsageWindow` 类型 |
| `balance/planUsage.ts` | ~330 | **套餐用量快照**（对标上游 `goUsage.ts`）：`buildSnapshot`（归一化 + 三态 `billingMode`）、`getPlanUsageCached`（TTL 缓存 + 失败保留旧值）、`getPlanUsageSnapshot`（同步读缓存）、`classifyWindow`（宽容匹配各平台 key 命名）、`getWindowPercent`（不截断）、`isPlanExhausted`（**只看月度额度窗口**）、`formatResetDuration` / `formatWindowLine` / `formatUsageSummary` / `formatBillingModeLine` / `formatBalanceSummary` |
| `balance/availability.ts` | ~66 | `testKeyAvailability`（最小真实聊天请求 `say ok` + `max_tokens=8`，402→余额不足 / 401→无效） |
| `models/models.ts` | ~265 | 16 个内置模型定义（含 glm-5.3/glm-5.3-flash，2026-09-03），模型配置查询（所有模型声明 `imageInput: true`） |
| `models/modelsDev.ts` | ~161 | models.dev 元数据拉取与查询：从 `models.dev/models.json` 下载并索引模型规格，支持短 ID 匹配，1 小时缓存 |
| `models/apiModelList.ts` | ~202 | API 模型列表获取：从 `/v1/models` 拉取可用模型 ID 及能力标记（含 `supports_responses`），5 分钟缓存，静默降级 |
| `models/modelSync.ts` | ~83 | 启动模型同步：每日最多一次检查 API 新模型（`globalState` 记录日期），同步结果以一行日志输出到「SenseAudio」Output 通道（`models.sync` 标签），**不写文件**（v1.7.0 移除工作区 `.copilot/model-sync-log.md`，见 issue #1），无 Key/API 不可用记录失败且不标记已同步 |
| `models/provideModel.ts` | ~280 | 模型信息提供函数（含自动发现）：**先读 `enableAutoModelDiscovery` 开关**（关闭则直接用内置列表）、过滤内置模型、从 API 和 models.dev 自动发现新增模型、按 apiMode 过滤 |
| `commands/registerCommands.ts` | ~130 | 注册全部 12 条命令（setApiKey / manageApiKeys / setVisionProxyModel / getApiKey / openSettings / generateGitCommitMessage / abortGitCommitMessage / setModelPreset / syncPush / syncPull / checkUsage）+ `onDidChangeConfiguration` 监听（apiMode / enableAutoModelDiscovery 变化时刷新模型列表） |
| `commands/apiKeyManagerUi.ts` | ~171 | `showApiKeyManager()` 主入口：**仅渲染主菜单 + 分发动作**（增删/批量导入/设为当前（仅 single 模式）/绑定 cookie/重置失效/检测可用性/编辑 key）；具体流程委托 `apiKeyFlows.ts`，展示委托 `apiKeyDisplay.ts` |
| `commands/apiKeyDisplay.ts` | ~138 | **key 展示辅助**（2026-09-28 新增，纯函数）：`formatBalanceDetailText`（余额格式化）、`fetchAccountInfo`（TTL 缓存查询）、`buildKeyDetailLine`（单 key 详情行）、`buildKeyQuickPickItems`（key 列表 QuickPick 项）。主界面 / key 选择界面 / 检测二级界面共用，展示逻辑只写一处 |
| `commands/apiKeyFlows.ts` | ~432 | **key 管理交互流程**（2026-09-28 新增）：`KeyManagerContext` 接口 + `queryBalanceFlow` / `addKeyFlow` / `batchImportFlow` / `pickKey` / `checkAvailabilityFlow` / `checkAllAvailabilityFlow` / `showCheckMenu` / `bindCookieFlow` / `editKeyFlow` |
| `commands/checkUsageCommand.ts` | ~60 | `checkUsageCommand()`：强制刷新套餐用量（绕过 TTL）并弹窗展示三窗口使用率 + 余额；区分未配置 token / 401 失效 / 一般失败三种错误 |
| `commands/visionProxyCommand.ts` | ~68 | `setVisionProxyModelCommand()`：从 `/v1/models` 动态加载 `supports_vision=true` 模型供 QuickPick 选择，API 不可用时回退手填 |
| `commands/modelPresetCommand.ts` | ~108 | `setModelPresetCommand()`：命名预设（Precise/Balanced/Creative）与自定义 temperature/top_p 输入 |
| `core/logger.ts` | ~43 | 日志输出 (LogOutputChannel) |
| `core/localize.ts` | ~213 | 中英文国际化 |
| `core/types.ts` | ~94 | `SenseAudioModelItem`, `ModelPreset`, `ModelsResponse`, `RetryConfig` 等类型 |
| `core/utils.ts` | ~294 | 工具函数 (重试、角色映射、工具转换等) |
| `core/versionManager.ts` | ~31 | 扩展版本信息 |
| `ui/statusBar.ts` | ~330 | 状态栏创建、更新、累计计数器；**套餐用量渲染**（主文本 `5H 65%` / 额度耗尽改显余额、悬停提示三窗口+倒计时+余额+计费模式）、后台轮询（`startUsagePolling`/`refreshPlanUsage`）、`refreshPlanUsageNow`（点击状态栏/命令强制刷新）；`showTokenStatusBar()` 受 `senseaudio.enableThirdPartyTokenIndicator`（**默认关闭**）控制 |
| `cloud/cloudSync.ts` | ~308 | 云同步（GitHub Gist）：`pushToCloud` / `pullFromCloud` / `autoPullOnStartup` |
| `gitCommit/commitMessageGenerator.ts` | ~441 | Git 提交消息生成逻辑（多 key 轮换循环） |
| `gitCommit/gitUtils.ts` | ~223 | Git 命令封装 |
| `tokenizer/tokenizerManager.ts` | ~97 | o200k_base 分词器管理 (含 LRU 缓存) |
| `tokenizer/provideToken.ts` | ~89 | Token 用量计算 |
| `tokenizer/imageUtils.ts` | ~113 | 图片尺寸解析 (PNG/GIF/JPEG/WebP) |
| `vision/types.ts` | ~100 | Vision proxy 类型定义（`StoredImage`, `InterceptedToolCall`, `ASK_IMAGE_TOOL_DEF`, `ASK_IMAGE_TOOL_NAME`, `ASK_WITH_MULTI_IMAGE_TOOL_DEF`, `ASK_WITH_MULTI_IMAGE_TOOL_NAME`, `DEFAULT_VISION_PROMPT`）+ **非视觉图片引用工厂**（2026-09-28 新增）：`buildUserImageReference(index)` / `buildToolImageReference(index)`（三协议 convertMessages 共用，消除 6 处重复字符串） |
| `vision/historyCodec.ts` | ~136 | 跨轮视觉历史编解码（源自上游 opencode-go-copilot v1.9.2）：`VISION_TOOL_HISTORY_MIME`、`VisionToolHistoryEntry`、`serializeVisionToolHistory`、`deserializeVisionToolHistory`、`toOpenAIVisionToolMessages`、`toAnthropicVisionToolMessages` |
| `vision/historyPart.ts` | ~18 | 跨轮视觉历史 DataPart 创建/解析（源自上游）：`createVisionToolHistoryPart`、`parseVisionToolHistoryPart` |
| `vision/imageProxy.ts` | ~150 | 图片代理核心：调用视觉模型描述图片（`callVisionModel`/`callVisionModelMulti`），**仅在本供应商（senseaudio）内查找视觉模型**（`findVisionModel` 多级回退，修复 issue #3），支持 thinking 模式配置和文本流式转发 |
| `typings/vscode.proposed.*.d.ts` | — | VS Code proposed API 类型声明（仅编译期类型补全，不影响运行时） |
| `scripts/build/clean.mjs` | ~17 | **清理 `out/`**（2026-09-28 新增）：`npm run compile` 前置步骤。`tsc` 不清理 `outDir`，源文件删除/移动后旧 `.js` 会残留并被 `vsce package` 打进 VSIX（曾出现已删除的 `legacyCookieApi.js` 等 24 个陈旧产物随包发布） |
| `scripts/build/build-info.mjs` | ~90 | 编译元信息生成：`npm run compile` 后自动运行，写入 `out/build-info.json`（版本号 + 编译时间，标注 IANA 时区与 UTC 偏移）并追加 `.copilot/build-log.md`（编译日志） |
| `scripts/build/package-vsix.mjs` | ~20 | VSIX 打包脚本（`npm run build`）：从 `package.json` 读取版本号，输出名固定为 `senseaudio-copilot-<version>.vsix`（如 `senseaudio-copilot-1.10.0.vsix`，发布命名规范，不用 vsce 默认的 `extension.vsix`） |
| `scripts/build/copy-tokenizer.js` | ~55 | postinstall：确保 `assets/model/o200k_base.tiktoken` 存在，缺失时从 OpenAI 公共存储下载 |
| `scripts/dev/check-new-models.mjs` | ~244 | 检查 API 新模型（对比内置清单） |
| `scripts/dev/check-settings.mjs` | ~70 | **设置项一致性核对**：扫描 `src/**/*.ts` 中所有 `getConfiguration` 读取（含带前缀 / 无前缀 / 常量键 / **嵌套配置节**四种形式），与 `package.json` 的 `contributes.configuration` 双向 diff，输出「已用未声明」与「已声明未用」。**已挂到 `npm run compile`**（有漂移则编译失败）。用于防止设置项漂移（曾发现 `enableAutoModelDiscovery` 声明了但代码从未读取、`senseaudio.retry.*` 四个设置从未声明） |
| `scripts/dev/audit-all.mjs` | ~150 | **完整审计**（`npm run audit`）：7 项检查一次跑完——① 设置项漂移 ② 未使用导出 ③ 未使用 l10n 键 ④ `package.nls.json` / `package.nls.zh-cn.json` 键集合一致性 ⑤ 命令声明 vs 注册 ⑥ 文档引用的文件路径是否存在 ⑦ 测试脚本引用的 `out/` 路径是否存在 |
| `test/api-tests.mjs` | ~282 | 三协议 API 完整测试脚本（OpenAI/Anthropic/Responses，第 9b 项含生产 400 回归用例） |
| `test/test-plan-usage.mjs` | ~250 | **套餐用量快照测试**（29 项断言）：窗口归一化（各平台 key 命名）、百分比（pending 计入/超额不截断）、超额判定（只看月度窗口）、三态计费模式、倒计时、摘要格式化、**真实 API 夹具回归**（代金券 200 倍换算 bug）；运行前需 `npm run compile` |
| `test/test-transient-retry.mjs` | ~120 | **瞬态错误分类测试**（13 项断言）：500 命中瞬态重试但**不**命中 key 轮换（平台问题不换 key）、429/503 两者都命中（回归）、400/403 都不命中、401/402 仅轮换、失效原因提取；运行前需 `npm run compile` |
| `test/test-vision-history.mjs` | ~155 | 跨轮视觉历史编解码 + 双 API 转换器闭环测试（源自上游 opencode-go-copilot v1.9.2，含 DeepSeek 空 reasoning_content 回归用例；运行前需 `npm run compile`） |
| `test/test-anthropic-tool-result-merge.mjs` | ~168 | Anthropic 连续工具结果合并测试（源自上游，issue #87 场景：3 个并行 tool_use 结果合并为单条 user 消息；运行前需 `npm run compile`） |
| `test/test-*.mjs`（其余） | — | 令牌应用 / 封号检测 / 封号轮换 / 模型差异 / Responses 复检 / 视觉能力检查等专项测试 |

---

## 4. 函数定义大全

### 4.1 `src/extension.ts`

#### `activate(context: vscode.ExtensionContext): void`
扩展激活入口。**仅编排**：初始化日志、分词器、状态栏；注册 `LanguageModelChatProvider`；委托 `registerCommands(context, provider)` 注册全部命令；触发启动任务（`syncModelsOnStartup` / `autoPullOnStartup`）。**不弹任何引导界面**——未配置 key 时启动静默，key 管理仅经显式命令进入。

#### `deactivate(): void`

---

### 4.1a `src/commands/registerCommands.ts`

#### `registerCommands(context, provider): void`
注册扩展的全部命令与配置变更监听，所有 disposable 推入 `context.subscriptions`。含 `onDidChangeConfiguration` 监听（`senseaudio.apiMode` / `senseaudio.enableAutoModelDiscovery` 变化时调用 `provider.notifyModelListChanged()`）与 11 条命令：`setApiKey`（旧版单 key 流程，写入多 key store）、`manageApiKeys`（委托 `showApiKeyManager`）、`setVisionProxyModel`（委托 `setVisionProxyModelCommand`）、`getApiKey`（打开官网）、`openSettings`、`generateGitCommitMessage` / `abortGitCommitMessage`、`setModelPreset`（委托 `setModelPresetCommand`）、`syncPush` / `syncPull`（委托 `pushToCloud` / `pullFromCloud`）。

---

### 4.1b `src/commands/apiKeyManagerUi.ts`

#### `showApiKeyManager(context: vscode.ExtensionContext): Promise<void>`
多 Key 管理 QuickPick 主流程（`senseaudio.manageApiKeys` 命令）。**仅渲染主菜单 + 分发动作**：构造 `KeyManagerContext`（`secrets` + `getLoginToken`/`setLoginToken`，登录 token 存 `globalState` 的 `senseaudio.loginToken`），循环渲染 key 列表（经 `buildKeyQuickPickItems`，脱敏显示 + 可用性/当前使用/固定使用/cookie 状态/账号余额）与动作项，直到用户取消。动作分发到 `apiKeyFlows.ts`：添加 Key（`addKeyFlow`）、批量导入（`batchImportFlow`）、删除 Key（`pickKey` + 二次确认 + `removeApiKey`）、设为当前使用（仅 single 模式渲染；`pickKey` + `setActiveKey`）、编辑 Key（`pickKey` + `editKeyFlow`）、重置失效状态（`resetExhaustedKeys(secrets, true)`）、检测可用性（`showCheckMenu`）、绑定/更新 Cookie（`pickKey` + `bindCookieFlow`）、清除 Cookie（`pickKey` + `setKeyCookie(secrets, index, undefined)`）。

---

### 4.1b-2 `src/commands/apiKeyDisplay.ts`（2026-09-28 新增）

#### `formatBalanceDetailText(info, minBalance): string`
格式化账号余额为显示文本：现金余额（充值）+ 代金券可用（赠送，含最早到期日）。图标依据**合计可用余额**（现金 + 代金券）——> `minBalanceCny` 为 `$(coin)`、≤ 为 `$(error)`。

#### `fetchAccountInfo(getLoginToken): Promise<AccountInfo | undefined>`
查询账号余额（TTL 缓存）。数据源为登录 PASETO token 查 `platform.senseaudio.cn/api/user/self`（`getAccountInfoCached`）。余额按**账号**粒度，所有 key 共享同一份。无 token 或查询失败 → undefined（UI 显示"余额未知"）。

#### `buildKeyDetailLine(entry, balanceText, options?): string`
构建单个 key 的详情行（与主界面 `render()` 一致）：可用性状态（`$(check)` 可用 / `$(error)` 不可用 / `$(clock)` 冷却（含剩余秒数）/ `$(question)` 未检测）+ 账号余额 + `$(star)` 当前使用（仅 single 模式）+ `$(pinned)` 固定使用（仅 sticky 模式）+ cookie 绑定状态。主界面、key 选择界面、检测二级界面共用，展示逻辑只写一处。

#### `buildKeyQuickPickItems(store, getLoginToken, action): Promise<QuickPickItem[]>`
构建 key 列表的 QuickPick 项（label + 详情行）。统一处理：账号余额查询（TTL 缓存）、模式判定（single/sticky 的当前/固定标记）、逐 key 详情行（`buildKeyDetailLine`）。主界面 `render()`、key 选择界面 `pickKey()`、检测二级界面 `showCheckMenu()` 共用。

---

### 4.1b-3 `src/commands/apiKeyFlows.ts`（2026-09-28 新增）

#### `interface KeyManagerContext`
`{ secrets: vscode.SecretStorage; getLoginToken: () => string | undefined; setLoginToken: (token) => Promise<void> }` — 流程上下文，避免闭包耦合。

#### `queryBalanceFlow(ctx): Promise<void>`
查询余额/套餐用量流程（登录 token）。无 token 时提示输入（F12 → Local Storage → `user.state.token`）；查询失败（token 失效/网络）时提示重新输入并清空已存 token。

#### `addKeyFlow(ctx): Promise<boolean>`
添加单个 key 流程（依次输入 key → cookie → label 三元组）。重复值提示已存在并返回 false。

#### `batchImportFlow(ctx): Promise<void>`
批量导入流程：表单式逐条输入 (key/cookie/label) 三元组，Finish 时 `addApiKeys` 一次性写入；已存在的 key 自动更新 cookie（不重复添加）。

#### `pickKey(ctx, title): Promise<{ index, entry } | undefined>`
选择一个 key（删除/设为当前/编辑/绑定/清除 cookie 共用）。复用主界面同款 QuickPick 项（`buildKeyQuickPickItems`），让用户在删除/编辑前能区分各个 key。

#### `checkAvailabilityFlow(ctx, index): Promise<void>`
检测单个 key 的可用性（`testKeyAvailability` 最小真实聊天请求），并更新其可用状态。402 → 提示"余额不足（≤ 阈值）"；401 → "Key 已失效"；无法确定 → "请稍后重试"。

#### `checkAllAvailabilityFlow(ctx): Promise<void>`
检测全部 key 的可用性（带进度条遍历），汇总"可用/不可用/未知"。

#### `showCheckMenu(ctx): Promise<void>`
检测可用性二级界面：列出全部 key 状态（`buildKeyQuickPickItems`）+ "检测所有" + "查询余额" + "返回"。

#### `bindCookieFlow(ctx, index): Promise<void>`
绑定/更新 cookie 流程（空输入 = 清除）。

#### `editKeyFlow(ctx, index): Promise<void>`
编辑 key 流程（value / cookie / label 三字段，value 冲突校验）。

---

### 4.1c `src/commands/visionProxyCommand.ts`

#### `setVisionProxyModelCommand(context): Promise<void>`
视觉代理模型选择命令（`senseaudio.setVisionProxyModel`）。从 `/v1/models` 动态加载 `supports_vision=true` 的模型列表供 QuickPick 选择，API 不可用时回退到手动输入。

---

### 4.1d `src/commands/modelPresetCommand.ts`

#### `setModelPresetCommand(): Promise<void>`
模型温度预设选择命令（`senseaudio.setModelPreset`）。提供命名预设（Precise/Balanced/Creative 等）与自定义输入（单个数字 = temperature，两个逗号分隔数字 = temperature + top_p）。

---

### 4.1e `src/provider/requestOptions.ts`

#### `applyReasoningEffort(um, options): void`
应用推理强度（thinking 模式）到模型配置。`"disabled"` → 关闭思考（`thinkingMode="always"` 的模型除外）；`"enabled"` → 开启思考使用默认力度；`"adaptive"`/`"high"`/`"max"` 等 → 开启思考并指定力度。

#### `applyTemperature(um, config): void`
注入 temperature / top_p（模型预设或自定义设置）。模型声明 `supportsTemperature === false` 时清空两者；模型声明 `fixedTopP`（如 kimi-k2.6 仅接受 0.95）时覆盖用户/预设配置。

#### `resolveApiMode(modelId, config): "openai" | "anthropic" | "responses"`
确定本次请求使用的 API 协议。`senseaudio.apiMode` 用户设置优先（强制）；`auto` 时按能力动态探测（启动时从 `/v1/models` 缓存，不硬编码模型 ID）：`enableResponsesApi` + supports_responses → responses；`enableAnthropicApi` + supports_anthropic → anthropic；否则 openai。

---

### 4.1f `src/provider/rotation.ts`

#### `runKeyRotationLoop(params): Promise<void>`
多 API Key 轮换循环。每轮选一个 key，跳过余额不足（cookie 主动预检）或返回轮换错误（401/402/429/503，状态码与文本 patterns 可配置）的 key。全部 key 用尽时列出脱敏 key + 失败原因；若失败均为瞬态（429/503）则按 `senseaudio.transientRetryTimes` 指数退避重试整轮。**平台侧瞬态错误（500）强制同 key 重试**：`forceKey` 记住当前 key，下一轮强制复用（rotation 模式游标已前移，不强制会静默换 key，违背"500 不换 key"承诺）。**重试计数器按场景分离**：`wholeRoundRetryCount`（全部 key 瞬态失败/无可用 key 整轮重试）与 `sameKeyRetryCount`（500 同 key 重试）独立计数，500 重试不消耗 429/503 整轮配额。single 模式 fallback=switch 时仅在余额不足（402/预检）时切换并经 `setActiveKeyByValue` 设为当前（`onFallbackSwitch` 回调触发通知）。参数：`secrets` / `token` / `abortController` / `execute(apiKey, requestHeaders)` / `customHeaders` / `apiMode` / `onFallbackSwitch`。

---

### 4.1g `src/provider/apiDispatch.ts`

#### `executeApiRequest(params): Promise<void>`
单次 API 请求执行：协议分发（openai / anthropic / responses）、请求体构建、`executeWithRetry`、流式处理、零正文预算耗尽检测（`checkZeroAnswerBudgetExhausted`）、以及 ask_image 视觉代理的后续轮次（`handleInterceptedToolCall`）。轮换循环内每个 key 调用一次；错误直接抛出，由调用方决定是否换 key。

---

### 4.1h `src/provider/visionRounds.ts`

#### `handleInterceptedToolCall(params): Promise<void>`
图片代理（ask_image）多轮处理。非视觉模型收到图片时 `convertMessages` 把图片替换为文本引用并存入实例的 `localImages`；模型调用 `ask_image` / `ask_with_multi_image` 被 `CommonApi` 拦截到 `interceptedToolCall`。本函数：① 用模型的具体提问调用视觉模型（流式转发到 thinking 块）；② 输出跨轮视觉历史 DataPart（VS Code 自动带入下一轮对话）；③ 构建 assistant tool_call + tool result 消息并再次请求；④ 若模型再次调用 ask_image 则继续下一轮（最多 `senseaudio.visionMaxRounds` 次）。**视觉代理轮内失败不触发 key 轮换**（主请求已成功、tool 上下文已建立，换 key 会不一致），直接报错由用户重试整个请求。

#### `runAnthropicRound(params, api, currentMessages, intercepted, description, hasLocalImages, roundAbortController): Promise<void>`（模块级私有）
Anthropic 格式轮次：`tool_use` + `tool_result` content block；恢复 `system` 与 `thinking` 配置（启用→`{ type: "enabled", budget_tokens: 8192 }` / adaptive→`{ type: "adaptive" }` / 禁用→`{ type: "disabled" }`）；工具用 Anthropic 格式（`name`/`description`/`input_schema`）。

#### `runResponsesRound(...): Promise<void>`（模块级私有）
Responses 格式轮次：文本化回填（assistant `output_text` `[tool_call] name(args) [/tool_call]` + user `input_text` `[tool_result] ... [/tool_result]`，因端点拒绝 function_call 块）；工具用扁平格式 `{ type: "function", name, description, parameters }`。

#### `runOpenAIRound(...): Promise<void>`（模块级私有）
OpenAI 格式轮次：assistant `tool_calls` + `tool` role 消息；DeepSeek 兼容注入 `reasoning_content`（取自 `api.capturedReasoningContent`，用后清空）。

---

### 4.1i `src/provider/errors.ts`

#### `REASON_TEXT: Record<string, string>`
key 轮换失败原因 → 人类可读标签（l10n key）：`balance`/`invalid`/`rate_limited`/`server_error`/`api_error`/`unavailable`/`banned`。

#### `checkZeroAnswerBudgetExhausted(api, collectedOutputText, modelId): void`
零正文预算耗尽检测：流式处理结束后，若结束原因为 `length`/`max_tokens` 且累计正文为空，抛出友好错误并记录 `request.zeroAnswer` 日志——避免思考模型把 max_tokens 预算全部耗在推理后静默返回空流。

#### `buildAllKeysUnavailableDetail(secrets): Promise<string>`
构建"全部 API Key 均不可用"的脱敏原因详情：遍历 store 中每个 key，用 `getKeyUnavailableReason` 取当前状态原因，生成 `sk_****abcd: 服务端繁忙 (503)` 列表（`; ` 连接）。

#### `tryTransientRetryRound(secrets, retryCount, maxRetries): Promise<boolean>`
瞬态失败（429/500/503）整轮自动重试辅助。达到上限返回 false；否则**清空瞬态冷却**（`resetExhaustedKeys(secrets, false)`，不触碰持久化 unavailable——冷却期间 `pickNextApiKey` 会跳过全部 key 使重试无效）、指数退避等待（2s/4s/8s，上限 8s）后返回 true。两种调用场景：① 全部 key 均因瞬态错误失败（429/503）→ 清冷却后重试整轮让 key 重新可选；② 平台侧错误但 key 无问题（如 500）→ 不标记 key，仅退避后重试同一个 key。

#### `reportNativeUsage(usage, progress): void`
向 Copilot Chat 原生 Token 指示器报告用量：发送 MIME 类型为 `usage` 的 `LanguageModelDataPart`（TextEncoder 编码 JSON，含 `prompt_tokens` / `completion_tokens` / `total_tokens` / `prompt_tokens_details.cached_tokens`）。始终启用。

#### `getRequestedReasoningEffort(options): string | undefined`
从 VS Code 请求选项中解析用户选择的推理强度。依次检查 `modelConfiguration.reasoningEffort`、`modelOptions.thinking.type`、`modelOptions.reasoning_effort` / `reasoningEffort`。

---

### 4.1j `src/api/sse.ts`

#### `interface SseEvent`
`{ parsed?: unknown; raw: string; done: boolean }` — 单条 SSE 事件（`done === true` 表示 `[DONE]` 哨兵）。

#### `interface SseStreamOptions`
`{ tag: string; modelId: string; token?: CancellationToken; signal?: AbortSignal; debugChunks?: boolean }` — 流解析选项（`tag` 用于日志前缀，如 `"openai"` → `openai.stream.chunk.error`）。

#### `iterateSseEvents(responseBody, options): AsyncGenerator<SseEvent>`
逐条产出 SSE 事件。负责 reader 生命周期、`data:` 前缀解析、`[DONE]` 哨兵、取消回调注册（`token.onCancellationRequested` / `signal` abort）与 finally 清理。解析失败的 chunk 记录日志并跳过（不中断流）。

#### `consumeSseStream(responseBody, options): Promise<void>`
回调式消费 SSE 流（`onEvent` / `onDone` / `onFinally`），统一处理开始/结束/错误日志与 finally 清理。三协议 `processStreamingResponse` 共用。

---

### 4.1k `src/keys/` 模块

> `keys/keyManager.ts` 为 barrel，统一导出以下模块的全部 API（保持既有 `../keys/keyManager` 导入路径不变）。

#### `keys/types.ts`
`ApiKeyEntry` / `ApiKeyStore` / `ApiKeyMode` / `SingleKeyFallback` / `KeyDisplayStatus` 类型定义。

#### `keys/config.ts`
`getApiKeyMode` / `getRotationCursorIndex` / `getSingleKeyFallback` / `getRotationStatusCodes` / `getRotationErrorPatterns` / `getTransientRetryStatusCodes`（默认 `[429, 500, 503]`）/ `getExhaustedCooldownMin` / `getTransientRetryTimes`。

#### `keys/state.ts`
模块级可变状态（独立成文件避免循环依赖）：`STORE_KEY` / `LEGACY_KEY` 常量、`getStoreCache`/`setStoreCache`、`getRotationIndex`/`setRotationIndex`、`getTransientExhaustedMap`。

#### `keys/store.ts`
`getApiKeyStore`（含旧版单 key 迁移与 JSON 损坏修复）/ `saveApiKeyStore` / `invalidateApiKeyStoreCache` / `addApiKey` / `addApiKeys` / `removeApiKey`（**同步清理被删 key 的瞬态冷却条目**，避免内存残留与同 value 新 key 继承旧冷却）/ `setActiveKey` / `setKeyCookie` / `updateApiKey`。

#### `keys/selection.ts`
`getPrimaryApiKey` / `pickNextApiKey`（rotation 前移游标 / sticky 钉住游标）/ `shouldSingleKeyFallbackSwitch` / `setActiveKeyByValue`。

#### `keys/health.ts`
`getTransientExhaustedInfo` / `isApiKeyEligible` / `hasTransientExhaustedKey` / `isKeyRotationError` / `isTransientRetryError` / `isTransientExhaustedReason` / `getKeyRotationReason`（**状态码优先**，文本仅在对应状态码命中时参与判定，避免 429/503 响应体偶然包含"余额不足"时误分类为 balance 并持久化禁用 key；状态码匹配用 `\b` 边界）/ `getKeyUnavailableReason` / `markApiKeyExhausted` / `markApiKeyAvailable` / `updateKeyAvailability` / `resetExhaustedKeys` / `getKeyDisplayStatus`。

#### `keys/mask.ts`
`maskApiKey` / `maskCookie` 脱敏。

---

### 4.1l `src/balance/` 模块

> `balance/balanceCheck.ts` 为 barrel，统一导出以下模块的全部 API。

#### `balance/config.ts`
`getMinBalanceCny`（余额阈值，仅用于 UI 标记充值余额不足）/ `getBalanceCheckIntervalSec`（账号信息缓存 TTL）/ `toNumber`（金额字符串转 number 防御）。

#### `balance/accountInfo.ts`
`queryAccountInfo(loginToken)`（`GET platform.senseaudio.cn/api/user/self`，Bearer PASETO token + `x-platform`/`x-product` 必需头）/ `getAccountInfoWithStatus(loginToken, ttlSec, force?)`（带状态返回：`ok`/`unauthorized`/`error`，供状态栏与命令区分 401）/ `getAccountInfoCached(loginToken, ttlSec)`（TTL 缓存，失败返回 undefined）/ `formatExpiryDate(epochSec)`（代金券到期日 → `YYYY-MM-DD` 本地时区）+ `POINTS_PER_CNY`（**1 元 = 1,000,000 积分**，2026-09-27 实测校正）+ `AccountInfo` / `PlanUsageWindow` / `AccountInfoFetchStatus` 类型。`earliestVoucherExpiry` 仅统计有到期日的代金券（全部永不过期时返回 null 而非 Infinity，与类型声明语义一致）。

#### `balance/planUsage.ts`
**套餐用量快照模块**（对标上游 opencode-go-copilot 的 `goUsage.ts`）。核心是**严格区分两套计费规则**：周期额度（5h/周）是限流窗口，耗尽后等下一周期恢复、不消耗余额；套餐积分（月度 `credit_30d_limit`）才是订阅额度，耗尽后走超额策略。

- `buildSnapshot(info, now?)`（纯函数）：归一化为 `PlanUsageSnapshot`，含 `quotaWindow`（月度额度窗口）/ `rateLimitWindows`（5h+周）/ `balance` / `extraUsageEnabled` / 三态 `billingMode`（`plan`/`extra`/`free`）
- `getPlanUsageCached(loginToken, force?)`：TTL 缓存 + **失败保留旧快照**（静默降级）+ **换 token 时旧账号快照立即失效**（`cachedToken` 跟踪，避免状态栏短暂显示他人数据）
- `getPlanUsageSnapshot()`：同步读缓存（状态栏渲染用，不触发网络）
- `getPlanUsageFetchStatus()` / `resetPlanUsageCache()`
- `classifyWindow(key, desc)`：宽容匹配各平台 key 命名（`5h`/`rolling`/`5小时`、`7d`/`week`/`周`、`30d`/`month`/`月`），无法识别回退 `other`
- `getWindowLabel(window)`：`5H` / `Week` / `Month` / 原始 desc
- `getWindowPercent(window)`：0-100+，`pendingCount` 计入已用，**不夹取上限**（超额如实显示 150%）
- `isWindowExhausted(window)` / `isPlanExhausted(snapshot)`（**只看月度额度窗口**）/ `getBillingMode(snapshot)`
- `getPrimaryWindow(snapshot)`：优先 5h 窗口（状态栏主文本用）
- `formatResetDuration(epochSec, now?)`：`2H13M` / `45M`，过期返回空串
- `formatUsageSummary` / `formatWindowLine`（`5H——65% (6,500 / 10,000 积分)`）/ `formatBillingModeLine`（三态说明）/ `formatBalanceSummary`

> 设计与移植指南见 `docs/plan-usage-design.md`。

#### `balance/availability.ts`
`testKeyAvailability(entry, baseUrl?)`：最小真实聊天请求（`say ok` + `max_tokens=8`）——200→可用 / 402→余额不足 / 401→无效 / 其他→无法确定。

> **已删除（2026-09-27）**：旧平台 cookie 端点模块 `legacyCookieApi.ts`（`/api/usage-summary`、`/api/api-keys` 均已 404）及其派生的 `checkKeyBalance` / `isKeyBalanceSufficient` 主动余额预检、`BalanceDetail` / `ApiKeyListItem` 类型、平台 Key 数量展示。余额不足改由 API 返回 402 触发被动轮换。

---

### 4.1m `src/commands/checkUsageCommand.ts`

#### `checkUsageCommand(context): Promise<void>`
套餐用量查询命令（`senseaudio.checkUsage`）。强制刷新（`refreshPlanUsageNow()` 绕过 TTL）并弹窗展示三窗口使用率 + 余额。错误区分：未配置 token（提示并跳转 `manageApiKeys`）/ 401 token 失效（提示重新复制）/ 一般失败（提示查看输出通道）。同时绑定到状态栏条目点击。

---

### 4.1n `src/cloud/cloudSync.ts`

#### `getGitHubSession(createIfNone: boolean): Promise<vscode.AuthenticationSession | undefined>`（模块级私有）
获取 VS Code 内置 GitHub 登录会话（`vscode.authentication.getSession("github", ["gist"])`）。`createIfNone=true` 时未登录弹出登录界面；false 时静默返回 undefined。认证失败记日志返回 undefined。

#### `gistFetch(session, url, init?): Promise<Response>`（模块级私有）
带 GitHub 认证的 fetch（Bearer token + `X-GitHub-Api-Version: 2022-11-28`），非 2xx 抛出含状态码与响应体的错误。

#### `findSyncGist(session): Promise<GistSummary | undefined>`（模块级私有）
按 description 标记（`senseaudio-copilot key sync (do not edit manually)`）+ 文件名（`senseaudio-keys.json`）在用户 Gist 列表中查找同步 Gist（前 3 页，每页 100）。

#### `fetchSyncPayload(session, gistId): Promise<SyncPayload | undefined>`（模块级私有）
读取 Gist 文件内容并解析为负载（`{ version: 1, updatedAt, keys }`）；缺失/损坏返回 undefined。

#### `normalizeEntries(keys): SyncedKeyEntry[]`（模块级私有）
规范化同步条目：过滤空 value，cookie/label 去空白。

#### `buildPayload(keys): SyncPayload`（模块级私有）
将本地 store 序列化为同步负载（仅 value/cookie/label，可用性状态不同步）。

#### `pushToCloud(context): Promise<void>`
推送本地 key/cookie/备注 到云端 Gist（`senseaudio.syncPush` 命令）。未登录时弹登录界面；无 key 时警告返回。**push/pull 模块级互斥**（`syncInFlight`，重叠时警告返回，防止 pull 用旧 store 快照覆盖 push 结果）。Gist 定位：缓存 gist id（PATCH 404 回退）→ 按描述查找 → 创建新 Gist（`public: false`）。**POST 响应解析不出 id 时抛错走 catch 分支**（不更新时间戳、不报成功），避免"假成功"污染 `lastCloudSyncAt`。成功后更新 `globalState` 的 `senseaudio.lastCloudSyncAt` 并弹窗提示。

#### `pullFromCloud(context, silent = false): Promise<boolean>`
从云端 Gist 拉取 key/cookie/备注 覆盖本地（`senseaudio.syncPull` 命令）。**push/pull 模块级互斥**（`syncInFlight`，silent 模式静默返回 false）。合并策略：云端为源——按 key 值对齐，云端条目覆盖本地 cookie/label，云端有本地无的追加、本地有云端无的删除；可用性状态（available/lastCheckedAt）为本地数据按 key 值保留；activeIndex 按 key 值跟随。无变更时不写 store 仅更新同步时间戳。**缓存 gist id 失效回退**：缓存 id 拉取失败（404 等，Gist 在其他机器被删除重建）时清缓存回退 `findSyncGist` 重新查找，避免自动拉取从此每次启动静默失败。**时间戳用 GitHub 服务端时间**：`fetchSyncPayload` 优先取 Gist API 的 `updated_at` 覆盖负载内时间戳，消除客户端时钟偏差导致的漏拉。`silent=true`（启动自动拉取）时：未登录/无 Gist/云端无更新（`updatedAt <= lastSyncAt`）均静默返回 false，拉取成功弹窗提示。

#### `autoPullOnStartup(context): void`
启动自动拉取入口（fire-and-forget，不阻塞激活）。读取 `senseaudio.cloudSyncAutoPull` 配置（默认开启），关闭则直接返回；未登录 GitHub 时静默跳过不弹登录界面。

---

### 4.2 `src/models/models.ts`

#### `interface BuiltInModelDef`
内置模型定义接口。

| 属性 | 类型 | 说明 |
|------|------|------|
| `baseId` | `string` | API 请求中使用的模型 ID |
| `displayName` | `string` | 用户友好的显示名称 |
| `vision` | `boolean` | 是否支持图片输入（所有模型 `imageInput` 能力声明为 `true`，非视觉模型通过代理处理） |
| `thinkingMode` | `"switchable" \| "always" \| "adaptive"` | switchable=可选择思考开关, always=思考始终启用, adaptive=仅禁用/自动 |
| `defaultReasoningEffort` | `string` (可选) | 默认推理力度 |
| `supportedReasoningEfforts` | `string[]` (可选) | 支持的推理力度选项 |
| `includeReasoningInRequest` | `boolean` (可选) | 是否在 assistant 消息中包含 reasoning_content |
| `supportsTemperature` | `boolean` (可选) | 是否支持设置 temperature/top_p，默认 true |
| `fixedTopP` | `number` (可选) | 模型仅接受的固定 top_p 值（如 kimi-k2.6 仅允许 0.95），provider 自动覆盖用户/预设配置的 top_p |
| `contextLength` | `number` (可选) | 默认上下文长度 |
| `maxTokens` | `number` (可选) | 默认最大输出 Token |
| `extra` | `Record<string, unknown>` (可选) | 额外的请求体参数 |
| `apiMode` | `"openai" \| "anthropic" \| "responses"` (可选) | API 格式模式 |

#### `const BUILT_IN_MODELS: BuiltInModelDef[]`
16 个内置模型定义常量数组（来源：[SenseAudio 模型页](https://docs.senseaudio.cn/guides/account/model-list-billing)；glm-5.3/glm-5.3-flash 于 2026-09-03 经 `/v1/models` 实测确认后内置化）。

#### `getBuiltInModelInfos(): LanguageModelChatInformation[]`
将内置模型定义转换为 VS Code 的模型信息列表。每个模型注册**一个条目**，带 `isUserSelectable: true` 确保在模型选择器中可见（VS Code 1.120+ 要求），并通过 `configurationSchema` 附加推理强度选择器（中文标签）。switchable 模型显示 `禁用思考/思考` 或 `禁用思考/高/最大`（可关闭推理）；adaptive 模型仅显示 `禁用思考/自动`；always 模型不显示 `禁用思考` 选项，仅在支持推理强度时显示强度选项。`maxInputTokens` 按真实上下文窗口的**可配置比例**声明（`getMaxInputTokensRatio()` 读取 `senseaudio.maxInputTokensRatio` 设置，默认 `1.0`，建议 `0.8`，`Math.floor` 取整，范围 0.1–1.0），使 VS Code 的 agent 自动压缩（约 90% 阈值）能在真实上下文的约 72%（比例 0.8 时）处触发；`context_length` / `max_completion_tokens` 保持真实值用于 API 请求体。

#### `getBuiltInModelCount(): number`
返回内置模型定义总数（BUILT_IN_MODELS.length）。

#### `getBuiltInModelIds(): Set<string>`
返回所有内置模型的 baseId 集合。供 `src/models/modelSync.ts` 在启动同步时对比 API 模型列表，检测不在内置列表中的新模型。

#### `getMaxInputTokensRatio(): number`
读取可配置的 `maxInputTokens` 声明比例（设置 `senseaudio.maxInputTokensRatio`，默认 `1.0`，建议 `0.8`），并夹取到合法范围 [0.1, 1.0]。设置缺失或非法时回退到默认值。`maxInputTokens` 按真实上下文窗口 × 该比例声明（`Math.floor` 取整），使 VS Code 的 agent 自动压缩（约 90% 阈值）能在真实上下文的约 72%（比例 0.8 时）处触发；`context_length` / `max_completion_tokens` 保持真实值用于 API 请求体。

#### `getBuiltInModelConfig(modelId: string): SenseAudioModelItem | undefined`
按模型 ID 查找内置模型定义，返回对应的模型配置对象（含 thinkingMode、默认推理力度、API 模式、extra 参数等）。思考模式的具体启用状态由 provider.ts 根据 reasoningEffort 配置动态决定。

---

### 4.3 `src/core/types.ts`

#### `interface SenseAudioModelItem`
完整模型配置接口。

| 属性 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 模型 ID |
| `owned_by` | `string` | 提供商 |
| `configId` | `string` (可选) | 配置 ID（保留兼容） |
| `displayName` | `string` (可选) | 显示名称 |
| `baseUrl` | `string` (可选) | 自定义 Base URL |
| `context_length` | `number` (可选) | 上下文长度 |
| `vision` | `boolean` (可选) | 是否支持视觉 |
| `max_completion_tokens` | `number` (可选) | 最大输出 Token (新标准) |
| `reasoning_effort` | `string` (可选) | 推理力度 |
| `enable_thinking` | `boolean` (可选) | 是否启用 thinking |
| `thinking_budget` | `number` (可选) | Thinking 预算 Token |
| `temperature` | `number \| null` (可选) | 温度参数 |
| `top_p` | `number \| null` (可选) | Top-p 采样 |
| `top_k` | `number` (可选) | Top-k 采样 |
| `min_p` | `number` (可选) | Min-p 采样 |
| `frequency_penalty` | `number` (可选) | 频率惩罚 |
| `presence_penalty` | `number` (可选) | 存在惩罚 |
| `repetition_penalty` | `number` (可选) | 重复惩罚 |
| `reasoning` | `object` (可选) | OpenRouter 推理配置 |
| `extra` | `Record<string, unknown>` (可选) | 额外请求体参数 |
| `family` | `string` (可选) | 模型系列 |
| `include_reasoning_in_request` | `boolean` (可选) | 是否在请求中包含推理内容 |
| `thinkingMode` | `"switchable" \| "always"` (可选) | 思考模式类型 |
| `supportsTemperature` | `boolean` (可选) | 是否支持设置 temperature/top_p，默认 true |
| `useForCommitGeneration` | `boolean` (可选) | 是否用于提交消息生成 |
| `delay` | `number` (可选) | 模型专属请求延迟 |
| `apiMode` | `string` (可选) | API 模式 |
| `headers` | `Record<string, string>` (可选) | 自定义 HTTP 头 |

#### `interface ModelsResponse`
`{ object: string; data: ModelItem[] }` — 模型列表 API 响应。

#### `interface ModelItem`
`{ id, object?, created?, owned_by? }` — 单个模型条目。

#### `interface ModelPreset`
`{ id, label, temperature, top_p }` — 模型预设配置，用于快速切换温度和 top_p。

#### `interface RetryConfig`
`{ enabled, maxAttempts, intervalMs, backoffFactor, maxIntervalMs, statusCodes }` — 重试配置。

---

### 4.4 `src/api/commonApi.ts`

#### `interface StreamUsage`
`{ promptTokens, completionTokens, cacheHitTokens?, cacheMissTokens? }` — 流式用量信息。

#### `abstract class CommonApi<TMessage, TRequestBody>`
API 实现的抽象基类。

| 属性 | 类型 | 说明 |
|------|------|------|
| `_toolCallBuffers` | `Map<number, {id?, name?, args}>` | 工具调用参数缓冲区 |
| `_completedToolCallIndices` | `Set<number>` | 已完成发射的工具调用索引 |
| `_hasEmittedAssistantText` | `boolean` | 是否已发射过助手文本 |
| `_hasEmittedText` | `boolean` | 是否已发射过文本 |
| `_hasEmittedThinking` | `boolean` | 是否已发射过推理内容 |
| `_emittedBeginToolCallsHint` | `boolean` | 是否已发射工具调用前导空格 |
| `_lastFinishReason` | `string \| undefined` | 最近一次流的结束原因（`length`/`max_tokens`/`stop`/`tool_calls` 等），供 `checkZeroAnswerBudgetExhausted` 零正文预算耗尽检测使用；经 `lastFinishReason` 公共 getter 暴露 |
| `_xmlThinkActive` | `boolean` | XML think 块解析中 |
| `_xmlThinkDetectionAttempted` | `boolean` | 是否尝试过 XML think 检测 |
| `_currentThinkingId` | `string \| null` | 当前推理内容 ID |
| `_thinkingBuffer` | `string` | 推理内容缓冲区 |
| `_thinkingFlushTimer` | `NodeJS.Timeout \| null` | 推理刷新定时器 |
| `_systemContent` | `string \| undefined` | 系统提示内容 |
| `_modelId` | `string` | 模型 ID |
| `_onUsage` | `((usage: StreamUsage) => void) \| undefined` | 用量回调 |
| `interceptedToolCall` | `InterceptedToolCall \| null` | 被拦截的 ask_image 工具调用 |
| `_localImages` | `StoredImage[]` | 实例局部图片数据，请求结束随 GC 回收 |
| `_originalApiMessages` | `any[] \| null` | 转换后的原始 API 消息，用于构建多轮请求 |

#### `abstract convertMessages(messages, modelConfig): TMessage[]`
将 VS Code 聊天消息转换为特定 API 格式的消息数组。modelConfig 新增 `vision` 字段，非视觉模型时自动替换图片为文本引用并存储图片数据。

#### `abstract prepareRequestBody(rb, um, options?): TRequestBody`
构建特定 API 的请求体。非视觉模型且存在图片时自动注入 `ask_image` 工具定义。

#### `abstract processStreamingResponse(responseBody, progress, token): Promise<void>`
处理特定 API 的流式响应。

#### `protected tryEmitBufferedToolCall(index, progress): Promise<void>`
当工具调用的名称和 JSON 参数都可用时，尝试发射缓冲的工具调用。跳过 `ask_image` 和 `ask_with_multi_image` 工具（由 provider 处理）。

#### `protected flushToolCallBuffers(progress, throwOnInvalid): Promise<void>`
清空所有工具调用缓冲区，发射剩余的工具调用。拦截 `ask_image` 和 `ask_with_multi_image` 存入 `interceptedToolCall`。

#### `public getStoredImage(imageIndex): StoredImage | undefined`
从实例的 `_localImages` 数组中按索引获取存储的图片数据。

#### `protected adjustReadFileParameters(toolName, parameters): Record<string, unknown>`
调整 `read_file` 工具的参数，根据配置自动扩增读取行数。

#### `protected _resetStreamState(): void`
重置可变流状态。必须在每次 `processStreamingResponse` 调用开始时调用，防止状态在轮次间残留（例如第一轮 → 视觉代理 → 第二轮）。清理内容包括：工具调用缓冲区、已发射索引、文本/推理发射标记、XML think 解析状态、thinking 缓冲区与定时器、被拦截工具调用。

#### `protected reportEndThinking(progress): void`
结束当前推理序列，向 VS Code 报告推理结束。

#### `protected generateThinkingId(): string`
生成唯一的推理内容 ID。

#### `protected bufferThinkingContent(text, progress): void`
缓冲推理内容，设置定时器每 100ms 刷新。

#### `protected flushThinkingBuffer(progress): void`
立即将缓冲的推理内容刷新到进度报告器。

#### `protected processXmlThinkBlocks(content, progress): { emittedAny: boolean }`
解析 XML think 块 (`...`)，将推理内容与文本内容分离。

#### `protected processTextContent(content, progress): { emittedAny: boolean }`
处理普通文本内容，发射到进度报告器。

#### `protected collectLocalImages(messages): void`（2026-09-28 新增）
收集消息中的图片并存入实例局部数组（仅非视觉模型需要）。扫描范围：① 直接的图片 DataPart；② 工具结果内嵌的图片 DataPart；③ 文本 part 中的 base64 data URI 图片。命中后设置 `_localImages` 与 `_hasImages`，供 `prepareRequestBody` 注入 ask_image 工具。三协议 `convertMessages` 共用（原先各自重复约 40 行）。

#### `protected applyTemperature(rb, um): void`（2026-09-28 新增）
注入 temperature / top_p（模型声明 `supportsTemperature === false` 时跳过）。三协议 `prepareRequestBody` 共用。Anthropic 在 thinking 强制 enabled 时需整体跳过温度控制，由调用方自行判断后决定是否调用本方法。

#### `protected mergeExtraParams(rb, um): void`（2026-09-28 新增）
合并模型 `extra` 参数到请求体（`undefined` 值跳过）。三协议 `prepareRequestBody` 共用。

#### `protected runSseStream(responseBody, progress, token, tag, onEvent, options?): Promise<void>`（2026-09-28 新增）
统一的 SSE 流消费骨架（三协议 `processStreamingResponse` 共用）。负责：重置流状态 → （可选）协议专属清理（`options.onBefore`）→ 逐事件回调 → 结束刷新工具调用（`options.onDone`，缺省为基类 `flushToolCallBuffers`）→ 结束 thinking。reader 生命周期/取消回调/`[DONE]` 由 `sse.ts` 统一处理。

#### `static prepareHeaders(apiKey, apiMode, customHeaders?): Record<string, string>`
准备 HTTP 请求头。Anthropic 模式使用 `x-api-key`，OpenAI 模式使用 `Bearer` 令牌。User-Agent 使用本项目真实的 `VersionManager.getUserAgent()`（`senseaudio-copilot/<版本> VSCode/<版本>`，2026-09-23 修复：原为上游遗留的伪装官方 SDK 假 UA `ai-sdk/openai-compatible/2.0.41 ... runtime/bun/1.3.11`）。

---

### 4.4b `src/api/httpClient.ts`（2026-09-28 新增）

#### `postJson(url, headers, body, signal, errorPrefix): Promise<Response>`
发送 JSON POST 请求并校验响应状态（三协议 `createMessage` 共用）。非 2xx 时抛出含状态码、状态文本、响应体与 URL 的错误（`errorPrefix` 区分协议，如 `"API error"` / `"Anthropic API request failed"` / `"Responses API error"`）。返回原始 `Response` 供调用方读取 body / json。

---

### 4.5 `src/models/apiModelList.ts`

#### `interface ApiModelMetadata`
`{ id, supports_responses?, supports_anthropic?, supports_vision?, supports_reasoning?, supports_tools?, context_length?, max_completion_tokens? }` — `/v1/models` 返回的扩展模型元数据（能力标记子集）。

#### `getApiModelIds(apiKey): Promise<Set<string>>`
从 `/v1/models` 拉取可用模型 ID 列表并返回 Set。使用内存缓存（5 分钟 TTL），API 不可用时静默降级（保留旧缓存或返回空集）。导出 `isApiFetchSuccessful()` 检查上次请求是否成功。

#### `getResponsesSupportedModelIds(apiKey): Promise<Set<string>>`
从缓存的 `/v1/models` 元数据中筛选 `supports_responses=true` 的模型 ID 集。供 `provideModel.ts` 在启动时缓存为动态标记（`getResponsesModelIds()`），由 provider 在 auto 模式下查询决定是否使用 Responses 协议。

#### `getAnthropicSupportedModelIds(apiKey): Promise<Set<string>>`
从缓存的 `/v1/models` 元数据中筛选 `supports_anthropic=true` 的模型 ID 集。供 `provideModel.ts` 在启动时缓存为动态标记（`getAnthropicModelIds()`），由 provider 在 auto 模式下查询决定是否使用 Anthropic 协议。

#### `getVisionSupportedModelIds(apiKey): Promise<Set<string>>`
从缓存的 `/v1/models` 元数据中筛选 `supports_vision=true` 的模型 ID 集。供 `extension.ts` 的 `senseaudio.setVisionProxyModel` 命令动态加载视觉模型列表（QuickPick 选择代替手填）。

#### `getApiModelMetadataList(apiKey): Promise<ApiModelMetadata[]>`（2026-09-03 新增）
返回缓存的 `/v1/models` **完整元数据列表**（含 `context_length` / `max_completion_tokens` / `supports_vision` / `supports_reasoning` / `supports_tools` 等字段）。供 `provideModel.ts` 自动发现流程作为新模型规格的**主数据源**——平台自己的元数据比 models.dev 更准更新（models.dev 目录可能滞后或未收录 SenseAudio 条目，拉取失败时曾把自动发现模型规格降级到 128K/4096 兜底）。查询失败返回空列表（静默降级）。

#### `isApiFetchSuccessful(): boolean`
返回最近一次 API 模型列表拉取是否成功。用于模型提供者决定是否应用 API 过滤。

---

### 4.6 `src/models/modelsDev.ts`

#### `interface ModelsDevEntry`
`{ id, name?, family?, reasoning?, tool_call?, structured_output?, temperature?, attachment?, modalities?, limit? }` — models.dev 数据库中单个模型条目的接口。

#### `ensureModelsDevLoaded(): Promise<void>`
从 `https://models.dev/models.json` 下载完整模型目录并构建内存索引（完整 ID → 条目 + 短 ID → 条目）。1 小时缓存 TTL，失败时静默保留旧缓存。首次无缓存时初始化为空 Map。

#### `lookupModelDevEntry(apiModelId): ModelsDevEntry | undefined`
按 API 模型 ID 查找 models.dev 元数据。匹配策略：1) 完整 models.dev ID 精确匹配，2) 短 ID（斜杠后最后一段）匹配，3) 后缀匹配。

---

### 4.7 `src/models/modelSync.ts`

#### `syncModelsOnStartup(context): Promise<void>`
启动模型同步入口（fire-and-forget，不阻塞扩展激活）。流程：
1. 读取 `senseaudio.syncModelsOnStartup` 配置（默认开启），关闭则直接返回。
2. 检查 `globalState` 的 `senseaudio.lastModelSyncDate`（上次成功同步日期），若等于今天（本地时间 `YYYY-MM-DD`）则跳过。
3. 用 `getPrimaryApiKey()` 获取主 key（任意有效 key 即可——`/v1/models` 实测不校验余额，余额 < 0 也 200）；缺失时记录 `⏭️ 跳过` 事件并返回（不标记已同步，下次打开重试）。
4. `ensureModelsDevLoaded()` 预热 models.dev 元数据缓存（1 小时 TTL）。
5. `getApiModelIds()` 拉取 API 模型列表；`isApiFetchSuccessful()` 为 false 或列表为空时记录 `❌ 失败` 事件并返回（不标记已同步）。
6. 用 `getBuiltInModelIds()` 对比，找出不在内置列表中的新模型。
7. `logSyncEvent()` 记录 `✅ 成功` 事件（含新模型列表）；成功后 `globalState.update()` 标记今日已同步。

#### `logSyncEvent(status, detail): Promise<void>`
将一条同步事件以**一行日志**输出到「SenseAudio」输出通道（`models.sync` 标签，含状态/说明）。**不写任何文件**——v1.7.0 起移除工作区 `.copilot/model-sync-log.md`（该文件会污染用户仓库，见 issue #1）。写入失败仅记日志，不影响启动流程。

---

### 4.8 `src/models/provideModel.ts`

#### `prepareLanguageModelChatInformation(options, _token, _secrets): Promise<LanguageModelChatInformation[]>`
获取模型信息列表。**先读 `senseaudio.enableAutoModelDiscovery`（默认开启）**——关闭时直接使用内置列表（不调 `/v1/models`、不查 models.dev，日志 `models.discovery` 的 `reason: "disabled_by_setting"`）。开启时用 `getPrimaryApiKey()` 获取主 key（任意有效 key 即可——`/v1/models` 不校验余额），从 API 获取可用模型 ID 列表，过滤内置模型（仅保留 API 中存在的模型），并从 models.dev 自动发现新增模型（默认 `thinkingMode="always"`）。启动时通过 `getResponsesSupportedModelIds()` / `getAnthropicSupportedModelIds()` 读取 `/v1/models` 的 `supports_responses` / `supports_anthropic` 标记，缓存到模块级集合供 `getResponsesModelIds()` / `getAnthropicModelIds()` 同步查询（不硬编码模型 ID，未来任何模型获得协议支持自动生效）。**末尾按 `senseaudio.apiMode` 过滤**：`anthropic` 仅保留 `supports_anthropic=true` 的模型，`responses` 仅保留 `supports_responses=true` 的模型（能力集合为空时回退全部）。API 不可用时静默回退到全量内置列表。自动发现模型与内置模型一致：`maxInputTokens` 按真实上下文的**可配置比例**声明（`getMaxInputTokensRatio()`，默认 `1.0`，建议 `0.8`），`context_length` / `max_completion_tokens` 保持真实值用于 API 请求体。

#### `getResponsesModelIds(): Set<string>`
同步返回当前探测到的 supports_responses=true 模型 ID 集（由 `prepareLanguageModelChatInformation` 在启动时更新）。provider.ts 在 auto 模式下查询此集合决定是否使用 Responses 协议。

#### `getAnthropicModelIds(): Set<string>`
同步返回当前探测到的 supports_anthropic=true 模型 ID 集（由 `prepareLanguageModelChatInformation` 在启动时更新）。provider.ts 在 auto 模式下查询此集合决定是否使用 Anthropic 协议。

#### `getAutoDiscoveredModelConfig(modelId): SenseAudioModelItem | undefined`
返回之前自动发现的模型配置（**返回浅拷贝**——provider.ts 每次请求会就地修改返回对象（enable_thinking、temperature、reasoning_effort 等），不拷贝会把上一次请求的修改泄漏到后续请求）。由 `provider.ts` 在 `getBuiltInModelConfig()` 返回 undefined 时作为回退调用。两源均未知输出上限时 `max_completion_tokens` 字段**不设置**（请求体不发送输出上限，交由服务端默认值）。

---

### 4.9 `src/tokenizer/provideToken.ts`

#### `const BaseTokensPerMessage = 3`
每条消息的基础 Token 数。

#### `const BaseTokensPerName = 1`
每个名称的基础 Token 数。

#### `countMessageTokens(text, modelConfig): Promise<number>`
计算消息的总 Token 数。支持 `LanguageModelTextPart`、`LanguageModelDataPart`（图片/二进制）、`LanguageModelToolCallPart`、`LanguageModelToolResultPart`、`LanguageModelThinkingPart`。

#### `textTokenLength(text): Promise<number>`
使用 tiktoken 分词器计算文本的 Token 数。

#### `countToolTokens(tools): Promise<number>`
计算工具定义的总 Token 数。

#### `calculateImageTokenCost(dataUrl): number`
基于图片尺寸计算 Token 成本。使用 512px 磁贴算法：基础 85 Token + 每磁贴 170 Token。

#### `calculateNonImageBinaryTokens(byteLength): number`
计算非图片二进制数据的 Token 成本（约 0.75 Token/字节）。

---

### 4.10 `src/core/utils.ts`

#### `interface ParsedModelId`
`{ baseId: string; configId?: string }` — 解析后的模型 ID。

#### `getModelProviderId(model): string`
从模型对象中提取提供商 ID，依次检查 `owned_by`、`provide`、`provider`、`ownedBy`、`owner`、`vendor` 字段。

#### `normalizeUserModels(models): SenseAudioModelItem[]`
规范化用户自定义模型列表，为每个模型设置 `owned_by` 字段。

#### `parseModelId(modelId): ParsedModelId`
解析模型 ID，按 `::` 分隔为 `baseId` 和 `configId`。

#### `mapRole(message): "user" | "assistant" | "system"`
将 VS Code 消息角色映射为字符串角色。

#### `convertToolsToOpenAI(options?): { tools?, tool_choice? }`
将 VS Code 工具定义转换为 OpenAI 函数工具定义。

#### `createRetryConfig(): RetryConfig`
从 VS Code 设置中读取 **HTTP 层**重试配置（`senseaudio.retry.enabled` / `maxAttempts` / `intervalMs` / `statusCodes`）。默认 `maxAttempts=2`、`intervalMs=1000`、`statusCodes=[]`（额外状态码，叠加在内置的 `[502, 504]` 之上）。与整轮层重试（`senseaudio.transientRetry*`）职责分离，详见「重试机制」。

#### `executeWithRetry<T>(fn, retryConfig): Promise<T>`
使用指数退避策略执行可重试的异步操作（HTTP 层）。内置可重试状态码仅 `[502, 504]`（网关错误）——429/500/503 刻意**不**在此层重试，交由整轮层处理，避免两层相乘导致长时间挂起。

#### `isRetryableError(error, retryableStatusCodes): boolean`
判断错误是否可重试（网络错误 patterns + 指定 HTTP 状态码）。

#### `isImageMimeType(mimeType): boolean`
判断 MIME 类型是否为图片。

#### `createDataUrl(part): string`
从 `LanguageModelDataPart` 创建 Base64 Data URL。

#### `arrayBufferToBase64(buffer): string`
将 Uint8Array 转换为 Base64 字符串。

#### `isToolResultPart(part): boolean`
判断是否为 `LanguageModelToolResultPart`。

#### `tryParseJSONObject(text): { ok: true, value } | { ok: false }`
安全尝试解析 JSON 对象字符串。

---

### 4.11 `src/vision/types.ts`

#### `interface StoredImage`
`{ data: Uint8Array; mimeType: string }` — 存储的图片数据，用于 ask_image 工具。

#### `interface InterceptedToolCall`
`{ id: string; name: string; args: { imageIndex?: number; imageIndices?: number[]; query: string } }` — 被拦截的 ask_image 或 ask_with_multi_image 工具调用信息。`query` 是模型对图片的具体提问。`imageIndex` 用于单图，`imageIndices` 用于多图对比。

#### `const ASK_IMAGE_TOOL_DEF`
ask_image 工具定义的 OpenAI 格式（`type: "function"`），包含 `imageIndex` 和 `query` 参数签名。

#### `const ASK_IMAGE_TOOL_NAME`
`"ask_image"` — ask_image 工具名称常量。

#### `const ASK_WITH_MULTI_IMAGE_TOOL_DEF`
`ask_with_multi_image` 工具的 OpenAI 格式工具定义（`type: "function"`），包含 `imageIndices`（number[]）和 `query` 参数签名。支持多张图片的同时传入，模型可用此工具进行对比、差异分析等需要同时看多图的场景。

#### `const ASK_WITH_MULTI_IMAGE_TOOL_NAME`
`"ask_with_multi_image"` — ask_with_multi_image 工具名称常量。仅在 `_localImages.length >= 2` 时注入。

#### `const DEFAULT_VISION_PROMPT`
默认的图片分析提示词（未设置自定义查询时使用）。

#### `buildUserImageReference(imageIndex): string`（2026-09-28 新增）
非视觉模型收到**用户直接发送的图片**时替换成的文本引用（强指令措辞，引导模型调用 ask_image）。不含前导换行——需要与相邻文本分隔的调用方自行加 `"\n"` 前缀。三协议 `convertMessages` 共用（原先 6 处重复字符串）。

#### `buildToolImageReference(imageIndex): string`（2026-09-28 新增）
非视觉模型收到**工具结果内嵌图片**时替换成的文本引用。与 `buildUserImageReference` 措辞一致，仅前缀区分来源（tool call）。

---

### 4.12 `src/vision/imageProxy.ts`

#### `const PROVIDER_VENDOR`
`"senseaudio"` — 本扩展注册语言模型的 vendor（`extension.ts` 中 `registerLanguageModelChatProvider("senseaudio", ...)`）。视觉代理**仅从本供应商**查找视觉模型，绝不跨供应商匹配同名模型（避免把图片请求路由到其他平台的同名模型，需不同授权/计费）。

#### `async function findVisionModel(visionModelId): Promise<vscode.LanguageModelChat | undefined>`
在当前供应商（`senseaudio`）内按裸模型 ID（如 `kimi-k2.6`）查找视觉模型。**修复 issue #3（2026-08-25）**：`senseaudio.visionProxyModel` 存裸 ID，而 VS Code 的 `LanguageModelChat.id` 是带 vendor 前缀的完整 identifier（`senseaudio/kimi-k2.6`），裸 `selectChatModels({ id })` 精确匹配 `metadata.id`（裸 ID）理应命中——但多 provider 环境下与 `chat.cachedLanguageModels.v2` 展示的完整 identifier 混淆导致匹配失败；本函数多级回退确保命中：① `selectChatModels({ vendor: "senseaudio", id: bareId })`（vendor + 裸 ID 精确匹配）；② 扫描本供应商全部模型按完整 ID / 裸 ID 后缀 / 名称匹配。配置值同时支持裸 ID 与完整 ID（`senseaudio/kimi-k2.6`，自动剥去 vendor 前缀）。

#### `callVisionModel(imageData, mimeType, visionModelId, query, token, progress?): Promise<string>`
调用视觉模型回答关于图片的查询。使用 `findVisionModel`（本供应商内按裸 ID/完整 ID 多级回退查找）定位模型，发送图片+查询文本，收集流式回答返回，并可通过 `progress` 实时转发 `LanguageModelTextPart`。与旧版 `describe_image` 不同，`query` 参数来自模型的 `ask_image` 工具调用，允许针对性提问（如"按钮是什么颜色？"）。支持 thinking 模式配置，通过 `senseaudio.visionProxyThinking` 设置控制，开启时发送 `reasoning_effort="high"`，关闭时发送 `reasoning_effort="disabled"`。

#### `callVisionModelMulti(images, visionModelId, query, token, progress?): Promise<string>`
多图版本的视觉模型调用。将多张图片的 `LanguageModelDataPart` 和 query 文本放在同一条消息中发送给视觉模型，使其可以同时看到所有图片进行比较分析。支持流式输出转发。

---

### 4.13 `src/vision/historyCodec.ts`（源自上游 opencode-go-copilot v1.9.2）

跨轮视觉历史编解码模块：把每轮完成的 ask_image 工具调用/结果序列化为私有 MIME 的 DataPart 负载，下一轮请求时解码并重建标准 tool call/tool result 消息。

#### `const VISION_TOOL_HISTORY_MIME`
`"application/vnd.opencodego.vision-tool-history+json"` — 私有 MIME 类型，用于在响应流中持久化被拦截的视觉工具调用。VS Code 可将该 DataPart 带入下一轮请求。

#### `interface VisionToolHistoryArguments`
`{ imageIndex?: number; imageIndices?: number[]; query: string; [key: string]: unknown }` — 视觉工具调用参数（与 `InterceptedToolCall.args` 对应）。

#### `interface VisionToolHistoryEntry`
`{ id: string; name: typeof ASK_IMAGE_TOOL_NAME | typeof ASK_WITH_MULTI_IMAGE_TOOL_NAME; args: VisionToolHistoryArguments; result: string; reasoningContent?: string }` — 一条完整的视觉工具调用/结果记录。`reasoningContent` 为 DeepSeek 兼容的 assistant tool call 推理内容。

#### `serializeVisionToolHistory(entry): Uint8Array`
序列化：`{ version: 1, entry }` JSON → `TextEncoder().encode()`。

#### `deserializeVisionToolHistory(data): VisionToolHistoryEntry | null`
解码 + 严格校验（`version === 1`、工具名合法、`args.query`/`result` 为 string、`imageIndex`/`imageIndices` 为非负整数）；任何不符返回 `null`。

#### `toOpenAIVisionToolMessages(entry): OpenAIChatMessage[]`
重建 OpenAI 消息对：`[{ role: "assistant", tool_calls: [...], reasoning_content? }, { role: "tool", tool_call_id, content }]`。

#### `toAnthropicVisionToolMessages(entry): AnthropicMessage[]`
重建 Anthropic 消息对：`[{ role: "assistant", content: [{ type: "tool_use", ... }] }, { role: "user", content: [{ type: "tool_result", ... }] }]`。

---

### 4.14 `src/vision/historyPart.ts`（源自上游 opencode-go-copilot v1.9.2）

#### `createVisionToolHistoryPart(entry): vscode.LanguageModelDataPart`
创建携带跨轮视觉历史的数据部分：`new vscode.LanguageModelDataPart(serializeVisionToolHistory(entry), VISION_TOOL_HISTORY_MIME)`。由 provider 每轮视觉代理完成后输出到响应流。

#### `parseVisionToolHistoryPart(part): VisionToolHistoryEntry | null`
解析持久化的视觉历史 DataPart：非 `LanguageModelDataPart` 或 MIME 不匹配返回 `null`；否则 `deserializeVisionToolHistory(part.data)`。由 openai/anthropic 的 `convertMessages` 在 part 循环开头调用。

---

### 4.15 `src/ui/statusBar.ts`

#### `initStatusBar(context, getLoginToken?): vscode.StatusBarItem`
创建状态栏条目并重置累计计数器。主文本初始为 `$(pulse) --`，`command` 设为 `senseaudio.checkUsage`（点击即刷新套餐用量）。传入 `getLoginToken` 时启动套餐用量后台轮询（`startUsagePolling`），并注册配置变化监听（`showUsageInTooltip` / `showUsageInStatusBar` / `usageRefreshInterval` 变化时重启轮询并重渲染）。**启动时不显示**（保持隐藏），仅在用户实际使用本插件模型时才显示。

#### `showTokenStatusBar(statusBarItem): void`
显示状态栏并取消待执行的自动隐藏定时器。在 `provideLanguageModelChatResponse` 发起请求时调用。`isStatusBarEnabled()` 为 false（高级 Token 指示器与套餐用量显示均关闭）时直接隐藏。

#### `isStatusBarEnabled(): boolean`（模块级私有）
状态栏可见性总开关 = `enableThirdPartyTokenIndicator` OR `showUsageInStatusBar` OR `showUsageInTooltip`。**不可只用 `enableThirdPartyTokenIndicator` 把关**（默认 false，会导致套餐用量永远不可见）。

#### `scheduleStatusBarHide(statusBarItem, delayMs?): void`
调度状态栏自动隐藏（默认空闲 60 秒后隐藏，可被下一次请求取消）。在请求结束（finally）时调用，确保切换其他模型后状态栏不会残留。

#### `refreshPlanUsageNow(): Promise<PlanUsageSnapshot | null>`
强制立即刷新套餐用量（`senseaudio.checkUsage` 命令与点击状态栏使用）：`getPlanUsageCached(token, true)` 绕过 TTL 强制拉取，完成后重渲染主文本与 tooltip 并返回快照。无登录 token 时返回 null。**并发保护**：后台刷新在途时（`usageRefreshInFlight`）不重复发起，直接返回当前缓存快照（`getPlanUsageSnapshot()`），避免穿透 in-flight 标志形成并发请求。

#### `formatTokenCount(value): string`
格式化 Token 数为人类可读格式 (K/M/B)。

#### `createProgressBar(usedTokens, maxTokens): string`
创建视觉进度条（使用 Unicode 块字符 ▁▂▃▄▅▆▇█）。

#### `updateContextStatusBar(messages, tools, model, statusBarItem, modelConfig): Promise<number>`
更新状态栏：`showUsageInStatusBar` 开启时主文本交给套餐用量（`updateStatusBarUsageText`），否则显示 Token 用量与进度条；tooltip 始终显示累计 Token。新对话时重置累计计数器。返回估算输入 Token 数（供 fallback usage）。

#### `updateStatusBarWithApiPrompt(apiPromptTokens, maxTokens, statusBarItem): void`
API 返回用量数据后重渲染状态栏。`showUsageInStatusBar` 开启时**不改主文本**（套餐用量占位），仅刷新 tooltip。

#### `resetCumulativeCounters(): void`
重置所有累计 Token 计数器（VS Code 启动和新对话时调用）。

#### `recordUsage(usage: StreamUsage): void`
将流式用量累计到全局计数器。

#### `updateCumulativeTooltip(statusBarItem): void`
更新状态栏工具提示：累计输入/输出 Token 数、缓存命中率，以及（启用且有缓存时）套餐用量区块（三窗口 + 5h 重置倒计时 + 余额 + 计费模式说明）。

#### `updateStatusBarUsageText(statusBarItem): void`（模块级私有）
渲染状态栏主文本：额度内 `$(pulse) 5H 65%` / 额度耗尽 `$(pulse) 余额 ¥358.78` / 无数据 `$(pulse) --`。`showUsageInStatusBar` 关闭时直接返回（由 Token 计数接管）。

#### `appendPlanUsageTooltipLines(lines): void`（模块级私有）
将套餐用量区块追加到 tooltip 行数组：配置关闭或无缓存时直接返回；每个窗口一行（`5H——0% (0 / 10,000 积分)`）+ 5h 重置倒计时行 + 余额行 + 计费模式说明行。

#### `refreshPlanUsage(): Promise<void>`（模块级私有）
后台刷新（fire-and-forget）：无 token 或已有刷新在途时跳过；成功后重渲染主文本与 tooltip。

#### `startUsagePolling() / stopUsagePolling(): void`（模块级私有）
启动/停止轮询定时器。`startUsagePolling` 先停旧定时器，立即触发一次刷新后按 `usageRefreshInterval`（夹取 1-60 分钟）定时刷新，输出 `planUsage.poll.start`/`planUsage.poll.stop`（debug）。

#### `isUsageInStatusBarEnabled() / isUsageTooltipEnabled() / getUsageRefreshIntervalMs(): boolean | number`（模块级私有）
读取 `senseaudio.showUsageInStatusBar`（默认 true）/ `senseaudio.showUsageInTooltip`（默认 true）/ `senseaudio.usageRefreshInterval`（默认 5 分钟，夹取 1-60）。

---

### 4.16 `src/core/logger.ts`

#### `class Logger`

| 方法 | 说明 |
|------|------|
| `init()` | 创建 VS Code `LogOutputChannel("SenseAudio")` |
| `debug(tag, data)` | 输出 DEBUG 级别日志 |
| `info(tag, data)` | 输出 INFO 级别日志 |
| `warn(tag, data)` | 输出 WARN 级别日志 |
| `error(tag, data)` | 输出 ERROR 级别日志 |
| `sanitizeHeaders(headers)` | 脱敏敏感 HTTP 头 (Authorization, x-api-key 等) |
| `dispose()` | 清理输出通道 |

#### `export const logger = new Logger()`
单例导出。

---

### 4.17 `src/core/localize.ts`

#### `l10n(key): string`
获取当前语言的本地化字符串。当前支持简体中文 (`zh-cn`)，回退到英文 key。

#### `l10nFormat(template, ...args): string`
格式化本地化字符串，替换 `{0}`, `{1}` 等占位符。

---

### 4.18 `src/core/versionManager.ts`

#### `class VersionManager`

| 静态方法 | 说明 |
|----------|------|
| `getVersion(): string` | 获取扩展版本号（从 `package.json` 读取） |
| `getUserAgent(): string` | 构建 User-Agent 字符串 |
| `getClientInfo(): { name, version, author }` | 获取客户端信息 |

---

### 4.19 `src/api/openai/openaiTypes.ts`

#### `interface OpenAIToolCall`
`{ id, type: "function", function: { name, arguments } }` — OpenAI 工具调用。

#### `interface OpenAIFunctionToolDef`
`{ type: "function", function: { name, description?, parameters? } }` — OpenAI 函数工具定义。

#### `interface OpenAIChatMessage`
`{ role, content?, name?, tool_calls?, tool_call_id?, reasoning_content? }` — OpenAI 聊天消息。

#### `interface ChatMessageContent`
`{ type: "text" | "image_url", text?, image_url? }` — 多模态消息内容。

#### `type OpenAIChatRole`
`"system" | "user" | "assistant" | "tool"` — 聊天角色。

#### `interface ReasoningDetailCommon`
`{ id, format, index? }` — 推理详情公共接口。

#### `interface ReasoningSummaryDetail extends ReasoningDetailCommon`
`{ type: "reasoning.summary", summary }` — 推理摘要。

#### `interface ReasoningEncryptedDetail extends ReasoningDetailCommon`
`{ type: "reasoning.encrypted", data }` — 加密推理内容。

#### `interface ReasoningTextDetail extends ReasoningDetailCommon`
`{ type: "reasoning.text", text, signature? }` — 推理文本。

#### `type ReasoningDetail = ReasoningSummaryDetail | ReasoningEncryptedDetail | ReasoningTextDetail`
推理详情联合类型。

---

### 4.20 `src/api/openai/openaiApi.ts`

#### `class OpenaiApi extends CommonApi<OpenAIChatMessage, Record<string, unknown>>`

#### `constructor(modelId: string)`
构造函数，传入模型 ID。

#### `convertMessages(messages, modelConfig): OpenAIChatMessage[]`
将 VS Code 消息转换为 OpenAI 格式。支持文本、图片、工具调用、工具结果、推理内容的消息转换。modelConfig 新增 `vision` 字段，非视觉模型时自动替换图片为文本引用并存储图片数据。同时递归扫描 `LanguageModelToolResultPart.content` 中的图片一并存入（确保通过工具返回的图片也能被 `ask_image` 代理识别）。**跨轮视觉历史恢复（v1.8.0）**：part 循环开头调用 `parseVisionToolHistoryPart` 识别私有 MIME 的历史 DataPart，在 `joinedText` 计算后、assistant 消息处理前用 `toOpenAIVisionToolMessages` 重建标准 `assistant tool_call → tool → assistant text` 消息序列（保证顺序正确）。

#### `prepareRequestBody(rb, um?, options?): Record<string, unknown>`
构建 OpenAI 请求体。设置 temperature、top_p、max_tokens、reasoning_effort（adaptive 模式时跳过）、thinking 模式（SenseAudio OpenAI 端点仅接受字符串：支持 `{ type: "enabled" }`、`{ type: "auto" }`（自适应模式，`adaptive` 会被拒绝）和关闭用 `{ type: "disabled" }`）、stop、tools、tool_choice 以及各种惩罚参数和 extra 参数。非视觉模型且存在图片时自动注入 `ask_image` 工具定义。

#### `processStreamingResponse(responseBody, progress, token): Promise<void>`
处理 OpenAI SSE 流式响应。逐行解析 `data:` 前缀的 SSE 事件，处理 `[DONE]` 标记，解析 usage 用量信息，委托 `processDelta()`。注册取消回调：`token.onCancellationRequested` 时调用 `reader.cancel()` 立即中断流式读取。在 `finally` 块中 dispose 该回调，防止多次调用 `processStreamingResponse` 时回调累积。

#### `private processDelta(delta, progress): Promise<boolean>`
处理单个 stream delta。按序处理：推理内容 → XML think 块 → 文本内容 → 工具调用。支持 `reasoning_details` 数组（OpenRouter 格式）。

#### `async *createMessage(model, systemPrompt, messages, baseUrl, apiKey, signal?): AsyncGenerator<{ type: "text"; text: string }>`
非流式聊天消息生成器（用于 Git 提交生成）。发送 HTTP 请求后 yield 文本块。注册取消回调：`signal.addEventListener("abort")` 时调用 `reader.cancel()` 立即中断流。

---

### 4.21 `src/api/anthropic/anthropicTypes.ts`

#### `type AnthropicRole`
`"user" | "assistant"`

#### `interface AnthropicTextBlock`
`{ type: "text", text }` — 文本块。

#### `interface AnthropicImageBlock`
`{ type: "image", source: { type: "base64", media_type, data } }` — 图片块。

#### `interface AnthropicThinkingBlock`
`{ type: "thinking", thinking, signature? }` — 推理块。

#### `interface AnthropicToolUseBlock`
`{ type: "tool_use", id, name, input }` — 工具使用块。

#### `interface AnthropicToolResultBlock`
`{ type: "tool_result", tool_use_id, content: string | (AnthropicTextBlock | AnthropicImageBlock)[], is_error? }` — 工具结果块（v1.8.0 起 content 类型放宽为支持图片块）。

#### `type AnthropicContentBlock`
文本 | 图片 | 推理 | 工具使用 | 工具结果的联合类型。

#### `interface AnthropicMessage`
`{ role, content: string | AnthropicContentBlock[] }` — Anthropic 消息。

#### `interface AnthropicRequestBody`
Anthropic 请求体。包含 `model`, `messages`, `max_tokens`, `system`, `stream`, `temperature`, `top_p`, `top_k`, `thinking`, `tools`, `tool_choice` 等字段。

#### `interface AnthropicToolDefinition`
`{ name, description?, input_schema? }` — Anthropic 工具定义。

#### `type AnthropicToolChoice`
`{ type: "auto" } | { type: "any" } | { type: "tool"; name } | { type: "none" }`

#### `interface AnthropicStreamChunk`
流式响应块的完整定义。包含 `type`（8 种事件类型）、`message`、`content_block`、`delta`、`usage`、`error` 等字段。

---

### 4.22 `src/api/anthropic/anthropicApi.ts`

#### `class AnthropicApi extends CommonApi<AnthropicMessage, AnthropicRequestBody>`

#### `constructor(modelId: string)`
构造函数，传入模型 ID。

#### `convertMessages(messages, modelConfig): AnthropicMessage[]`
将 VS Code 消息转换为 Anthropic 格式。系统消息提取到 `_systemContent`。支持文本、图片、工具使用、工具结果、推理内容。使用 `content` 块数组格式。modelConfig 新增 `vision` 字段，非视觉模型时自动替换图片为文本引用并存储图片数据。同时递归扫描 `AnthropicToolResultBlock.content` 中的图片一并存入（确保通过工具返回的图片也能被 `ask_image` 代理识别）。**连续工具结果合并（v1.8.0）**：for 循环外声明 `pendingToolResults` 缓冲区与 `flushPendingToolResults`；纯工具结果消息（user + 有 toolResults + 无文本/图片/历史）缓冲入区并 `continue`，其他消息类型前先 flush——保证同一 assistant `tool_use` 对应的全部 `tool_result` 输出为**单条** user 消息（Anthropic 协议要求，避免 400 "tool_use ids were found without tool_result blocks immediately after"）；循环结束后最后 flush 一次。**跨轮视觉历史恢复（v1.8.0）**：part 循环开头调用 `parseVisionToolHistoryPart`，在 `joinedText` 计算后、system 消息处理前用 `toAnthropicVisionToolMessages` 重建 `assistant tool_use → user tool_result` 序列（放在工具结果合并缓冲逻辑之前保证顺序正确）。

#### `prepareRequestBody(rb, um?, options?): AnthropicRequestBody`
构建 Anthropic 请求体。设置 max_tokens、system、thinking 模式（支持 `{ type: "enabled" }`、`{ type: "adaptive" }` 和 `{ type: "disabled" }`）、tools（转换为 Anthropic 格式）、tool_choice（auto/any/none）以及 extra 参数。**仅在 thinking 强制 enabled 时跳过 temperature/top_p**（2026-08-06 实测：`enabled` + temperature/top_p → 400"请求参数组合无效"，符合 Anthropic 协议 extended thinking 须省略 temperature 的规则；`adaptive`/`disabled` 与 temperature/top_p 组合均 200 通过，故保留温度控制）。保留 top_k。非视觉模型且存在图片时自动注入 `ask_image` 工具定义。

#### `processStreamingResponse(responseBody, progress, token): Promise<void>`
处理 Anthropic SSE 流式响应。逐行解析 `data:` 前缀的 SSE 事件，委托 `processAnthropicChunk()`。注册取消回调：`token.onCancellationRequested` 时调用 `reader.cancel()` 立即中断流式读取。在 `finally` 块中 dispose 该回调，防止多次调用 `processStreamingResponse` 时回调累积。

#### `private processAnthropicChunk(chunk, progress): Promise<void>`
处理 Anthropic 流式块。支持的事件类型：
- `ping` — 忽略
- `error` — 记录错误
- `message_start` — 消息元数据
- `message_delta` — 停止原因和用量
- `content_block_start` — 块开始（text/thinking/tool_use）
- `content_block_delta` — 增量内容（text_delta/thinking_delta/input_json_delta/signature_delta）
- `content_block_stop` / `message_stop` — 清空缓冲区

#### `async *createMessage(model, systemPrompt, messages, baseUrl, apiKey, signal?): AsyncGenerator<{ type: "text"; text: string }>`
非流式消息生成器（Anthropic 模式，用于 Git 提交生成）。注册取消回调：`signal.addEventListener("abort")` 时调用 `reader.cancel()` 立即中断流。

---

### 4.23 `src/api/responses/responsesTypes.ts`

#### `interface ResponsesContentBlock`
`{ type: "input_text" | "output_text" | "input_image"; text?; image_url?; annotations? }` — Responses 内容块（仅这三种类型被 SenseAudio 端点接受）。

#### `interface ResponsesInputMessage`
`{ role: "user" | "assistant" | "system" | "developer"; content: string | ResponsesContentBlock[] }` — input 数组中的消息。

#### `interface ResponsesFunctionCallItem`
`{ type: "function_call"; id; call_id?; name; arguments; status? }` — 模型输出的工具调用条目。

#### `interface ResponsesReasoningItem`
`{ type: "reasoning"; id; summary?: [{ type: "summary_text"; text }] }` — 推理输出条目。

#### `interface ResponsesMessageItem`
`{ type: "message"; id; role; content: ResponsesContentBlock[] }` — 消息输出条目。

#### `interface ResponsesFunctionTool`
`{ type: "function"; name; description?; parameters? }` — Responses 格式的工具定义。

#### `interface ResponsesUsage`
`{ input_tokens; output_tokens; total_tokens; input_tokens_details?; output_tokens_details? }` — 用量信息。

#### `interface ResponsesResponse`
非流式响应对象：`{ id; object; model; status; output; output_text?; usage?; error?; cost_cny?; trace_id? }`。

#### `type ResponsesStreamEventType`
流式事件类型联合：`response.created` / `response.in_progress` / `response.completed` / `response.failed` / `response.output_item.added` / `response.output_item.done` / `response.content_part.added` / `response.content_part.done` / `response.output_text.delta` / `response.output_text.done` / `response.reasoning_summary_text.delta` / `response.reasoning_summary_text.done` / `response.function_call_arguments.delta` / `response.function_call_arguments.done` / `response.usage` / `error`。

---

### 4.24 `src/api/responses/responsesApi.ts`

#### `class ResponsesApi extends CommonApi<ResponsesInputMessage, Record<string, unknown>>`

#### `constructor(modelId: string)`
构造函数，传入模型 ID。

#### `convertMessages(messages, modelConfig): ResponsesInputMessage[]`
将 VS Code 消息转换为 Responses input 格式。系统消息提取到 `_systemContent`（用于 `instructions` 字段）。支持文本、图片（`input_image`）、历史工具调用/结果（**文本化回填**：assistant `[tool_call] name(args) [/tool_call]` + user `[tool_result] ... [/tool_result]`，因端点拒绝 function_call 块）。modelConfig 新增 `vision` 字段，非视觉模型时自动替换图片为文本引用并存储图片数据。

#### `prepareRequestBody(rb, um?, options?): Record<string, unknown>`
构建 Responses 请求体。设置 instructions（system）、temperature、top_p、max_output_tokens、reasoning（启用→`{ effort }`，禁用→`{ effort: "none" }`，adaptive→省略）、tools（Responses function 格式）、tool_choice（仅 `auto`/`none`，SenseAudio 拒绝 object/required 形式）。**工具定义必须使用扁平格式** `{ type: "function", name, description, parameters }`（OpenAI 嵌套 `function` 格式被端点拒绝）。非视觉模型且存在图片时自动注入 `ask_image` 工具定义。

#### `processStreamingResponse(responseBody, progress, token): Promise<void>`
处理 Responses SSE 流式响应。逐行解析 `data:` 前缀的 SSE 事件，委托 `processResponsesEvent()`。注册取消回调：`token.onCancellationRequested` 时调用 `reader.cancel()` 立即中断流式读取。在 `finally` 块中 dispose 该回调。

#### `private processResponsesEvent(event, progress): Promise<void>`
处理单个流式事件：
- `response.output_item.added` — function_call 缓冲（按 output_index）
- `response.reasoning_summary_text.delta` — 推理内容（bufferThinkingContent）
- `response.output_text.delta` — 文本内容
- `response.function_call_arguments.delta/done` — 工具参数累积/发射
- `response.output_item.done` — function_call 完成时尝试发射
- `response.completed` — usage 统计（input_tokens/output_tokens/cached_tokens）
- `response.failed` — 抛出错误

#### `private tryEmitBufferedResponsesToolCall(outputIndex, progress): Promise<void>`
尝试发射缓冲的 function_call 为 LanguageModelToolCallPart。ask_image/ask_with_multi_image 被拦截存入 interceptedToolCall。

#### `private flushResponsesToolCalls(progress, throwOnInvalid): Promise<void>`
清空所有缓冲的 function_call，发射剩余工具调用（流结束时调用）。

#### `async *createMessage(model, systemPrompt, messages, baseUrl, apiKey, signal?): AsyncGenerator<{ type: "text"; text: string }>`
非流式消息生成器（Responses 模式，用于 Git 提交生成）。发送 POST /responses 后解析 `output_text` 并 yield。reasoning 禁用时传 `{ effort: "none" }`。

---

### 4.25 `src/gitCommit/commitMessageGenerator.ts`

#### `let commitGenerationAbortController: AbortController | undefined`
全局中止控制器。

#### `const DEFAULT_PROMPT`
默认提示词模板。包含 `system`（系统提示，强调直接输出 commit 信息、不包含任何前言和解释）、`user`（用户输入模板）、`styleReference`（风格参考模板，含语言匹配指令）。

#### `generateCommitMsg(secrets, scm?): Promise<void>`
入口函数。检测 Git 扩展和仓库，对多仓库场景进行选择，调用 `generateCommitMsgForRepository()`。

#### `orchestrateWorkspaceCommitMsgGeneration(secrets, repos): Promise<void>`
多仓库编排。筛选有变化的仓库，0/1/多仓库分别处理。

#### `filterForReposWithChanges(repos): Promise<any[]>`
筛选出有 Git 变更的仓库。

#### `promptRepoSelection(repos): Promise<any>`
弹出 QuickPick 让用户选择仓库（支持"全部生成"）。

#### `generateCommitMsgForRepository(secrets, repository): Promise<void>`
为单个仓库生成提交消息。显示进度条，支持取消。

#### `ensureApiKeyEntry(secrets): Promise<ApiKeyEntry | undefined>`
静默检查 API Key（经 keyManager.getApiKeyStore），返回 active（或第一个）key 条目；**无任何 key 时静默返回 undefined，不弹输入框**（2026-09-18 移除弹窗引导），由调用方抛出 "SenseAudio API key not found" 错误。

#### `performCommitMsgGeneration(secrets, gitDiff, inputBox, repoPath?): Promise<void>`
核心生成逻辑。构建 prompt（含自定义提示词、最近提交风格、用户输入、diff 内容），支持 `auto` 语言模式（由模型根据历史 commit 风格自动推断），创建 API 实例，流式输出提交消息到 InputBox。API 协议选择遵循 `senseaudio.apiMode` 设置（`auto` 跟随模型默认，或强制 `openai`/`anthropic`/`responses`；`enableResponsesApi` 关闭时 auto 模式下的 responses 模型回退 openai），并将生效的 apiMode 写回 `selectedModel.apiMode` 以确保 `createMessage()` 构造正确的请求头（anthropic 用 `x-api-key`，openai/responses 用 `Bearer`）。支持通过配置 `senseaudio.commitIncludeCommitDiff` 控制风格参考中是否包含历史提交的实际代码变更（默认关闭）。支持通过配置 `senseaudio.commitAttachContextFiles`（默认开启）控制是否将仓库根目录的 `AGENTS.md` 和 `README.md` 内容附加到 prompt 中作为额外上下文。**多 key 轮换循环**：生成器消费包 while 循环，`pickNextApiKey` → `createMessage` 流式消费；`failedKeys` 跟踪每个 key 失败原因，全部 key 用尽时（`failedKeys.size >= totalKeys`）报错列出脱敏 key+原因并区分瞬态（429/503→"请稍后重试"）与确定性（→"用管理命令检测"）；轮换错误换 key 重试（若已产生部分输出则不换 key，避免覆盖 InputBox 内容；轮换原因经 `getKeyRotationReason` 提取，修复了原固定 `api_error` 导致 429/503 被持久化为不可用的 bug）；`pickNextApiKey` 无可用 key 的兜底报错同样列出每个 key 的原因（`buildAllKeysUnavailableDetail`）；single 模式的 fallback=switch 同样仅在余额不足（402）时切换并经 `setActiveKeyByValue` 设为当前（`shouldSingleKeyFallbackSwitch` 判定），其他错误不切换、走 single 专属报错文案；成功后若该 key 曾被标记不可用则自愈置可用（`markApiKeyAvailable`，与 `provider/rotation.ts` 一致）；用户取消立即中止。

#### `abortCommitGeneration(): void`
中止提交消息生成。

#### `extractCommitMessage(str): string`
从生成的文本中提取提交消息（移除代码块标记）。

#### `removeThinkTags(text): string`
移除文本中的 `<think>...</think>` 标签。

---

### 4.26 `src/gitCommit/gitUtils.ts`

#### `interface GitCommit`
`{ hash, shortHash, subject, author, date }` — Git 提交信息。

#### `checkGitRepo(cwd): Promise<boolean>`
检查当前目录是否为 Git 仓库。

#### `checkGitInstalled(): Promise<boolean>`
检查 Git 是否已安装。

#### `checkGitRepoHasCommits(cwd): Promise<boolean>`
检查 Git 仓库是否有提交记录。

#### `searchCommits(query, cwd): Promise<GitCommit[]>`
搜索 Git 提交记录（支持 hash 回退搜索）。

#### `getGitDiff(repoPath): Promise<string | undefined>`
获取 Git Diff。优先 staged diff (`git diff --cached`)，回退 unstaged diff (`git diff`)，使用 `-U1` 减少上下文行数，限制最多 500 行。

#### `interface GetRecentCommitsOptions`
`{ includeDiff?: boolean; maxDiffLinesPerCommit?: number }` — 获取最近提交的选项。

#### `getRecentCommits(repoPath, count, options?): Promise<string>`
获取最近的提交标题作为风格参考。可通过 `options.includeDiff` 启用包含每次提交的实际代码变更（diff），通过 `options.maxDiffLinesPerCommit` 控制每个提交 diff 的最大行数（默认 50）。diff 使用 `-U1` 减少上下文行数，避免两处改动之间夹杂不必要的未变更内容。

#### `limitDiffLines(diff, maxLines): string`
限制 diff 行数，超出时添加截断标记。

---

### 4.27 `src/tokenizer/tokenizerManager.ts`

#### `class TokenCache`
简单 LRU 缓存。

| 属性/方法 | 说明 |
|-----------|------|
| `cache` | `Map<string, number>` — 缓存存储 |
| `maxSize` | 最大条目数 (5000) |
| `maxSizeBytes` | 最大字节数 (5MB) |
| `currentSize` | 当前大小 |
| `get(key)` | 获取缓存值，更新最近使用 |
| `set(key, value)` | 设缓存值，超出限制时驱逐最久未使用的条目 |

#### `class TokenizerManager`

| 静态方法 | 说明 |
|----------|------|
| `initialize(extensionPath)` | 设置扩展路径并获取单例 |
| `setExtensionPath(path)` | 设置扩展路径 |
| `getInstance()` | 获取单例实例 |

| 实例方法 | 说明 |
|----------|------|
| `getTokenizer()` | 获取或创建 tiktoken 分词器实例（o200k_base） |
| `countTokens(text)` | 使用缓存和分词器计算文本 Token 数 |

#### `export const tokenizerManager = TokenizerManager.getInstance()`
导出的单例实例。

---

### 4.28 `src/tokenizer/imageUtils.ts`

#### `getImageDimensions(base64): { width, height }`
从 Base64 图片字符串中获取尺寸。根据 MIME 类型分发到不同解析函数。

#### `getMimeType(base64): string`
通过读取文件头字节判断图片类型（JPEG/GIF/WebP/PNG）。

#### `getPngDimensions(base64): { width, height }`
解析 PNG 图片尺寸（读取 IHDR 块）。

#### `getGifDimensions(base64): { width, height }`
解析 GIF 图片尺寸（读取逻辑屏幕描述符）。

#### `getJpegDimensions(base64): { width, height }`
解析 JPEG 图片尺寸（扫描 SOF0/SOF1/SOF2 标记）。

#### `getWebPDimensions(base64String): { width, height }`
解析 WebP 图片尺寸（支持 VP8/VP8L/VP8X 格式）。

---

## 5. 编译与构建

### 5.1 编译命令

```bash
# TypeScript 编译（清理 out/ + tsc + 生成编译元信息 + 设置项一致性核对）
npm run compile
# 等效于: node scripts/build/clean.mjs && tsc -p ./ && node scripts/build/build-info.mjs && node scripts/dev/check-settings.mjs

# 完整审计（设置漂移 / 未使用导出 / 未使用 l10n / nls 一致性 / 命令声明 / 文档路径 / 测试路径）
npm run audit

# ESLint 检查
npm run lint

# 仅类型检查（无输出）
npx tsc --noEmit

# 持续监视模式
npm run watch

# 离线测试（4 个，无需 API Key；先自动 compile）
npm test
# 等效于: npm run compile && npm run test:offline
npm run test:offline
# 等效于: node test/test-plan-usage.mjs && node test/test-transient-retry.mjs && node test/test-vision-history.mjs && node test/test-anthropic-tool-result-merge.mjs

# 打包 VSIX
npm run build
# 等效于: node scripts/build/package-vsix.mjs
# 输出名固定为 <name>-<version>.vsix（如 senseaudio-copilot-1.10.0.vsix），不使用 vsce 默认的 extension.vsix
```

> `npm run compile` 先运行 `scripts/build/clean.mjs` **清空 `out/`**（`tsc` 不清理 `outDir`，源文件删除/移动后旧 `.js` 会残留并被 `vsce package` 打进 VSIX），再 `tsc` 编译，最后自动运行 `scripts/build/build-info.mjs`（生成编译元信息）与 `scripts/dev/check-settings.mjs`（设置项一致性核对，有漂移则编译失败）。详见 6.1b「编译产物元信息铁律」。

> **调试**：`.vscode/launch.json` 提供 `Run Extension`（F5，`preLaunchTask: npm: compile`）与 `Run Extension (no compile)` 两个配置；`.vscode/tasks.json` 提供 `npm: compile` / `npm: watch` / `npm: test:offline` 任务。

### 5.2 编译配置 (tsconfig.json)

| 选项 | 值 |
|------|-----|
| `module` | `Node16` |
| `target` | `ES2024` |
| `lib` | `["ES2024", "dom"]` |
| `strict` | `true` |
| `outDir` | `out` |
| `rootDir` | `src` |
| `exclude` | `["scripts", "node_modules", "out"]` |

> `scripts/` 目录下的 `.mjs` / `.js` 脚本为纯 Node ESM/CJS，不参与 `tsc` 编译（`tsconfig.json` 的 `exclude` 已排除 `scripts`）。

### 5.3 依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| `@microsoft/tiktokenizer` | ^1.0.10 | o200k_base 分词器 |
| `@eslint/js` | 9.39.4 | ESLint JavaScript 推荐规则 |
| `@types/node` | ^22 | Node.js 类型定义 |
| `@types/vscode` | ^1.116.0 | VS Code 类型定义 |
| `eslint` | 9.39.4 | 代码检查工具 |
| `typescript` | ^5.9.2 | TypeScript 编译器 |
| `typescript-eslint` | 8.60.1 | TypeScript ESLint 配置与解析器 |

---

## 6. 开发规范

### 6.1 **编译检查铁律**

> **所有代码更改必须通过以下编译检查，确保无错误：**
> ```bash
> npm run compile
> # 或
> npx tsc --noEmit
> ```
> 任何编译错误（包括类型错误）必须在提交前修复。

### 6.1a **编译产物清洁铁律**

> **`npm run compile` 必须先清空 `out/`。**
>
> `tsc` 不会清理 `outDir`：源文件被删除/移动后，旧的 `.js` 会残留在 `out/` 并被 `vsce package` 打进 VSIX
> （2026-09-28 实测：`out/` 残留 24 个陈旧产物，含已删除的 `legacyCookieApi.js`，且已随 `senseaudio-copilot-1.2.0.vsix` 发布）。
> `scripts/build/clean.mjs` 作为 `compile` 的前置步骤解决此问题。**禁止**手动删除 `out/` 后跳过 `clean` 步骤打包。

### 6.1b **编译产物元信息铁律**

> **每次编译产物必须包含版本号和编译时间（标注时区）。**
>
> `npm run compile` 会在 `tsc` 编译后自动运行 `scripts/build/build-info.mjs`，生成：
> - `out/build-info.json` —— 随扩展打包的编译元信息（`version` / `buildTime`（UTC ISO 8601）/ `buildTimeLocal` / `timezone`（IANA 时区）/ `timezoneOffset`（UTC 偏移）/ `buildTimeDisplay`（本地时间 + 时区 + UTC 偏移））
> - `.copilot/build-log.md` —— 开发者侧编译日志，每次编译追加一行（编译时间 + 版本号 + 时区）
>
> **时区标注规则**：时间必须同时标注 IANA 时区 ID（如 `Asia/Shanghai`）和 UTC 偏移（如 `UTC+08:00`），避免跨机器/跨时区追溯产物时产生歧义。
> 禁止手动编辑 `out/build-info.json` 和 `.copilot/build-log.md`（由脚本自动生成）。
> 若编译产物缺少元信息（`out/build-info.json` 不存在），视为编译未完成，不得打包发布。

### 6.2 **AGENTS.md 同步更新铁律**

> **每次代码更改后，必须同步更新 `AGENTS.md`，包括但不限于：**
> - 新增/修改/删除函数、类、接口 → 更新第 4 节（函数定义大全）
> - 新增/删除/重命名文件 → 更新第 3 节（程序文件索引）及第 3.2 节的目录结构和文件说明表
> - 新增/修改/删除模型定义 → 更新第 1.3 节（模型清单）
> - 修改核心逻辑流程 → 更新第 2 节（详细逻辑架构）中的流程图和文字描述
> - 修改编译配置、依赖、构建命令 → 更新第 5 节（编译与构建）
> - 修改开发规范 → 更新第 6 节（开发规范）
> 
> 任何提交中若包含代码变更但未同步更新本文档，视为不合规。

### 6.3 PR 内容规范

> **当用户要求生成 PR (Pull Request) 内容时，必须遵循以下模板风格。**

#### PR Title 格式

使用 Conventional Commit 风格：
```
<type>: <brief description>
```

type 取值：`feat` | `fix` | `refactor` | `docs` | `chore` | `improve` 等。

#### PR Body 模板

```markdown
### Changes

**1. <功能/改动标题>**
- <具体变更点 1>
- <具体变更点 2>
- <...>

**2. <下一个功能/改动标题>**
- <具体变更点>
- <...>

### Files Changed

| File | Change |
|------|--------|
| `<file path>` | <一句话说明改了什么> |
| `<file path>` | <一句话说明改了什么> |
```

#### 撰写规范

- Title 首字母小写，用英文撰写
- Body 使用英文，用 **粗体标题** 组织 major change areas
- Changes 部分用项目符号列出每个功能点的具体变更，每点以句号结尾
- Files Changed 表格只列关键文件，说明简洁（不需要行数、路径全称）
- 不包含"如何测试"、"如何回滚"等运维内容，除非用户特别要求
- 语气精炼、直接，聚焦"改了什么"而非"为什么改"
- **从整体上审视**：按功能/模块组织内容，而非按 commit 罗列。将多个 commit 中属于同一功能点的更改合并描述，避免逐条罗列 commit 标题

### 6.4 更新日志内容规范

> **当用户要求生成基于 Git tag 的更新日志（Changelog）时，必须遵循以下格式风格。**

#### 格式模板

```markdown
### <功能/改动类别标题>

- **<具体功能/改动点标题>**：<详细描述，说明改了什么、为什么、影响范围等>
- **<下一个具体功能/改动点标题>**：<详细描述>
- <无标题的简单变更点直接用一句话描述>

### <下一个功能/改动类别标题>

- **<具体功能/改动点标题>**：<详细描述>
- <简单变更点>
```

#### 撰写规范

- 以 `###` 三级标题组织 major change areas，标题用中文，概括该类别下的所有变更
- 每个 change area 下列出具体变更点，用 `-` 项目符号
- 需要强调的变更点使用 `**<标题>**：<描述>` 格式，无需要强调的简单变更直接用一句话
- 描述应说明改了什么、为什么改（如有必要）、对用户的影响，聚焦"改了什么"而非罗列 commit 标题
- 用中文撰写，风格专业、精炼
- 不包含 `Files Changed` 表格或技术实现细节
- **按功能类别而非按 commit 时间组织**：从整体上审视 PR，将多个 commit 中属于同一功能领域的变更合并归类，避免逐条罗列 commit 标题

#### 示例

```markdown
### Git 提交消息生成增强

- **自动语言检测**：`senseaudio.commitLanguage` 新增 `auto` 模式（默认）。启用后模型自动从仓库最近 10 条历史提交中推断使用的语言风格，无需手动指定目标语言。
- **历史提交代码变更参考**：新增配置项 `senseaudio.commitIncludeCommitDiff`（默认关闭）。开启后模型在生成提交消息时会参考历史提交的实际代码变更，帮助模型更好地学习提交风格。
- **项目背景知识注入**：新增配置项 `senseaudio.commitAttachContextFiles`（默认开启）。生成提交消息时自动将 AGENTS.md 和 README.md 内容附加到 prompt 中。

### Diff 生成优化

- **减少上下文行数**：将 diff 上下文从 3 行改为 1 行（`-U1`），避免大量未变更代码混入 prompt 中干扰模型。
```

### 6.5 代码风格

- 使用 TypeScript 严格模式 (`strict: true`)
- 遵循 ES2024 标准
- 使用 ESModule 模块系统 (`import`/`export`)
- 所有新的 API 函数需有 JSDoc 注释
- 导出的函数和类必须显式标注类型
- 使用 `satisfies` 操作符确保类型安全

### 6.6 命名约定

| 类别 | 约定 | 示例 |
|------|------|------|
| 类 | PascalCase | `SenseAudioChatModelProvider` |
| 接口 | PascalCase | `BuiltInModelDef`, `SenseAudioModelItem` |
| 类型 | PascalCase | `OpenAIChatRole`, `ParsedModelId` |
| 函数 | camelCase | `getBuiltInModelConfig`, `countMessageTokens` |
| 变量 | camelCase | `requestTimeoutMs`, `apiKey` |
| 常量 | UPPER_SNAKE_CASE | `BASE_TOKENS_PER_MESSAGE`, `DEFAULT_CONTEXT_LENGTH` |
| 私有属性 | `_` 前缀 | `_lastRequestTime`, `_toolCallBuffers` |
| 文件 | camelCase | `provider.ts`, `commitMessageGenerator.ts` |

### 6.7 VS Code API 使用约束

- `LanguageModelChatProvider` — 必须实现 `provideLanguageModelChatResponse()` 和 `provideLanguageModelChatInformation()`；可选实现 `onDidChangeLanguageModelChatInformation` 事件（VS Code 1.125+）用于模型列表动态刷新（本项目在 `apiMode` 设置变化时触发）
- `LanguageModelResponsePart` — 使用 `LanguageModelTextPart`、`LanguageModelThinkingPart`、`LanguageModelToolCallPart`、`LanguageModelDataPart`
- `LanguageModelChatInformation.maxOutputTokens` — 必须填入模型真实输出上限，不能为 0；VS Code 原生 Token/Context Usage 指示器会在 `maxOutputTokens <= 0` 时隐藏
- `SecretStorage` — 用于安全存储 API Key
- `LogOutputChannel` — 用于结构化日志输出
- `Progress<LanguageModelResponsePart>` — 用于流式报告响应块

### 6.8 不依赖 VS Code Proposed API

- 本扩展不使用任何 `enabledApiProposals`，所有使用的 VS Code API 均为稳定版本（VS Code 1.116+）
- `LanguageModelChatProvider`、`LanguageModelDataPart`、`LanguageModelThinkingPart` 等类型均为 VS Code 稳定 API
- `languageModelDataPart.d.ts`、`chatProvider.d.ts`、`languageModelThinkingPart.d.ts` 等类型声明文件仅用于编译期类型补全，不影响运行时行为

### 6.9 错误处理策略

- 网络请求使用 `executeWithRetry()`（HTTP 层，默认 2 次，仅网关错误 502/504 + 网络错误）；平台错误（429/500/503）由整轮层 `tryTransientRetryRound` 处理（默认 3 次）
- API 认证失败 → 弹出输入框提示用户输入
- 请求超时 → 友好的本地化错误消息
- 流式解析错误 → 记录日志，继续处理（不中断流）
- 所有未捕获错误由 `provider.ts` 的 `catch` 块统一处理

### 6.10 日志规范

所有日志使用 `logger` 单例，标签格式为 `category.subcategory`：
- `request.start/end` — 请求开始/结束
- `request.error/timeout/delay` — 请求错误/超时/延迟
- `models.loaded` — 模型加载
- `commit.start/end/error` — 提交消息生成
- `openai.stream.*` / `anthropic.stream.*` — 流式处理
- `apiKey.missing` — API Key 缺失
