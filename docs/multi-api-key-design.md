# 多 API Key 轮换与失效切换 — 当前实现

> 状态：**已实施** | 最后更新：2026-09-28 | 适用范围：聊天请求、Git 提交消息生成、模型列表、启动同步、手动检测
>
> 本文档描述**当前代码**的行为。历史设计（含已废弃的 cookie 主动余额预检架构）见
> [`archive/multi-api-key-design-v1.9-cookie-precheck.md`](archive/multi-api-key-design-v1.9-cookie-precheck.md)。

---

## 1. 功能概述

支持添加多个 SenseAudio API Key（SecretStorage 加密存储），提供三种使用模式：

| 模式 | 行为 |
|------|------|
| `sticky`（默认） | 固定使用一个 key（轮询游标钉住不前移），前缀缓存命中率最高；仅当该 key 失效（余额不足/401/429/503 等）时才切换到下一个可用 key 并钉住；原 key 恢复后**不自动切回**，保持缓存亲和性 |
| `rotation` | 请求轮流使用各 key（轮询，每次请求成功/失败都换 key），自动跳过不可用的 key |
| `single` | 仅使用用户指定的"当前 key"；按 `senseaudio.singleKeyFallback` 设置决定失败行为：`switch`（默认，**仅在当前 key 余额不足（402）时**自动切换到下一个可用 key 并设为当前使用，右下角弹窗提示；401/429/503 等其他错误不切换、走 single 专属报错）或 `error`（任何错误直接报错不切换） |

### 失效检测机制

- **被动检测（唯一机制）**：请求失败后根据 HTTP 状态码与错误文本判定 key 失效并切换。
  - **确定性失效**（持久化 `available=false`）：**402 余额不足** → `balance`；**401 无效 Key** → `invalid`。
  - **瞬态失效**（仅内存冷却，不持久化）：**429 限流** → `rate_limited`；**503 服务端繁忙** → `server_error`。
  - 状态码与文本 patterns 均可配置（`apiKeyRotationStatusCodes` / `apiKeyRotationErrorPatterns`）。
- **手动检测（自愈）**：QuickPick 管理中提供"检测可用性"，对选中 key 执行**最小真实聊天请求**（`say ok`、`max_tokens=8`；余额不足时被 402 拦截不耗 token），通过后标记为可用（充值后无需手动改状态）。**不使用 `/v1/models` 校验**（余额 < 0 也能返回 200，无法作为可用性判据）。
- **瞬态自动重试**：全部 key 均因瞬态错误（默认 429/500/503，`transientRetryStatusCodes` 可配置）失败时，按 `transientRetryTimes`（默认 3）自动重试整轮——指数退避等待（2s/4s/8s，上限 8s），重试前**清空瞬态冷却**（否则 `pickNextApiKey` 会跳过全部 key 使重试无效），次数用尽才报错。
- **平台侧错误不换 key**：500 Internal Server Error 是平台问题而非 key 问题——它命中瞬态重试但**不**命中轮换状态码，因此**不标记 key、不换 key**，仅退避后重试同一个 key（日志 `key.transientRetrySameKey`）。
- **全部 key 不可用报错**：报错列出每个 key 的脱敏 ID + 原因（`buildAllKeysUnavailableDetail`，如 `sk_****abcd: 服务端繁忙 (503)`），区分"瞬态失败请稍后重试"（429/503）与"确定性失败请检测"（402/401）。
- **余额展示**：管理界面所有 key 列表（主界面 / 检测二级界面 / 删除·设当前·编辑·绑定选择界面）显示账号余额——现金 `$(coin)/$(error) 充值 ¥X.XX` + 代金券 `$(gift) 赠送 ¥Y.YY（至 YYYY-MM-DD）`。数据源为登录 PASETO token 查 `platform.senseaudio.cn/api/user/self`（**按账号粒度**，所有 key 共享），见 `src/balance/accountInfo.ts`。

> **为什么没有主动余额预检**：旧平台 cookie 端点 `senseaudio.cn/api/usage-summary` 与 `/api/api-keys`
> 已于 2026-09-23 实测 **404**（平台改版为三域认证体系）。余额不足改由 API 返回 **402** 触发被动轮换。

---

## 2. 数据模型

### 2.1 SecretStorage 存储

```jsonc
// key: "senseaudio.apiKeys"
{
  "keys": [
    {
      "value": "sk_xxxx...",          // API Key（必填）
      "label": "工作号",               // 备注（可选）
      "cookie": "sess_xxxx...",        // tr_session cookie（可选，可多个 key 共享同一值）
      "available": true,               // 可用性: true=可用 / false=不可用(余额不足或失效) / null=未检测
      "lastCheckedAt": 1723190400000   // 最近一次检测时间戳（可选）
    }
  ],
  "activeIndex": 0                     // single 模式下的"当前使用" key 下标
}

// key: "senseaudio.apiKey"（旧版，迁移后删除）
"sk_xxxx..."  // 字符串
```

### 2.2 内存态（不持久化，重启重置）

```ts
// 轮询游标：模块级，跨请求共享。rotation 模式选中后前移（顺序轮换）；
// sticky 模式选中后钉住不前移（固定使用，失效才切下一个）
let rotationIndex = 0;

// 瞬态失效表：429 限流 / 503 服务端繁忙等"可能恢复"的失效，带冷却时间
// Map<keyValue, { exhaustedAt: number; reason: "rate_limited" | "server_error" }>
const transientExhausted = new Map<string, TransientExhausted>();
```

### 2.3 Key 状态机

```
                    ┌────────────────────────────────────────────┐
                    │                                            ▼
 [null] 未检测 ──手动检测通过──▶ [true] 可用 ◀──请求成功(自愈)────┐
    │  ▲                          │  │                          │
    │  │                          │  │ 请求 402 / 401            │
    │  │  手动检测失败             │  ▼                          │
    │  └───────────────────────▶ [false] 不可用                  │
    │                             │  原因: balance / invalid     │
    │                             │                              │
    └────── 手动检测(余额不足/401) ┘                              │
                                                                 │
    [true] 可用 ──请求429──▶ (内存) 冷却中(rate_limited) ──冷却到期自动恢复──▶ [true]
    [true] 可用 ──请求503──▶ (内存) 冷却中(server_error) ──冷却到期自动恢复──▶ [true]
    [true] 可用 ──请求401──▶ [false] invalid（持久化）
    [false] 不可用 ──手动检测通过(自愈)──▶ [true]
    [false] 不可用 ──重置失效状态命令──▶ [null] 未检测
```

- `available=false` 是**持久化**的（SecretStorage），重启保留（确定性原因：余额不足 / 无效 Key）。
- 429/503 是**瞬态冷却**（内存 + 冷却时间 `apiKeyExhaustedCooldownMin`，默认 10 分钟），到期自动恢复，不写持久化。**冷却期间 `pickNextApiKey` 会跳过该 key**；瞬态整轮重试前需 `resetExhaustedKeys(secrets,false)` 清空冷却。
- **自愈**：请求成功时自动把该 key 恢复为 `available=true`。
- **503 属于瞬态而非确定性**：平台繁忙通常很快恢复，持久化不可用会导致冷却到期后仍被阻挡。`getKeyRotationReason` 精确提取原因（402/401→确定性；429/503→瞬态），`markApiKeyExhausted` 按 `TRANSIENT_REASONS`（rate_limited/server_error）决定只冷却不持久化。

---

## 3. 关键函数设计

### 3.1 `src/keys/`（barrel：`keyManager.ts`）

| 函数 | 签名 | 职责 |
|------|------|------|
| `getApiKeyStore(secrets)` | `(secrets) => Promise<ApiKeyStore>` | 读取并缓存 store；自动迁移旧 `senseaudio.apiKey`；JSON 损坏时回退修复 |
| `saveApiKeyStore(secrets, store)` | `(secrets, store) => Promise<void>` | 写新格式；成功后删除旧 key（幂等） |
| `getApiKeyMode()` / `getSingleKeyFallback()` | 同步 | 读取 `apiKeyMode`（默认 sticky）/ `singleKeyFallback`（默认 switch），非法值回退 |
| `getRotationStatusCodes()` / `getRotationErrorPatterns()` | 同步 | 触发轮换的状态码（**默认 [401,402,429,503]**）/ 文本 patterns |
| `getTransientRetryStatusCodes()` / `getTransientRetryTimes()` | 同步 | 触发瞬态整轮重试的状态码（**默认 [429,500,503]**，与轮换状态码解耦）/ 重试次数（默认 3，0 禁用） |
| `getExhaustedCooldownMin()` | 同步 | 429/503 瞬态冷却时长（分钟，默认 10） |
| `getPrimaryApiKey(secrets)` | `(secrets) => Promise<ApiKeyEntry \| undefined>` | 模型列表/同步用：single→active；rotation→第一个可用的（跳过冷却与不可用） |
| `pickNextApiKey(secrets, mode)` | `(secrets, mode) => Promise<ApiKeyEntry \| undefined>` | 轮询/单 key 选择逻辑（见 3.2） |
| `shouldSingleKeyFallbackSwitch(secrets, failedKeys)` | `(secrets, failedKeys) => Promise<boolean>` | single+fallback=switch 时是否应切换：仅本轮 active key 因余额不足（402）失败才 true；401/429/503 与历史遗留不可用均不切换 |
| `setActiveKeyByValue(secrets, keyValue)` | `(secrets, keyValue) => Promise<void>` | 按值把 key 设为 single 当前 key（402 自动切换后调用，后续请求直接用新 key，避免重复 fallback+弹窗） |
| `getTransientExhaustedInfo(keyValue)` | 同步 | 查询瞬态冷却状态（原因 + 剩余秒数），冷却到期自动清除 |
| `hasTransientExhaustedKey(secrets)` | 异步 | 是否存在冷却中的 key（供"全部不可选"时判断是否值得整轮自动重试） |
| `isApiKeyEligible(entry)` | 同步 | 判断是否可被选中（非冷却中、非 `available=false`） |
| `isKeyRotationError(err)` | 同步 | 匹配状态码 `[401]/[402]/[429]/[503]` 或错误文本 patterns → 判定是否应切换 |
| `isTransientRetryError(err)` | 同步 | 状态码匹配 `transientRetryStatusCodes`（默认 [429,500,503]）→ 瞬态类，值得整轮自动重试 |
| `isTransientExhaustedReason(reason)` | 同步 | 是否为瞬态原因（`rate_limited`/`server_error`） |
| `getKeyRotationReason(err)` | 同步 | **精确提取失效原因**（比 patterns 更准）：402/INSUFFICIENT_BALANCE→`balance`；401→`invalid`；429/RATE_LIMITED→`rate_limited`；503→`server_error`；其他→`api_error` |
| `getKeyUnavailableReason(entry)` | 同步 | 取当前不可用原因（供报错展示）：冷却中→`rate_limited`/`server_error`；持久化不可用→`unavailable`；其他→`balance` |
| `markApiKeyExhausted(secrets, key, reason)` | 异步 | **瞬态原因**（rate_limited/server_error）→ 仅内存冷却不持久化；**确定性原因**（balance/invalid/api_error）→ 持久化 `available=false` |
| `markApiKeyAvailable(secrets, key)` | 异步 | 置 `available=true`，清冷却（自愈/手动检测通过） |
| `updateKeyAvailability(secrets, key, available)` | 异步 | 通用状态更新 |
| `resetExhaustedKeys(secrets, resetPersisted)` | 异步 | 清空瞬态冷却；可选将所有 `available=false` 重置为 `null`（`resetPersisted=true`） |
| `addApiKey(secrets, entry)` | 异步 | 添加单个 key（校验重复值） |
| `addApiKeys(secrets, entries)` | 异步 | **批量添加**（三元组 value/cookie/label）；已有重复 key 更新其 cookie（不重复添加），返回 `{added, updated}` |
| `updateApiKey(secrets, index, fields)` | 异步 | **三字段编辑**（value/cookie/label）；value 冲突校验，返回 `{ok, conflict?}` |
| `removeApiKey(secrets, index)` | 异步 | 删除；调整 activeIndex 与轮询游标；**同步清理该 key 的瞬态冷却条目** |
| `setActiveKey(secrets, index)` | 异步 | 设置 single 模式的当前 key |
| `setKeyCookie(secrets, index, cookie?)` | 异步 | 绑定/更新/清除指定 key 的 cookie |
| `getKeyDisplayStatus(entry)` | 同步 | `available` / `unavailable` / `unknown` / `cooldown`（供 QuickPick UI） |
| `maskApiKey(key)` / `maskCookie(cookie)` | 同步 | `sk_****abcd` / `sess_****abcd` 脱敏 |

### 3.2 `pickNextApiKey` 选择逻辑

```
pickNextApiKey(secrets, mode):
  store = await getApiKeyStore(secrets)
  if store.keys.length == 0: return undefined

  if mode == "single":
    entry = store.keys[store.activeIndex] ?? 第一个
    if isApiKeyEligible(entry): return entry
    // 不可用时由调用方（rotation.ts）决定：
    //   fallback=error  → 直接报错，不切换
    //   fallback=switch → 仅当本轮原因为余额不足(402)时以 rotation 模式再次调用本函数
    return undefined

  // rotation：从 rotationIndex 开始顺序查找第一个 eligible 的 key
  for i in 0..keys.length-1:
    idx = (rotationIndex + i) % keys.length
    entry = keys[idx]
    if isApiKeyEligible(entry):
      rotationIndex = (idx + 1) % keys.length   // 游标前移到下一个，保证下次从下一个开始
      return entry
  return undefined   // 全部不可用或冷却中

  // sticky：同 rotation 的扫描，但命中后**不前移游标**（钉住）
```

### 3.3 `src/balance/`（barrel：`balanceCheck.ts`）

| 函数 | 签名 | 职责 |
|------|------|------|
| `queryAccountInfo(loginToken)` | `(token) => Promise<AccountInfo>` | `GET platform.senseaudio.cn/api/user/self`，Bearer PASETO token + `x-platform`/`x-product` 必需头；返回 `usage_infos[]` + `account_info`（balance/vouchers/enable_extra_usage） |
| `getAccountInfoWithStatus(token, ttlSec, force?)` | 异步 | 带状态返回：`ok` / `unauthorized`（401）/ `error`，供状态栏与命令区分 401 |
| `getAccountInfoCached(token, ttlSec)` | 异步 | TTL 缓存；失败返回 undefined（UI 显示"余额未知"） |
| `formatExpiryDate(epochSec)` | 同步 | 格式化代金券到期日为 `YYYY-MM-DD`（本地时区）；无到期/非法返回空串 |
| `POINTS_PER_CNY` | 常量 | **1 元 = 1,000,000 积分**（代金券单位换算，2026-09-27 实测校正） |
| `testKeyAvailability(entry, baseUrl)` | 异步 | 手动检测：**发最小真实聊天请求**（`say ok`、`max_tokens=8`）：402/INSUFFICIENT_BALANCE → `{ok:false, reason:"balance"}`，401 → `{ok:false, reason:"invalid"}`，200 → `{ok:true}`；网络/超时 → `{ok:null}` 无法确定 |

> 手动检测"请求一次"为什么用真实聊天请求而非 `/v1/models`：**实测余额 -0.04 时 `/v1/models` 仍返回 200**（模型列表不校验余额），无法区分"余额不足"与"正常可用"；而真实请求在余额不足时被 402 拦截，**不消耗 token**，语义明确。

### 3.4 `src/provider/rotation.ts` — 轮换循环

`runKeyRotationLoop(params)` 是唯一的轮换实现，聊天请求与 Git 提交生成共用：

```
while (true):
  if failedKeys.size >= totalKeys:
      if 存在瞬态失败 且 tryTransientRetryRound(wholeRoundRetryCount) → 清冷却 + 退避 + 重试整轮
      else → 报错（列脱敏 key + 原因，区分瞬态/确定性）

  key = forceKey ?? pickNextApiKey(...)          // forceKey：500 同 key 重试
  if !key:
      single + fallback=switch + 本轮余额不足 → 降级 rotation 选下一个 + setActiveKeyByValue
      if 仍无 key:
          if 存在瞬态冷却 key 且 tryTransientRetryRound → 重试整轮
          else → 报错（single 专属文案 / 全部不可用文案）

  try:
      execute(key, headers)
      成功 → 自愈置可用 + 返回
  catch err:
      取消/超时 → 抛出
      isKeyRotationError(err):                   // 401/402/429/503
          reason = 瞬态重试命中但原因非瞬态 ? "server_error" : getKeyRotationReason(err)
          failedKeys.set(key, reason)
          markApiKeyExhausted(key, reason)       // 瞬态→仅冷却；确定性→持久化
          continue                               // 换下一个 key
      isTransientRetryError(err):                // 500 等平台侧错误
          if tryTransientRetryRound(sameKeyRetryCount):
              forceKey = key                     // 强制同一 key，不轮换
              continue
          抛出
      其他（400/403/网络/IMAGE_SENSITIVE）→ 抛出，不轮换
```

**两个独立的重试计数器**：`wholeRoundRetryCount`（全部 key 瞬态失败 / 无可用 key）与 `sameKeyRetryCount`（500 同 key 重试）分开计数——500 重试不消耗 429/503 的整轮配额，反之亦然。

---

## 4. 完整情况覆盖矩阵

### 4.1 聊天请求主流程（`provider/rotation.ts`）

| # | 情况 | 处理 | 覆盖 |
|---|------|------|------|
| A1 | 无任何 key | 静默返回 undefined → 抛 "SenseAudio API key not found"（不弹输入框） | ✅ |
| A2 | single 模式 activeIndex 越界（key 被删） | 回退到第一个 key；仍无 → A1 | ✅ |
| A3 | rotation 模式 key 列表为空 | 同 A1 | ✅ |
| A4 | 所有 key 均不可用（持久化 false 或冷却中） | 报"所有 API Key 均不可用"，附各 key 失败原因（脱敏，`buildAllKeysUnavailableDetail`）；若存在瞬态冷却 key 且未达 `transientRetryTimes` 上限 → 清冷却 + 退避后重试整轮 | ✅ |
| A5 | 部分 key 冷却中（429/503） | 跳过，选下一个 | ✅ |
| A6 | 部分 key 持久化不可用（余额/401） | 跳过，选下一个 | ✅ |
| A7 | 轮询游标越界（删除 key 后） | 取模回绕，不越界 | ✅ |
| A8 | single 模式 active 不可用，fallback=`error` | 直接报错，不切换 | ✅ |
| A9 | single 模式 active 不可用，fallback=`switch` 且本轮原因为余额不足（402） | 降级为 rotation 选择下一个可用 key 并经 `setActiveKeyByValue` 设为当前使用；成功后右下角通知"当前 Key 余额不足，已切换到 sk_****abcd 并设为当前使用" | ✅ |
| A9b | single 模式 active 因 401/429/503 失败（fallback=`switch`） | **不切换**（401 属配置问题、429/503 属瞬态由整轮重试兜底）→ 报 single 专属错误"当前 Key 不可用（原因）…" | ✅ |
| A10 | single fallback=`switch` 且所有 key 均不可用 | 按 A4 汇总报错，不弹切换通知 | ✅ |
| C1 | 请求成功 | 若该 key 曾不可用 → 自愈置 true；break 轮换循环 | ✅ |
| C2 | 402 余额不足 | 匹配轮换错误 → 标记不可用(balance)，换下一个 | ✅ |
| C3 | 401 无效 Key | 匹配轮换错误 → 标记不可用(invalid)，换下一个 | ✅ |
| C4 | 429 限流 | 匹配轮换错误 → **瞬态冷却**（不持久化，reason=`rate_limited`），换下一个 | ✅ |
| C4b | 503 服务端繁忙 | 匹配轮换错误 → **瞬态冷却**（不持久化，reason=`server_error`），换下一个；全部 key 503 时自动整轮重试 | ✅ |
| C5 | 400 参数错误 | 不轮换（配置/模型问题，换 key 无效），直接抛错 | ✅ |
| C6 | 403 权限 | 不轮换，直接抛错 | ✅ |
| C7 | 404/405 等 | 不轮换，直接抛错 | ✅ |
| C8 | 502/504 网关错误 | HTTP 层 `executeWithRetry` 重试（默认 2 次） | ✅ |
| C8b | 全部 key 均因瞬态错误（429/503）失败 | **整轮自动重试**（`tryTransientRetryRound`）：清空瞬态冷却（`resetExhaustedKeys(secrets,false)`）→ 指数退避（2s/4s/8s）→ 重试整轮，最多 `transientRetryTimes` 次；次数用尽才报错（带原因 + "请稍后重试"） | ✅ |
| C8c | **500 Internal Server Error** | 命中瞬态重试但**不**命中轮换 → **不标记 key、不换 key**，退避后重试**同一个 key**（`forceKey`，日志 `key.transientRetrySameKey`）；`sameKeyRetryCount` 独立计数 | ✅ |
| C9 | 网络错误（fetch 失败） | 不轮换（同一平台，换 key 无效），由重试机制处理 | ✅ |
| C10 | 超时 | 不轮换，走现有超时友好提示 | ✅ |
| C11 | 用户取消 | 不轮换，重新抛出原始错误 | ✅ |
| C12 | IMAGE_SENSITIVE | 不轮换（内容问题），抛友好错误 | ✅ |
| C13 | 流解析中途错误 | 不轮换（流已开始），抛错 | ✅ |
| C14 | 状态码在配置列表但文本不匹配 | 按状态码匹配 → 轮换 | ✅ |
| C15 | 状态码不在列表但文本匹配 patterns | 按文本匹配 → 轮换 | ✅ |
| C16 | 所有 key 尝试后全部失败 | 报"所有 API Key 均不可用"，汇总各 key 失败原因（脱敏，如 `sk_****abcd: 服务端繁忙 (503)`），区分瞬态（"请稍后重试"）与确定性（"用管理命令检测"） | ✅ |
| C17 | 轮换过程中部分 key 成功 | 正常返回，成功 key 游标前移 | ✅ |
| C18 | 错误命中瞬态重试状态码但原因非瞬态（如 500→`api_error`） | `isTransientRetryError` 命中 → 规范化为 `server_error` 仅内存冷却不持久化，保证整轮重试可重新选 key | ✅ |

### 4.2 视觉代理（ask_image 第二轮及后续请求）

| # | 情况 | 处理 | 覆盖 |
|---|------|------|------|
| D1 | 视觉代理请求（第二轮） | 复用主请求选中的 key 与 headers，**不重新轮换**（主请求已成功，tool 上下文已建立） | ✅ |
| D2 | 视觉代理请求 402/401/429 | **不触发 key 切换**（主请求已成功，切换会打乱 tool 上下文）；记录日志并抛错，提示用户重试整个请求 | ✅ |
| D3 | 视觉代理请求其他错误 | 同 D2 | ✅ |

> 设计理由：轮换循环只覆盖"主请求"阶段。主请求成功后模型已产出 tool_call，消息上下文（含图片）绑定在 API 实例内，中途换 key 重试视觉代理会引入不一致。失败时直接报错，用户重试即可（重试时重新走完整轮换）。

### 4.3 Git 提交消息生成（`gitCommit/commitMessageGenerator.ts`）

| # | 情况 | 处理 | 覆盖 |
|---|------|------|------|
| E1 | 无 key | 静默返回 undefined → 抛 "SenseAudio API key not found" | ✅ |
| E2 | rotation 模式 | 与聊天相同：轮换循环 | ✅ |
| E3 | single 模式，fallback=`error` | 用指定 key，任何错误直接报错不切换 | ✅ |
| E4 | 402/401 | 标记不可用，换下一个 key 重试 | ✅ |
| E5 | 429/503 | 瞬态冷却，换下一个 key 重试；全部瞬态失败 → 整轮自动重试（同 C8b） | ✅ |
| E6 | 用户取消（abortGeneration） | 不重试，中止 | ✅ |
| E7 | 所有 key 失败 | 报错，附失败原因 | ✅ |
| E8 | 生成中途流式输出已开始（部分文本已写入 InputBox） | 换 key 重试会覆盖输入框内容——**策略：若已产生部分输出则不再换 key，直接报错**（避免用户看到半截内容被覆盖）；仅在"请求失败且尚无任何输出"时换 key 重试 | ✅ |
| E9 | single 模式，fallback=`switch`，当前 key 余额不足（402） | 降级为 rotation 选下一个可用 key 并经 `setActiveKeyByValue` 设为当前（同 A9，无弹窗） | ✅ |
| E9b | single 模式，fallback=`switch`，当前 key 因 401/429/503 失败 | 不切换，报 single 专属错误（同 A9b） | ✅ |
| E10 | single fallback=`switch` 且全部不可用 | 按 E7 汇总报错 | ✅ |

### 4.4 模型列表 / 启动同步（`models/provideModel.ts` / `models/modelSync.ts`）

> **实测确认**：`/v1/models` 余额 < 0 时仍返回 200，模型列表**不校验余额**。因此模型列表/同步用任意**有效** key 即可，**无需关心余额**；仅需跳过 401 无效 key。

| # | 情况 | 处理 | 覆盖 |
|---|------|------|------|
| F1 | 正常 | 用主 key（single→active；rotation→第一个**有效** key，余额不足不跳过） | ✅ |
| F2 | 主 key 无效（401） | 用下一个有效 key | ✅ |
| F3 | 全部无效 / 无 key | 回退内置模型列表（现有行为，静默降级） | ✅ |
| F4 | 不做轮换 | 仅一次请求，失败即回退 | ✅ |

### 4.5 手动检测可用性（QuickPick 按钮）

| # | 情况 | 处理 | 覆盖 |
|---|------|------|------|
| G1 | 请求校验 401 | 标记不可用（invalid），提示"Key 已失效" | ✅ |
| G2 | 请求校验成功（最小聊天请求 200） | 标记可用，提示"检测通过" | ✅ |
| G3 | 请求校验 402 / INSUFFICIENT_BALANCE | 标记不可用（balance），提示"余额不足（≤ 阈值）" | ✅ |
| G4 | 网络错误 / 超时（无法区分 key 问题或网络问题） | **保留原状态**，提示"无法确定，请稍后重试" | ✅ |
| G5 | 检测中用户取消 | 不改变状态 | ✅ |
| G6 | 检测后 | 刷新 QuickPick 列表 | ✅ |
| G7 | 检测所有 | `checkAllAvailabilityFlow` 带进度条遍历全部 key，汇总"可用/不可用/未知" | ✅ |

### 4.6 QuickPick 管理（`manageApiKeys`）

| # | 情况 | 处理 | 覆盖 |
|---|------|------|------|
| H1 | 空列表 | 仅显示"添加 Key"动作 | ✅ |
| H2 | 添加 key | 输入 key（可附带 label、cookie）；重复值提示已存在 | ✅ |
| H2b | **批量导入** | 表单式逐条输入 key/cookie/备注三元组，Finish 时 `addApiKeys` 批量添加；已存在 key 自动更新 cookie 不重复添加 | ✅ |
| H2c | **编辑 key** | `editKeyFlow` 三字段（value/cookie/label）编辑，value 冲突校验 | ✅ |
| H3 | 删除 key | 二次确认；删除 active → 调整 activeIndex；清空 → H1 | ✅ |
| H4 | 设为当前使用 | 更新 activeIndex（**仅 single 模式渲染/显示；rotation/sticky 模式隐藏**） | ✅ |
| H5 | 绑定/更新 cookie | 选择 key → 输入 cookie | ✅ |
| H6 | 清除 cookie | 置空 | ✅ |
| H7 | 重置失效状态 | 清瞬态冷却 + 所有 `available=false` → `null` | ✅ |
| H8 | 检测可用性 | 见 4.5 矩阵；检测二级界面（`showCheckMenu`）列出全部 key 状态 + "检测所有" | ✅ |
| H9 | 状态显示 | `$(check) 可用` / `$(error) 不可用` / `$(question) 未检测` / `$(clock) 冷却(Ns)` / `$(star) 当前使用`（仅 single）/ `$(pinned) 固定使用`（仅 sticky）/ `$(key) cookie 已绑定` | ✅ |
| H9b | **余额显示** | 主界面/检测二级界面/删除·设当前·编辑·绑定选择界面均显示账号余额：`$(coin)/$(error) 充值 ¥X.XX` + `$(gift) 赠送 ¥Y.YY（至 YYYY-MM-DD）`（`getAccountInfoCached` TTL 缓存）；查询失败 `$(warning) 余额未知` | ✅ |
| H9c | **展示逻辑单一来源** | 三处界面共用 `buildKeyQuickPickItems`（`commands/apiKeyDisplay.ts`），详情行由 `buildKeyDetailLine` 统一构建 | ✅ |
| H10 | 重复添加同一 key 值 | 提示已存在，不添加 | ✅ |
| H11 | key 值格式 | 不强制 `sk_` 前缀，允许任意值（平台可能调整格式） | ✅ |

### 4.7 迁移与兼容（`keys/store.ts`）

| # | 情况 | 处理 | 覆盖 |
|---|------|------|------|
| I1 | 旧 `senseaudio.apiKey` 存在、新格式不存在 | 迁移为单元素列表 `{keys:[{value}], activeIndex:0}` | ✅ |
| I2 | 新格式已存在 | 以新格式为准，忽略旧 key | ✅ |
| I3 | 新格式 JSON 损坏 | 回退旧 key；重写修复 | ✅ |
| I4 | 迁移后删除旧 key | 删除成功才视为完成；失败则下次读取时重试（幂等） | ✅ |
| I5 | 空字符串 key | 忽略/剔除 | ✅ |
| I6 | 旧 `setApiKey` 命令 | 保留：写入新格式单元素列表（覆盖行为），兼容旧用户习惯 | ✅ |

### 4.8 配置边界（package.json 设置）

| # | 情况 | 处理 | 覆盖 |
|---|------|------|------|
| J1 | `apiKeyMode` 非法值 | 回退 `sticky` | ✅ |
| J2 | `apiKeyRotationStatusCodes` 空数组 | 仅按文本 patterns 匹配 | ✅ |
| J3 | `apiKeyRotationErrorPatterns` 空数组 | 仅按状态码匹配 | ✅ |
| J4 | 两者都空 | 禁用被动轮换 | ✅ |
| J5 | `apiKeyExhaustedCooldownMin = 0` | 429/503 冷却立即恢复（仍换 key，但可立即再用） | ✅ |
| J6 | `transientRetryTimes = 0` | 禁用瞬态整轮自动重试 | ✅ |
| J7 | `transientRetryTimes` 非法/超范围 | 夹取到 [0, 10]，非数字回退 3 | ✅ |
| J8 | `singleKeyFallback` 非法值 | 回退 `switch` | ✅ |
| J9 | 并发聊天请求 | 轮询游标为模块级变量，JS 单线程保证原子性；SecretStorage 以内存缓存为准，变更时写回 | ✅ |

### 4.9 持久化与内存（`keys/state.ts`）

| # | 情况 | 处理 | 覆盖 |
|---|------|------|------|
| K1 | `available` 状态 | 持久化（SecretStorage），重启保留 | ✅ |
| K2 | 429/503 冷却状态 | 内存，重启丢失（重启后自动重新检测，可接受） | ✅ |
| K3 | 轮询游标 | 内存，重启从头开始 | ✅ |
| K4 | 账号信息 TTL 缓存 | 内存，重启失效重新查询 | ✅ |

### 4.10 日志与错误信息

| # | 情况 | 处理 | 覆盖 |
|---|------|------|------|
| L1 | 每次轮换切换 | 日志 `key.rotation`：脱敏 key + 原因 | ✅ |
| L2 | 所有 key 不可用 | 错误信息列出各 key 失败原因（脱敏） | ✅ |
| L3 | 500 同 key 重试 | 日志 `key.transientRetrySameKey`（含 attempt 次数） | ✅ |
| L4 | 自愈恢复 | 日志 `key.recovered` | ✅ |
| L5 | 日志中任何 key/cookie 值 | 一律脱敏（`sk_****abcd` / `sess_****abcd`） | ✅ |

---

## 5. 设置项（package.json configuration）

| 设置 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `senseaudio.apiKeyMode` | string | `sticky` | `sticky` / `rotation` / `single` |
| `senseaudio.singleKeyFallback` | string | `switch` | single 模式失败行为：`switch`（仅 402 切换）/ `error` |
| `senseaudio.apiKeyRotationStatusCodes` | number[] | `[401,402,429,503]` | 触发 key 轮换的状态码 |
| `senseaudio.apiKeyRotationErrorPatterns` | string[] | 见 `keys/config.ts` | 触发轮换的错误文本 patterns |
| `senseaudio.transientRetryStatusCodes` | number[] | `[429,500,503]` | 触发瞬态整轮重试的状态码（与轮换解耦） |
| `senseaudio.transientRetryTimes` | number | `3` | 瞬态整轮重试次数（0 禁用，夹取 0–10） |
| `senseaudio.apiKeyExhaustedCooldownMin` | number | `10` | 429/503 瞬态冷却时长（分钟） |
| `senseaudio.minBalanceCny` | number | `0` | 余额阈值（仅用于 UI 标记充值余额不足） |
| `senseaudio.balanceCheckIntervalSec` | number | `60` | 账号信息缓存 TTL（秒） |

---

## 6. 命令与 UI

| 命令 | 说明 |
|------|------|
| `senseaudio.setApiKey` | 旧版单 key 流程（写入多 key store） |
| `senseaudio.manageApiKeys` | 多 Key 管理 QuickPick（增删/批量导入/设为当前/绑定 cookie/重置失效/检测可用性/编辑/查询余额） |
| `senseaudio.checkUsage` | 查询套餐用量与余额（也绑定状态栏点击） |

---

## 7. 边界与已知限制

1. **余额竞态**：请求发出与余额变化之间存在时间差，被动检测（402）兜底。
2. **cookie 会话过期**：QuickPick 显示绑定状态并允许更新；cookie 目前仅作记录（余额查询已改为登录 token）。
3. **429/503 可能为账号级/平台级限流**：换 key 不一定有效，但尝试切换无害；全部 key 瞬态失败时整轮自动重试（退避）兜底。
4. **不引入 VS Code proposed API**。
5. **手动检测的"请求一次"用最小真实聊天请求**（`say ok` + `max_tokens=8`）：余额不足时被 402 拦截不消耗 token；`/v1/models` 不校验余额（余额 < 0 也 200），无法作为可用性判据。
6. **视觉代理轮内失败不轮换**：见 4.2 D2 设计理由。
7. **503 瞬态不持久化**：服务端繁忙不写 `available=false`（否则冷却到期后仍被阻挡），仅内存冷却；整轮重试前清空冷却（`resetExhaustedKeys(secrets,false)`）保证 `pickNextApiKey` 能重新选 key。
8. **500 不换 key**：平台内部错误与 key 无关，仅退避后重试同一 key（`forceKey`）。
9. **余额展示依赖登录 token**：数据源 `platform.senseaudio.cn/api/user/self`，按**账号**粒度（所有 key 共享）；未配置 token 时显示"余额未知"。
