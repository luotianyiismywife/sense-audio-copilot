/**
 * SenseAudio 多 API Key 管理模块入口（barrel）。
 *
 * 实现按职责拆分：
 * - `types.ts`     — ApiKeyEntry / ApiKeyStore / ApiKeyMode / SingleKeyFallback / KeyDisplayStatus
 * - `config.ts`    — 模式、状态码、patterns、冷却与重试次数等配置读取
 * - `state.ts`     — 模块级可变状态（store 缓存、轮询游标、瞬态冷却表）
 * - `store.ts`      — SecretStorage 读写、旧版单 key 迁移、增删改
 * - `selection.ts` — 主 key 获取、轮询/粘性选择、single fallback 判定
 * - `health.ts`    — 瞬态冷却、轮换错误判定、失效原因、状态更新
 * - `mask.ts`      — 脱敏显示辅助
 */

export type { ApiKeyEntry, ApiKeyStore, ApiKeyMode, SingleKeyFallback, KeyDisplayStatus } from "./types";

export {
    getApiKeyMode,
    getRotationCursorIndex,
    getSingleKeyFallback,
    getRotationStatusCodes,
    getRotationErrorPatterns,
    getTransientRetryStatusCodes,
    getExhaustedCooldownMin,
    getTransientRetryTimes,
} from "./config";

export {
    getApiKeyStore,
    saveApiKeyStore,
    invalidateApiKeyStoreCache,
    addApiKey,
    addApiKeys,
    removeApiKey,
    setActiveKey,
    setKeyCredential,
    updateApiKey,
} from "./store";

export {
    getPrimaryApiKey,
    pickNextApiKey,
    shouldSingleKeyFallbackSwitch,
    setActiveKeyByValue,
    pickAccountCredential,
    getAccountCredential,
} from "./selection";

export {
    getTransientExhaustedInfo,
    isApiKeyEligible,
    hasTransientExhaustedKey,
    isKeyRotationError,
    isTransientRetryError,
    isTransientExhaustedReason,
    getKeyRotationReason,
    getKeyUnavailableReason,
    markApiKeyExhausted,
    markApiKeyAvailable,
    updateKeyAvailability,
    resetExhaustedKeys,
    getKeyDisplayStatus,
} from "./health";

export { maskApiKey, maskCredential } from "./mask";
