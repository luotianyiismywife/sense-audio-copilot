# 套餐用量与余额显示 — 设计与移植指南

> 设计日期：2026-09-27 | 参考实现：上游 [opencode-go-copilot](https://github.com/OnesoftQwQ/opencode-go-copilot) 的 `goUsage.ts` + `statusBar.ts`
> 适用范围：状态栏主文本、悬停提示、`senseaudio.checkUsage` 命令（仅状态栏点击）

---

## 1. 为什么需要这个模块

上游 opencode-go-copilot 的状态栏主文本显示的是**套餐用量**（`Go 5H 65%`）而不是 Token 计数——因为对订阅制供应商来说，「这个 5 小时窗口还能用多少」比「这次请求花了多少 token」更有决策价值。Token 计数退居悬停提示。

SenseAudio 平台**同时存在两套计费规则**，比上游复杂，因此本模块的核心工作是**把两套规则正确区分并归一化**。

---

## 2. 两套计费规则（**关键，不可混淆**）

官方文档：<https://docs.senseaudio.cn/guides/account/token-plan>

### 2.1 周期额度（限流窗口）—— 5h / 周

| 窗口 | 重置规则 | 耗尽后行为 |
|------|----------|-----------|
| 5 小时限额 | 按**首次请求时间**起算，5 小时为周期定时刷新 | **等待下一周期自动恢复** |
| 周限额 | 每周一 00:00:00 重置 | **等待下一周期自动恢复** |

> 官方原文：「套餐额度在时间周期内耗尽后，需要等待下一个周期自动恢复额度，**不会消耗其他资源包或账户余额**。」

**结论：5h / 周窗口耗尽 ≠ 扣余额。** 它们只是限流。

### 2.2 套餐积分（订阅额度）—— 月度总额

| 窗口 | 重置规则 | 耗尽后行为 |
|------|----------|-----------|
| 月限额 | **每订阅月第 1 日 00:00:00** 重置 | 走「超额策略」 |

> 官方原文：「**超额策略**：套餐额度用尽后将暂停调用。如已开启余额自动支付，超出部分将按量计费；如未开启或不支持余额支付，则自动降级至 Free 版。」

**结论：月度窗口（`credit_30d_limit`）耗尽才进入超额状态。**

### 2.3 超额后的扣减顺序

```
套餐积分 → 代金券（按到期时间先后）→ 现金余额
```

`enable_extra_usage`（余额自动支付开关）决定超额后是**按量计费**还是**降级 Free 版**。

### 2.4 三态计费模式

| `billingMode` | 条件 | 状态栏主文本 |
|---------------|------|-------------|
| `plan` | 月度额度未耗尽 | `5H 65%` |
| `extra` | 月度额度耗尽 + `enable_extra_usage=true` | `余额 ¥358.78` |
| `free` | 月度额度耗尽 + `enable_extra_usage=false` | `余额 ¥0.00`（已降级 Free） |

---

## 3. 数据源

`GET https://platform.senseaudio.cn/api/user/self`

**认证**：`Authorization: Bearer <登录 PASETO token>`
token 来自浏览器 `localStorage` 的 `user.state.token`（60 天有效）。

**必需头**（缺则 403 forbidden，`ref_code:403002`）：

```
x-platform: WEB
x-product: SenseAudio
x-version: 1.0.2
Accept: application/json
```

### 3.1 响应结构（2026-09-27 实测）

```jsonc
{
  "usage_infos": [
    { "key": "credit_5h_limit",  "desc": "5小时积分",       "used_count": 0,     "pending_count": 0, "total_count": 10000, "reset_time": 1790495847 },
    { "key": "credit_7d_limit",  "desc": "每周全部模型积分", "used_count": 0,     "pending_count": 0, "total_count": 10000, "reset_time": 1790524800 },
    { "key": "credit_30d_limit", "desc": "30天积分",        "used_count": 10012, "pending_count": 0, "total_count": 10000, "reset_time": 1792166400 }
  ],
  "account_info": {
    "balance": 0,                    // 现金余额（元）
    "enable_extra_usage": true,      // 余额自动支付开关
    "status": "NORMAL",              // 账号状态
    "vouchers": [
      { "voucher_id": 66804, "name": "注册赠送代金券", "available": 18779487, "total": 20000000, "used": 1220513, "expire_at": 1792168235 }
      // ... 共 18 张
    ]
  },
  "balance": 0,
  "points": 0
}
```

### 3.2 ⚠️ 单位陷阱（两个「积分」不是同一单位）

| 概念 | 单位 | 换算 |
|------|------|------|
| 套餐 `usage_infos` 的积分 | 套餐积分 | 直接是数字（Free 版 30 天额度 = 10,000） |
| 代金券 `vouchers[].available` | 代金券积分 | **1 元 = 1,000,000 积分** |

**实测验证**：18 张代金券 `available` 合计 `358,779,431` → 网页显示「代金券余额 **358.78 元**」
（`358779431 / 1e6 = 358.779431`）。

> **历史 bug（已修）**：本模块曾用 `5000` 作除数（注释称「1 元 = 5000 积分」），
> 导致代金券余额显示为实际值的 **200 倍**（358.78 → 71,755.89）。
> 常量 `POINTS_PER_CNY = 1_000_000` 已固化并有回归测试。

**注意**：Free 版 30 天套餐额度仅 10,000 积分，而单张 ¥20 代金券即 20,000,000 积分——
两者相差 2000 倍，**绝不可混用换算比例**。

---

## 4. 模块结构

```
src/balance/
├── accountInfo.ts   # 端点 + 字段映射（移植时只需改这里）
│   ├── POINTS_PER_CNY = 1_000_000
│   ├── queryAccountInfo(loginToken)          → AccountInfo
│   ├── getAccountInfoWithStatus(token, ttl, force) → { info, status }
│   └── formatExpiryDate(epochSec)            → "YYYY-MM-DD"
├── planUsage.ts     # 归一化 + 缓存 + 格式化（移植时原样复用）
│   ├── buildSnapshot(info)                   → PlanUsageSnapshot   [纯函数]
│   ├── getPlanUsageCached(token, force)      → 带 TTL 缓存 + 失败保留旧值
│   ├── getPlanUsageSnapshot()                → 同步读缓存（状态栏渲染用）
│   ├── classifyWindow(key, desc)             → "rolling"|"weekly"|"monthly"|"other"
│   ├── getWindowPercent(window)              → 0-100+（不截断）
│   ├── isPlanExhausted(snapshot)             → 只看月度额度窗口
│   ├── formatResetDuration(epochSec)         → "2H13M"
│   └── formatWindowLine / formatUsageSummary / formatBillingModeLine
└── balanceCheck.ts  # barrel

src/ui/statusBar.ts  # 渲染 + 后台轮询 + 点击刷新
src/commands/checkUsageCommand.ts  # senseaudio.checkUsage 命令（仅状态栏点击）
```

### 4.1 数据流

```
initStatusBar(context, getCredential)
  └── startUsagePolling()                    ← 立即刷新一次 + 定时器
        └── refreshPlanUsage()
              └── getPlanUsageCached(token)  ← TTL 缓存（默认 60s）
                    └── getAccountInfoWithStatus()
                          └── queryAccountInfo()  ← GET /api/user/self
              └── updateStatusBarUsageText() + updateCumulativeTooltip()

点击状态栏（senseaudio.checkUsage）
  └── refreshPlanUsageNow()                  ← force=true 绕过 TTL
```

### 4.2 失败降级策略

| 场景 | 行为 |
|------|------|
| 未配置登录 token | 状态栏显示 `--`，轮询跳过（`planUsage.poll.skip`） |
| 401 token 失效 | 保留旧快照；`checkUsage` 命令提示重新复制 token |
| 网络 / 403 失败 | **保留上一次成功快照**（静默降级），状态栏不清空 |
| 首次拉取即失败 | 状态栏显示 `--` |

---

## 5. 状态栏展示

### 5.1 主文本

| 状态 | 文本 |
|------|------|
| 有数据，额度内 | `$(pulse) 5H 65%` |
| 有数据，额度耗尽 | `$(pulse) 余额 ¥358.78` |
| 无数据 | `$(pulse) --` |
| `showUsageInStatusBar=false` | `$(symbol-numeric) 12.3K ▅ 45.2%`（Token 计数，旧行为） |

### 5.2 悬停提示

```
↑ 12.3K (1.2K cached, 65%)
↓ 4.5K

5H——0% (0 / 10,000 积分)
Week——0% (0 / 10,000 积分)
Month——100% (10,012 / 10,000 积分)
五小时窗口将在 2H13M 后重置

余额——¥0.00 + 赠送 ¥358.78
套餐额度已耗尽 · 超出部分按量计费（代金券 → 现金余额）
```

### 5.3 配置项

| 配置 | 默认 | 说明 |
|------|------|------|
| `senseaudio.showUsageInStatusBar` | `true` | 主文本显示套餐用量（关闭则显示 Token 计数） |
| `senseaudio.showUsageInTooltip` | `true` | 悬停提示显示套餐用量区块 |
| `senseaudio.usageRefreshInterval` | `5` | 后台刷新间隔（分钟，1-60） |
| `senseaudio.enableThirdPartyTokenIndicator` | `false` | 是否显示高级 Token 计数器 |
| `senseaudio.minBalanceCny` | `0` | 余额阈值（合计可用 ≤ 该值标记 error 图标） |
| `senseaudio.balanceCheckIntervalSec` | `60` | 账号信息缓存 TTL（秒） |

### 5.4 ⚠️ 状态栏可见性（易踩坑）

状态栏承载**两个独立功能**：套餐用量 + 高级 Token 计数器。可见性由
`isStatusBarEnabled()` 决定：

```ts
isThirdPartyIndicatorEnabled() || isUsageInStatusBarEnabled() || isUsageTooltipEnabled()
```

**不能**只用 `enableThirdPartyTokenIndicator` 控制——它默认 `false`，
若用它单独把关，套餐用量功能将**永远不可见**（这是实现过程中踩过的坑）。

状态栏仍保留「仅在使用本插件模型时显示、空闲 60 秒后隐藏」的行为。

---

## 6. 移植到其他平台

### 6.1 只需改 `accountInfo.ts`

1. **换端点**：`PLATFORM_USER_SELF_URL` → 目标平台端点
2. **换认证**：`PLATFORM_HEADERS` + `Authorization` 头
3. **换字段映射**：`queryAccountInfo` 里的响应解析（`usage_infos` / `account_info` 字段名）
4. **换换算比例**：`POINTS_PER_CNY`（若目标平台用积分）

### 6.2 `planUsage.ts` 可原样复用

`classifyWindow` 已做**宽容匹配**，同时支持：

| 平台 | key 示例 | 匹配依据 |
|------|----------|----------|
| SenseAudio | `credit_5h_limit` / `credit_7d_limit` / `credit_30d_limit` | `5h` / `7d` / `30d` |
| opencode-go | `rolling` / `weekly` / `monthly` | 英文关键词 |
| 通用 | `5h` / `7d` / `30d` | 短标签 |

匹配关键词：`5h`/`rolling`/`5小时`、`7d`/`week`/`周`、`30d`/`month`/`月`。
无法识别时回退 `other`（仍会展示，标签用原始 `desc`）。

### 6.3 移植检查清单

- [ ] 端点与认证头（`accountInfo.ts`）
- [ ] 响应字段映射（`accountInfo.ts`）
- [ ] 积分换算比例（`POINTS_PER_CNY`）
- [ ] 窗口 key 命名是否被 `classifyWindow` 覆盖（否则补关键词）
- [ ] 是否有「限流窗口 vs 订阅额度」的区分（若无，`quotaWindow` 可指向唯一窗口）
- [ ] 超额策略（按量计费 / 降级）是否与 `billingMode` 三态对应
- [ ] 更新 `test/test-plan-usage.mjs` 的真实响应夹具
- [ ] 更新 `package.nls.json` / `package.nls.zh-cn.json` 配置描述

### 6.4 若目标平台只有百分比（无绝对积分）

上游 opencode-go 的 `/usage` 端点只返回 `percent` + `resetsAt`。此时：

- `PlanUsageWindow.totalCount` 填 `100`、`usedCount` 填 `percent`（`getWindowPercent` 会得到相同百分比）
- `formatWindowLine` 在 `totalCount <= 0` 时自动省略积分部分，输出 `5H——65%`
- 或直接改 `formatWindowLine` 只输出百分比

---

## 7. 测试

```bash
npm run compile
node test/test-plan-usage.mjs
```

覆盖 29 项断言：

| 分组 | 内容 |
|------|------|
| 窗口归一化 | SenseAudio / 上游 / 通用 key 命名，`other` 回退 |
| 百分比 | 常规、pending 计入、超额不截断、`total=0` 兜底 |
| 超额判定 | `isWindowExhausted` 边界、`isPlanExhausted` 只看月度窗口 |
| 计费模式 | `plan` / `extra` / `free` 三态 |
| 倒计时 | 小时+分钟、仅分钟、不足 1 分钟、过期/非法值 |
| 摘要格式化 | `formatUsageSummary` / `formatWindowLine` / `formatBillingModeLine` / `formatBalanceSummary` |
| 快照构建 | 余额归一化、`quotaWindow`/`rateLimitWindows` 分类 |
| **真实夹具回归** | 代金券 200 倍换算 bug、真实 `usage_infos` 百分比、`extra` 模式判定 |

---

## 8. 已知限制

1. **登录 token 需手动复制**：平台未提供 OAuth，用户需从浏览器 `localStorage` 复制（60 天有效）。
2. **`credits` 字段未使用**：API 返回 `credits: []`，语义未明，暂不展示。
3. **`channel_balance` 未使用**：API 返回 `channel_balance` / `channel_balance_in_flight`，疑似渠道余额，暂不展示。
4. **Free 版无月度窗口时**：`quotaWindow` 为 `undefined`，`isPlanExhausted` 返回 `false`（视为额度内）。
5. **状态栏自动隐藏**：沿用原有逻辑——仅在用户实际使用本插件模型时显示，空闲 60 秒后隐藏。
