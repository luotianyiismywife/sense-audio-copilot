import type { ApiKeyStore } from "./types";

/**
 * keyManager 的模块级可变状态。
 *
 * 单独成文件，避免 `store.ts` / `selection.ts` / `health.ts` 之间循环依赖。
 */

/** SecretStorage 键名 */
export const STORE_KEY = "senseaudio.apiKeys";
export const LEGACY_KEY = "senseaudio.apiKey";

/** 内存缓存：避免每次读取都访问 SecretStorage */
let storeCache: ApiKeyStore | null = null;

/** 轮询游标：模块级，跨请求共享。rotation 模式选中后前移（顺序轮换）；sticky 模式选中后钉住不前移（固定使用） */
let rotationIndex = 0;

/** 瞬态失效表：429 限流等"可能恢复"的失效，带冷却时间 */
const transientExhausted = new Map<string, { exhaustedAt: number; reason: string }>();

export function getStoreCache(): ApiKeyStore | null {
    return storeCache;
}

export function setStoreCache(store: ApiKeyStore | null): void {
    storeCache = store;
}

export function getRotationIndex(): number {
    return rotationIndex;
}

export function setRotationIndex(index: number): void {
    rotationIndex = index;
}

export function getTransientExhaustedMap(): Map<string, { exhaustedAt: number; reason: string }> {
    return transientExhausted;
}
