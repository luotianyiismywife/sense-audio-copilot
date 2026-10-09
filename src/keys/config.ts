import * as vscode from "vscode";
import { getRotationIndex } from "./state";
import type { ApiKeyMode, SingleKeyFallback } from "./types";

/**
 * API Key 相关配置读取。
 */

/** 错误处置动作（与 key 状态一一对应） */
export type ErrorAction = "retrySameKey" | "rotateCooldown" | "rotatePersist";

/**
 * 单条错误分类规则（四元组：code + message + statusCode + action）。
 *
 * - `code`：错误响应体的 `error.code` 字段（精确匹配，**主要匹配字段**）
 * - `message`：错误消息说明（**仅提升可读性，不参与匹配**）
 * - `statusCode`：HTTP 状态码兑底（匹配 `[code]` / `status code` 形式）
 * - `action`：处置动作，与 key 状态一一对应：
 *   - `retrySameKey` → 状态不变（不换 key，退避后重试同一个 key）
 *   - `rotateCooldown` → 冷却中（换 key，仅内存冷却，到期自动恢复）
 *   - `rotatePersist` → 不可用（换 key，持久化 available=false）
 *
 * 规则按数组顺序匹配，首个命中即生效。
 */
export interface ErrorRule {
    code?: string;
    message?: string;
    statusCode?: number;
    action: ErrorAction;
}  

/** 默认错误分类规则（基于 2026-09/10 实测） */
const DEFAULT_ERROR_RULES: ErrorRule[] = [
    // 错误体 code 精确匹配（主要匹配字段）
    { code: "billing", message: "计费账户已被冻结（封号）", action: "rotatePersist" },
    { code: "upstream_stream_error", message: "上游模型流意外中断", action: "retrySameKey" },
    { code: "INSUFFICIENT_BALANCE", message: "余额不足", action: "rotatePersist" },
    // HTTP 状态码兑底
    { statusCode: 401, message: "无效 key", action: "rotatePersist" },
    { statusCode: 402, message: "余额不足", action: "rotatePersist" },
    { statusCode: 429, message: "限流", action: "rotateCooldown" },
    { statusCode: 503, message: "服务端繁忙", action: "rotateCooldown" },
    { statusCode: 400, message: "上游中断复用 400", action: "retrySameKey" },
    { statusCode: 500, message: "内部错误", action: "retrySameKey" },
];

function getConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("senseaudio");
}

/** 读取 key 使用模式（默认 sticky；非法值回退 sticky） */
export function getApiKeyMode(): ApiKeyMode {
    const mode = getConfig().get<string>("apiKeyMode", "sticky");
    if (mode === "rotation" || mode === "single" || mode === "sticky") {
        return mode;
    }
    return "sticky";
}

/** 读取当前轮询/粘性游标下标（供 UI 标记 sticky 模式下固定的 key） */
export function getRotationCursorIndex(): number {
    return getRotationIndex();
}

/** 读取 single 模式不可用时的行为（默认 switch；非法值回退 switch） */
export function getSingleKeyFallback(): SingleKeyFallback {
    const fallback = getConfig().get<string>("singleKeyFallback", "switch");
    return fallback === "error" ? "error" : "switch";
}

/**
 * 读取错误分类规则（四元组：code + message + statusCode + action）。
 *
 * **只配置这一处**即可覆盖所有错误分类：`code`（错误体 error.code 精确匹配，
 * **主要匹配字段**）优先于 `statusCode`（HTTP 状态码兑底）；`message` 仅作
 * 可读性说明不参与匹配；处置由 `action` 决定，与 key 状态一一对应
 * （`retrySameKey` 状态不变 / `rotateCooldown` 冷却中 / `rotatePersist` 不可用）。
 * 规则按数组顺序匹配，首个命中即生效。
 *
 * 默认规则基于 2026-09/10 实测：封号（`code=billing`，400）→ 不可用；
 * 上游流中断（`code=upstream_stream_error`，400）→ 不换重试；
 * 余额不足（`code=INSUFFICIENT_BALANCE`，402）→ 不可用；限流（429/503）→ 冷却。
 */
export function getErrorRules(): ErrorRule[] {
    const raw = getConfig().get<ErrorRule[]>("errorRules", DEFAULT_ERROR_RULES);
    if (!Array.isArray(raw) || raw.length === 0) {
        return DEFAULT_ERROR_RULES;
    }
    return raw.filter(
        (r): r is ErrorRule =>
            r &&
            typeof r === "object" &&
            typeof r.action === "string" &&
            (typeof r.code === "string" || typeof r.statusCode === "number")
    );
}
/** 读取 429 瞬态冷却时长（分钟，默认 10） */
export function getExhaustedCooldownMin(): number {
    const v = getConfig().get<number>("apiKeyExhaustedCooldownMin", 10);
    return Number.isFinite(v) && v >= 0 ? v : 10;
}

/** 读取瞬态失败（429/500/503）整轮自动重试次数（默认 3，夹取 0-10） */
export function getTransientRetryTimes(): number {
    const v = getConfig().get<number>("transientRetryTimes", 3);
    if (!Number.isFinite(v)) {
        return 3;
    }
    return Math.min(10, Math.max(0, Math.floor(v)));
}
