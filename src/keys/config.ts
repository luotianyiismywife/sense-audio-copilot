import * as vscode from "vscode";
import { getRotationIndex } from "./state";
import type { ApiKeyMode, SingleKeyFallback } from "./types";

/**
 * API Key 相关配置读取。
 */

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

/** 读取触发轮换的状态码列表（默认 [401, 402, 429, 503]） */
export function getRotationStatusCodes(): number[] {
    return getConfig().get<number[]>("apiKeyRotationStatusCodes", [401, 402, 429, 503]);
}

/** 读取触发轮换的错误文本 patterns */
export function getRotationErrorPatterns(): string[] {
    return getConfig().get<string[]>("apiKeyRotationErrorPatterns", [
        "余额不足",
        "insufficient balance",
        "INSUFFICIENT_BALANCE",
        "balance",
        "RATE_LIMITED",
        "UPSTREAM_RATE_LIMITED",
        // 封号（计费账户被冻结）：400 + code=billing，2026-09-19 实测
        "计费账户已被冻结",
        "billing",
    ]);
}

/**
 * 读取触发"瞬态整轮自动重试"的状态码列表（默认 [429, 500, 503]）。
 *
 * 这些状态码代表**平台侧**问题（限流 / 服务端繁忙 / 内部错误），与 key 无关：
 * - 若**同时**命中 `apiKeyRotationStatusCodes`（如 429/503）→ 标记 key 冷却并换 key
 * - 若**未**命中（如 500）→ 不标记 key、不换 key，仅退避后重试整轮
 *   （500 是平台内部错误，换 key 无意义）
 */
export function getTransientRetryStatusCodes(): number[] {
    return getConfig().get<number[]>("transientRetryStatusCodes", [429, 500, 503]);
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
