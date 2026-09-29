import { logger } from "../core/logger";
import { getBalanceCheckIntervalSec } from "./config";
import {
    getAccountInfoWithStatus,
    type AccountInfo,
    type AccountInfoFetchStatus,
    type PlanUsageWindow,
} from "./accountInfo";

/**
 * 套餐用量快照模块（对标上游 opencode-go-copilot 的 `goUsage.ts`）。
 *
 * ## SenseAudio 的两套计费规则（**不可混为一谈**）
 *
 * 官方文档：<https://docs.senseaudio.cn/guides/account/token-plan>
 *
 * ### 1. 周期额度（限流窗口）—— 5h / 周
 * - **5 小时限额**：按首次请求时间起算，5 小时为周期定时刷新
 * - **周限额**：每周一 00:00:00 重置
 * - 耗尽后**等待下一周期自动恢复**，**不消耗代金券或现金余额**
 *
 * ### 2. 套餐积分（订阅额度）—— 月度总额
 * - **月限额**：每订阅月第 1 日 00:00:00 重置
 * - 对应 API 的 `credit_30d_limit` 窗口
 * - 耗尽后走**超额策略**：
 *   - `enable_extra_usage = true`（余额自动支付开启）→ 超出部分**按量计费**，
 *     按「代金券（按到期先后）→ 现金余额」顺序扣减
 *   - `enable_extra_usage = false` → **自动降级至 Free 版**
 *
 * 因此本模块把窗口分为两类：
 * - `quotaWindow`：订阅额度窗口（月度），决定是否进入超额状态
 * - `rateLimitWindows`：限流窗口（5h / 周），仅用于展示，耗尽不代表要扣余额
 *
 * ## 数据源
 * `GET platform.senseaudio.cn/api/user/self`（Bearer 登录 PASETO token），
 * 与 `accountInfo.ts` 共用 TTL 缓存。失败时**保留上一次成功快照**（静默降级），
 * 状态栏不会因一次网络抖动而清空。
 *
 * ## 移植到其他平台
 * 只需替换 `accountInfo.ts` 的 `queryAccountInfo`（端点 + 字段映射），
 * 本模块的窗口归一化 / 百分比 / 倒计时 / 摘要格式化逻辑可原样复用。
 * 详见 `docs/plan-usage-design.md`。
 */

/** 归一化后的窗口类型（屏蔽各平台不同的 key 命名）。 */
export type UsageWindowKind = "rolling" | "weekly" | "monthly" | "other";

/**
 * 计费模式（由套餐额度是否耗尽 + 余额自动支付开关决定）。
 * - `plan`：套餐额度未耗尽，正常使用套餐
 * - `extra`：套餐额度耗尽 + 已开启余额自动支付 → 超出部分按量计费
 * - `free`：套餐额度耗尽 + 未开启余额自动支付 → 降级至 Free 版
 */
export type PlanBillingMode = "plan" | "extra" | "free";

/** 余额快照（按量计费部分）。 */
export interface BalanceSnapshot {
    /** 现金余额（元） */
    cashCny: number;
    /** 代金券可用（元） */
    voucherCny: number;
    /** 合计可用（元）= 现金 + 代金券 */
    totalCny: number;
    /** 最早代金券到期时间（epoch 秒，无则 null） */
    earliestVoucherExpiry: number | null;
}

/** 套餐 + 余额的完整快照。 */
export interface PlanUsageSnapshot {
    /** 全部用量窗口（= info.usageInfos，便捷访问） */
    windows: PlanUsageWindow[];
    /**
     * 订阅额度窗口（月度，`credit_30d_limit`）。
     * 该窗口耗尽即进入超额状态；无月度窗口时为 undefined。
     */
    quotaWindow: PlanUsageWindow | undefined;
    /**
     * 限流窗口（5h / 周）。耗尽后等待下一周期恢复，**不消耗余额**。
     */
    rateLimitWindows: PlanUsageWindow[];
    /** 余额快照 */
    balance: BalanceSnapshot;
    /** 余额自动支付开关（API `enable_extra_usage`）——决定超额后是按量计费还是降级 Free */
    extraUsageEnabled: boolean;
    /** 当前计费模式 */
    billingMode: PlanBillingMode;
    /** 快照生成时间（ms） */
    fetchedAt: number;
}

/**
 * 最近一次拉取结果状态。
 * - `ok`：成功
 * - `unauthorized`：401，登录 token 失效
 * - `error`：网络 / 403 / 其他失败
 * - `no-token`：未配置登录 token（未调用过拉取）
 */
export type PlanUsageFetchStatus = AccountInfoFetchStatus | "no-token";

// ── 模块级缓存 ──
let cachedSnapshot: PlanUsageSnapshot | null = null;
let cacheTimestamp = 0;
let lastFetchStatus: PlanUsageFetchStatus = "no-token";
// 缓存所属的 token：换账号（token 变化）后旧账号快照不得再被同步读取返回
let cachedToken: string | undefined;

/**
 * 把 `AccountInfo` 归一化为快照。
 * 纯函数，便于单测（见 `test/test-plan-usage.mjs`）。
 */
export function buildSnapshot(info: AccountInfo, now = Date.now()): PlanUsageSnapshot {
    const quotaWindow = info.usageInfos.find((w) => classifyWindow(w.key, w.desc) === "monthly");
    const rateLimitWindows = info.usageInfos.filter((w) => {
        const kind = classifyWindow(w.key, w.desc);
        return kind === "rolling" || kind === "weekly";
    });
    const extraUsageEnabled = info.enableExtraUsage;
    const quotaExhausted = quotaWindow !== undefined && isWindowExhausted(quotaWindow);
    const billingMode: PlanBillingMode = !quotaExhausted
        ? "plan"
        : extraUsageEnabled
            ? "extra"
            : "free";
    return {
        windows: info.usageInfos,
        quotaWindow,
        rateLimitWindows,
        balance: {
            cashCny: info.balance,
            voucherCny: info.voucherAvailableCny,
            totalCny: info.balance + info.voucherAvailableCny,
            earliestVoucherExpiry: info.earliestVoucherExpiry,
        },
        extraUsageEnabled,
        billingMode,
        fetchedAt: now,
    };
}

/**
 * 拉取套餐用量（带 TTL 缓存 + 失败保留旧值）。
 *
 * @param loginToken 登录 PASETO token；缺失时返回 null 且状态置为 `no-token`
 * @param force 为 true 时绕过 TTL 强制刷新（用户显式刷新 / 点击状态栏）
 * @returns 快照；失败时返回上一次成功快照（可能为 null）
 */
export async function getPlanUsageCached(
    loginToken: string | undefined,
    force = false,
): Promise<PlanUsageSnapshot | null> {
    if (!loginToken) {
        lastFetchStatus = "no-token";
        // Token cleared → the previous account's snapshot must not linger in
        // the status bar (it belongs to a different/removed login).
        cachedSnapshot = null;
        cacheTimestamp = 0;
        cachedToken = undefined;
        return null;
    }

    // 换账号（token 变化）后旧账号快照立即失效，避免状态栏短暂显示他人数据
    if (cachedToken !== undefined && cachedToken !== loginToken) {
        cachedSnapshot = null;
        cacheTimestamp = 0;
    }

    const ttlSec = getBalanceCheckIntervalSec();
    if (!force && cachedSnapshot && ttlSec > 0 && Date.now() - cacheTimestamp < ttlSec * 1000) {
        return cachedSnapshot;
    }

    const { info, status } = await getAccountInfoWithStatus(loginToken, ttlSec, force);
    lastFetchStatus = status;
    if (!info) {
        // 失败：保留旧快照（静默降级），仅更新状态
        logger.debug("planUsage.fetch.failed", { status, hasStale: cachedSnapshot !== null });
        return cachedSnapshot;
    }

    cachedSnapshot = buildSnapshot(info);
    cacheTimestamp = Date.now();
    cachedToken = loginToken;
    logger.info("planUsage.fetch.ok", {
        windows: cachedSnapshot.windows.length,
        billingMode: cachedSnapshot.billingMode,
        balanceCny: cachedSnapshot.balance.totalCny,
    });
    return cachedSnapshot;
}

/** 同步读取缓存的快照（供状态栏渲染，不触发网络请求）。 */
export function getPlanUsageSnapshot(): PlanUsageSnapshot | null {
    return cachedSnapshot;
}

/** 最近一次拉取状态（供 `checkUsage` 命令区分 401 与一般失败）。 */
export function getPlanUsageFetchStatus(): PlanUsageFetchStatus {
    return lastFetchStatus;
}

// ---------------------------------------------------------------------------
// 窗口归一化与格式化（纯函数，便于单测与移植）
// ---------------------------------------------------------------------------

/**
 * 按 key / desc 判定窗口类型。
 * 宽容匹配：key 含 `5h`/`rolling`、`7d`/`week`、`30d`/`month` 即归类；
 * 无法识别时回退 `other`（仍会展示，只是标签用原始 desc）。
 */
export function classifyWindow(key: string, desc = ""): UsageWindowKind {
    const haystack = `${key} ${desc}`.toLowerCase();
    if (haystack.includes("5h") || haystack.includes("rolling") || haystack.includes("5小时")) {
        return "rolling";
    }
    if (haystack.includes("7d") || haystack.includes("week") || haystack.includes("周")) {
        return "weekly";
    }
    if (haystack.includes("30d") || haystack.includes("month") || haystack.includes("月")) {
        return "monthly";
    }
    return "other";
}

/** 窗口的短标签（状态栏 / tooltip 用）：`5H` / `Week` / `Month` / 原始 desc。 */
export function getWindowLabel(window: PlanUsageWindow): string {
    switch (classifyWindow(window.key, window.desc)) {
        case "rolling":
            return "5H";
        case "weekly":
            return "Week";
        case "monthly":
            return "Month";
        default:
            return window.desc || window.key;
    }
}

/**
 * 窗口使用率（0-100+，保留整数）。
 * `totalCount <= 0`（无套餐 / 未启用）时返回 0。
 *
 * 注意：
 * - `pendingCount`（排队中积分）计入已用，与平台网页口径一致。
 * - **不夹取上限**——套餐超额时（实测 Free 版 30 天窗口 `10,012 / 10,000`）
 *   平台网页显示 `100%`（四舍五入结果），但超额更多时应如实显示 `150%` 而非截断，
 *   便于用户察觉已进入按量计费。
 */
export function getWindowPercent(window: PlanUsageWindow): number {
    if (!Number.isFinite(window.totalCount) || window.totalCount <= 0) {
        return 0;
    }
    const used = window.usedCount + window.pendingCount;
    const percent = (used / window.totalCount) * 100;
    return Math.max(0, Math.round(percent));
}

/**
 * 窗口是否已耗尽（已用 + 排队 ≥ 上限）。
 *
 * ⚠️ 语义因窗口类型而异（见模块头注释）：
 * - **限流窗口**（5h / 周）耗尽 → 等待下一周期恢复，**不消耗余额**
 * - **订阅额度窗口**（月度）耗尽 → 进入超额状态（按量计费或降级 Free）
 */
export function isWindowExhausted(window: PlanUsageWindow): boolean {
    if (!Number.isFinite(window.totalCount) || window.totalCount <= 0) {
        return false;
    }
    return window.usedCount + window.pendingCount >= window.totalCount;
}

/**
 * 套餐订阅额度是否耗尽（**只看月度额度窗口**，不看 5h/周限流窗口）。
 *
 * 这是判断是否进入超额计费的唯一依据——5h/周窗口耗尽只是限流，
 * 等下一周期自动恢复，与余额无关。
 */
export function isPlanExhausted(snapshot: PlanUsageSnapshot | null): boolean {
    if (!snapshot || !snapshot.quotaWindow) {
        return false;
    }
    return isWindowExhausted(snapshot.quotaWindow);
}

/**
 * 取状态栏主文本要展示的窗口。
 *
 * 优先 5 小时限流窗口（与上游 `Go 5H 65%` 一致）——它是最贴近「现在还能不能用」
 * 的指标；无 5h 窗口时回退第一个窗口。
 */
export function getPrimaryWindow(snapshot: PlanUsageSnapshot | null): PlanUsageWindow | undefined {
    if (!snapshot) {
        return undefined;
    }
    return (
        snapshot.windows.find((w) => classifyWindow(w.key, w.desc) === "rolling") ??
        snapshot.windows[0]
    );
}

/**
 * 把重置时间（epoch 秒）格式化为紧凑倒计时，如 `2H13M` / `45M`。
 * 已过期或非法值返回空字符串。
 */
export function formatResetDuration(epochSec: number | null | undefined, now = Date.now()): string {
    if (epochSec === null || epochSec === undefined || !Number.isFinite(epochSec)) {
        return "";
    }
    const diffMs = epochSec * 1000 - now;
    if (!Number.isFinite(diffMs) || diffMs <= 0) {
        return "";
    }
    const totalMinutes = Math.max(1, Math.ceil(diffMs / 60000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0) {
        return `${hours}H${minutes}M`;
    }
    return `${minutes}M`;
}

/**
 * 构建一行用量摘要，如 `5h: 65% · 7d: 30% · 30d: 12%`。
 * 供 `checkUsage` 命令的信息通知使用。
 */
export function formatUsageSummary(snapshot: PlanUsageSnapshot | null): string {
    if (!snapshot || snapshot.windows.length === 0) {
        return "";
    }
    const parts: string[] = [];
    for (const window of snapshot.windows) {
        parts.push(`${getWindowLabel(window)}: ${getWindowPercent(window)}%`);
    }
    return parts.join(" \u00b7 ");
}

/**
 * 构建 tooltip 中的单窗口行，如 `5H——65% (6,500 / 10,000 积分)`。
 *
 * 与上游 `goUsage` 的 `5H——65%` 相比多带绝对积分——SenseAudio 的
 * `usage_infos` 提供 `used_count` / `total_count`，比只有百分比更有信息量。
 * 标签与百分比之间用全角破折号 `——` 连接（沿用上游视觉风格）。
 */
export function formatWindowLine(window: PlanUsageWindow): string {
    const label = getWindowLabel(window);
    const percent = getWindowPercent(window);
    const used = window.usedCount + window.pendingCount;
    const total = window.totalCount;
    if (!Number.isFinite(total) || total <= 0) {
        return `${label}——${percent}%`;
    }
    return `${label}——${percent}% (${used.toLocaleString()} / ${total.toLocaleString()} 积分)`;
}

/**
 * 构建计费模式说明行（tooltip 用）。
 *
 * 明确区分两套规则，避免用户误以为「5h 窗口耗尽会扣余额」：
 * - `plan`  → 套餐额度内
 * - `extra` → 套餐额度已耗尽，超出部分按量计费（代金券 → 现金）
 * - `free`  → 套餐额度已耗尽且未开启余额自动支付，已降级 Free 版
 */
export function formatBillingModeLine(snapshot: PlanUsageSnapshot | null): string {
    if (!snapshot) {
        return "";
    }
    switch (snapshot.billingMode) {
        case "extra":
            return "套餐额度已耗尽 · 超出部分按量计费（代金券 → 现金余额）";
        case "free":
            return "套餐额度已耗尽 · 未开启余额自动支付，已降级 Free 版";
        default:
            return "套餐额度内（5h / 周窗口耗尽仅限流，等待下一周期恢复，不扣余额）";
    }
}

/**
 * 构建一行余额摘要，如 `¥12.34` 或 `¥12.34 + 赠送 ¥5.00`。
 */
export function formatBalanceSummary(snapshot: PlanUsageSnapshot | null): string {
    if (!snapshot) {
        return "";
    }
    const { cashCny, voucherCny } = snapshot.balance;
    const parts = [`¥${cashCny.toFixed(2)}`];
    if (voucherCny > 0) {
        parts.push(`+ 赠送 ¥${voucherCny.toFixed(2)}`);
    }
    return parts.join(" ");
}
