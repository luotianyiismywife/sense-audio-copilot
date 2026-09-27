import * as vscode from "vscode";
import { getExhaustedCooldownMin, getRotationErrorPatterns, getRotationStatusCodes, getTransientRetryStatusCodes } from "./config";
import { getTransientExhaustedMap } from "./state";
import { getApiKeyStore, saveApiKeyStore } from "./store";
import type { ApiKeyEntry, KeyDisplayStatus } from "./types";

/**
 * Key 可用性状态：瞬态冷却、轮换错误判定、失效原因提取与状态更新。
 */

/**
 * 瞬态失效原因：仅做内存冷却，不持久化 available=false。
 * （429 限流 / 503 服务端繁忙等"可能很快恢复"的错误——持久化会导致 key 在本会话永久不可用）
 */
const TRANSIENT_REASONS = new Set(["rate_limited", "server_error"]);

/** 是否为瞬态失效原因（429 限流 / 503 服务端繁忙） */
export function isTransientExhaustedReason(reason: string): boolean {
    return TRANSIENT_REASONS.has(reason);
}

/** 是否处于瞬态冷却中（429），返回剩余秒数 */
export function getTransientExhaustedInfo(keyValue: string): { reason: string; remainingSec: number } | undefined {
    const transientExhausted = getTransientExhaustedMap();
    const entry = transientExhausted.get(keyValue);
    if (!entry) {
        return undefined;
    }
    const cooldownMs = getExhaustedCooldownMin() * 60_000;
    if (cooldownMs <= 0) {
        // 冷却为 0：立即恢复
        transientExhausted.delete(keyValue);
        return undefined;
    }
    const remainingMs = entry.exhaustedAt + cooldownMs - Date.now();
    if (remainingMs <= 0) {
        transientExhausted.delete(keyValue);
        return undefined;
    }
    return { reason: entry.reason, remainingSec: Math.ceil(remainingMs / 1000) };
}

/** 判断 entry 是否可被选中（非冷却中、非持久化不可用） */
export function isApiKeyEligible(entry: ApiKeyEntry): boolean {
    if (entry.available === false) {
        return false;
    }
    return getTransientExhaustedInfo(entry.value) === undefined;
}

/**
 * 是否存在处于瞬态冷却中的 key（429 限流 / 503 服务端繁忙）。
 * 供"全部 key 不可选"时判断是否值得自动重试整轮（平台繁忙通常很快恢复）。
 */
export async function hasTransientExhaustedKey(secrets: vscode.SecretStorage): Promise<boolean> {
    const store = await getApiKeyStore(secrets);
    return store.keys.some((entry) => getTransientExhaustedInfo(entry.value) !== undefined);
}

/**
 * 判断错误是否应触发 key 轮换。
 * 匹配规则：状态码出现在配置列表 `[code]`/`status code`，或错误文本包含任一 patterns。
 */
export function isKeyRotationError(err: unknown): boolean {
    const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
    const statusCodes = getRotationStatusCodes();
    const patterns = getRotationErrorPatterns();

    // 状态码匹配：`[401]` / `status 401` 形式
    for (const code of statusCodes) {
        if (message.includes(`[${code}]`) || message.includes(`status ${code}`)) {
            return true;
        }
    }
    // 文本匹配（不区分大小写）
    for (const pattern of patterns) {
        if (pattern && message.includes(pattern.toLowerCase())) {
            return true;
        }
    }
    return false;
}

/**
 * 判断错误是否为"瞬态类"（平台繁忙/限流，可能很快恢复 → 值得整轮自动重试）。
 * 匹配 `senseaudio.transientRetryStatusCodes`（默认 [429, 503]）中的状态码。
 * 与 `isKeyRotationError` 解耦：触发轮换的状态码与触发自动重试的状态码可分别配置。
 */
export function isTransientRetryError(err: unknown): boolean {
    const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
    for (const code of getTransientRetryStatusCodes()) {
        if (message.includes(`[${code}]`) || message.includes(`status ${code}`)) {
            return true;
        }
    }
    return false;
}

/**
 * 从轮换错误中提取失效原因。
 * 基于状态码与错误文本（比 patterns 匹配更精确）：
 * - 402 / INSUFFICIENT_BALANCE / "余额不足" → "balance"
 * - 401 → "invalid"
 * - 429 / RATE_LIMITED → "rate_limited"
 * - 503 → "server_error"
 * - 封号（code=billing / "计费账户已被冻结"，400，2026-09-19 实测）→ "banned"
 * - 其他（文本 patterns 命中的轮换错误）→ "api_error"
 */
export function getKeyRotationReason(err: unknown): string {
    const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
    if (message.includes("[402]") || message.includes("status 402") || message.includes("insufficient_balance") || message.includes("余额不足")) {
        return "balance";
    }
    if (message.includes("[401]") || message.includes("status 401")) {
        return "invalid";
    }
    if (message.includes("[429]") || message.includes("status 429") || message.includes("rate_limited")) {
        return "rate_limited";
    }
    if (message.includes("[503]") || message.includes("status 503")) {
        return "server_error";
    }
    // 封号：400 + code=billing / "计费账户已被冻结"（确定性失败，持久化不可用）
    if (message.includes("计费账户已被冻结") || message.includes("\"code\":\"billing\"") || message.includes("ref_code:400901") || message.includes("ref_code\":400901")) {
        return "banned";
    }
    return "api_error";
}

/**
 * 获取 key 当前不可用的机器可读原因（供"全部 key 不可用"报错展示）：
 * - 瞬态冷却中（429/503）→ "rate_limited" / "server_error"
 * - 持久化不可用（available=false）→ "unavailable"
 * - 其他（未检测 / 余额不足 / 封号 / cookie 预检跳过）→ "balance"
 */
export function getKeyUnavailableReason(entry: ApiKeyEntry): string {
    const transient = getTransientExhaustedInfo(entry.value);
    if (transient) {
        return transient.reason;
    }
    if (entry.available === false) {
        return "unavailable";
    }
    return "balance";
}

/**
 * 标记 key 为不可用。
 * - 瞬态原因（rate_limited/server_error）→ 仅记录内存冷却，不持久化 available=false
 * - 确定性原因（balance/invalid/api_error）→ 持久化 available=false
 */
export async function markApiKeyExhausted(secrets: vscode.SecretStorage, keyValue: string, reason: string): Promise<void> {
    if (TRANSIENT_REASONS.has(reason)) {
        // 瞬态：只冷却，不持久化（冷却到期自动恢复）
        getTransientExhaustedMap().set(keyValue, { exhaustedAt: Date.now(), reason });
        return;
    }
    const store = await getApiKeyStore(secrets);
    const entry = store.keys.find((k) => k.value === keyValue);
    if (!entry) {
        return;
    }
    entry.available = false;
    entry.lastCheckedAt = Date.now();
    await saveApiKeyStore(secrets, store);
}

/** 标记 key 为可用（自愈 / 手动检测通过），清瞬态冷却 */
export async function markApiKeyAvailable(secrets: vscode.SecretStorage, keyValue: string): Promise<void> {
    const store = await getApiKeyStore(secrets);
    const entry = store.keys.find((k) => k.value === keyValue);
    if (!entry) {
        return;
    }
    entry.available = true;
    entry.lastCheckedAt = Date.now();
    getTransientExhaustedMap().delete(keyValue);
    await saveApiKeyStore(secrets, store);
}

/** 通用可用性更新 */
export async function updateKeyAvailability(
    secrets: vscode.SecretStorage,
    keyValue: string,
    available: boolean | null
): Promise<void> {
    const store = await getApiKeyStore(secrets);
    const entry = store.keys.find((k) => k.value === keyValue);
    if (!entry) {
        return;
    }
    entry.available = available;
    entry.lastCheckedAt = Date.now();
    if (available !== false) {
        getTransientExhaustedMap().delete(keyValue);
    }
    await saveApiKeyStore(secrets, store);
}

/** 清空瞬态冷却；可选将所有持久化不可用标记重置为 null（未检测） */
export async function resetExhaustedKeys(secrets: vscode.SecretStorage, resetPersisted: boolean): Promise<void> {
    getTransientExhaustedMap().clear();
    if (resetPersisted) {
        const store = await getApiKeyStore(secrets);
        let changed = false;
        for (const entry of store.keys) {
            if (entry.available === false) {
                entry.available = null;
                entry.lastCheckedAt = undefined;
                changed = true;
            }
        }
        if (changed) {
            await saveApiKeyStore(secrets, store);
        }
    }
}

/** 获取 key 的展示状态：available / unavailable / unknown / cooldown */
export function getKeyDisplayStatus(entry: ApiKeyEntry): KeyDisplayStatus {
    const transient = getTransientExhaustedInfo(entry.value);
    if (transient) {
        return "cooldown";
    }
    if (entry.available === true) {
        return "available";
    }
    if (entry.available === false) {
        return "unavailable";
    }
    return "unknown";
}
