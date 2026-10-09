import * as vscode from "vscode";
import { logger } from "../core/logger";
import {
    LEGACY_KEY,
    STORE_KEY,
    getRotationIndex,
    getStoreCache,
    getTransientExhaustedMap,
    notifyApiKeyStoreChanged,
    setRotationIndex,
    setStoreCache,
} from "./state";
import type { ApiKeyEntry, ApiKeyStore } from "./types";

/**
 * API Key store 的 SecretStorage 读写、迁移与增删改。
 */

/**
 * 读取 API Key store。自动迁移旧版单 key（`senseaudio.apiKey`）为单元素列表；
 * JSON 损坏时回退旧 key 并修复。结果缓存到内存。
 */
export async function getApiKeyStore(secrets: vscode.SecretStorage): Promise<ApiKeyStore> {
    const cached = getStoreCache();
    if (cached) {
        return cached;
    }

    let store: ApiKeyStore | null = null;
    const raw = await secrets.get(STORE_KEY);
    if (raw) {
        try {
            const parsed = JSON.parse(raw) as Partial<ApiKeyStore>;
            if (Array.isArray(parsed.keys)) {
                store = {
                    keys: parsed.keys
                        .filter((k) => k && typeof k.value === "string" && k.value.trim().length > 0)
                        .map((k) => ({
                            value: k.value.trim(),
                            label: k.label,
                            // 向后兼容：旧数据字段名为 cookie，新字段名为 credential
                            credential: k.credential ?? (k as { cookie?: string }).cookie,
                            available: k.available ?? null,
                            lastCheckedAt: k.lastCheckedAt,
                        })),
                    activeIndex: typeof parsed.activeIndex === "number" && parsed.activeIndex >= 0 ? parsed.activeIndex : 0,
                };
            }
        } catch (err) {
            logger.warn("keyManager.store.parse", { error: err instanceof Error ? err.message : String(err) });
        }
    }

    // 新格式不存在或损坏 → 回退旧版单 key
    if (!store || store.keys.length === 0) {
        const legacy = await secrets.get(LEGACY_KEY);
        if (legacy && legacy.trim()) {
            store = { keys: [{ value: legacy.trim(), available: null }], activeIndex: 0 };
            // 立即迁移写入新格式（save 会删除旧 key）
            await saveApiKeyStore(secrets, store);
        }
    }

    if (!store) {
        store = { keys: [], activeIndex: 0 };
    }
    // 修正 activeIndex 越界
    if (store.activeIndex >= store.keys.length) {
        store.activeIndex = 0;
    }

    setStoreCache(store);
    // Another window may have written to SecretStorage (e.g. cloud sync pull);
    // invalidate the in-memory cache so the next read picks up the fresh data.
    // (SecretStorage has no change event, so polling on each read is the only way.)
    //
    // 用**语义比较**而非字符串比较：归一化会重排字段顺序（如云同步写入的
    // `value, credential, label` vs 归一化的 `value, label, credential`），
    // 字符串比较会永远不相等 → 缓存被永久禁用（每次读取都访问 SecretStorage）。
    void secrets.get(STORE_KEY).then((fresh) => {
        if (fresh && !storeMatchesRaw(fresh, store)) {
            invalidateApiKeyStoreCache();
        }
    });
    return store;
}

/** 语义比较：SecretStorage 原始字符串与内存 store 是否等价（忽略字段顺序）。 */
function storeMatchesRaw(raw: string, store: ApiKeyStore): boolean {
    try {
        const parsed = JSON.parse(raw) as Partial<ApiKeyStore>;
        if (!Array.isArray(parsed.keys) || parsed.keys.length !== store.keys.length) {
            return false;
        }
        if ((parsed.activeIndex ?? 0) !== store.activeIndex) {
            return false;
        }
        return parsed.keys.every((k, i) => {
            const s = store.keys[i];
            return (
                k.value === s.value &&
                (k.label ?? undefined) === (s.label ?? undefined) &&
                ((k.credential ?? (k as { cookie?: string }).cookie) ?? undefined) === (s.credential ?? undefined) &&
                (k.available ?? null) === (s.available ?? null) &&
                (k.lastCheckedAt ?? undefined) === (s.lastCheckedAt ?? undefined)
            );
        });
    } catch {
        return false;
    }
}

/**
 * 保存 API Key store 到 SecretStorage，成功后删除旧版单 key（幂等）。
 */
export async function saveApiKeyStore(secrets: vscode.SecretStorage, store: ApiKeyStore): Promise<void> {
    await secrets.store(STORE_KEY, JSON.stringify(store));
    try {
        await secrets.delete(LEGACY_KEY);
    } catch {
        // ignore legacy key deletion failures (idempotent retry on next save)
    }
    setStoreCache(store);
    notifyStoreWrite();
}

/** 使内存缓存失效（外部修改 SecretStorage 时调用） */
export function invalidateApiKeyStoreCache(): void {
    setStoreCache(null);
}

/** 添加 key（校验重复值）；可选附带 label / credential */
export async function addApiKey(secrets: vscode.SecretStorage, entry: ApiKeyEntry): Promise<boolean> {
    const store = await getApiKeyStore(secrets);
    if (store.keys.some((k) => k.value === entry.value)) {
        return false; // 已存在
    }
    store.keys.push({
        value: entry.value,
        label: entry.label,
        credential: entry.credential,
        available: entry.available ?? null,
    });
    await saveApiKeyStore(secrets, store);
    return true;
}

/**
 * 批量添加多个 API Key（三元组：key / credential / 备注）。
 * 已有重复 key **不跳过**，转为更新其 credential（补全缺失的 credential，且新 credential 覆盖旧的）。
 * 返回新增数量与更新数量。
 */
export async function addApiKeys(
    secrets: vscode.SecretStorage,
    entries: { value: string; credential?: string; label?: string }[]
): Promise<{ added: number; updated: number }> {
    const store = await getApiKeyStore(secrets);
    let added = 0;
    let updated = 0;

    for (const entry of entries) {
        const value = entry.value?.trim();
        if (!value) {
            continue;
        }
        const credential = entry.credential?.trim() || undefined;
        const label = entry.label?.trim() || undefined;

        const existing = store.keys.find((k) => k.value === value);
        if (existing) {
            // 已存在 → 更新 credential（补全或覆盖），不重复添加
            if (credential && existing.credential !== credential) {
                existing.credential = credential;
                updated++;
            }
            continue;
        }
        store.keys.push({
            value,
            label,
            credential,
            available: null,
        });
        added++;
    }

    if (added > 0 || updated > 0) {
        await saveApiKeyStore(secrets, store);
    }
    return { added, updated };
}

function notifyStoreWrite(): void {
    notifyApiKeyStoreChanged();
}

/** 删除 key；自动修正 activeIndex 与轮询游标，并清理该 key 的瞬态冷却条目 */
export async function removeApiKey(secrets: vscode.SecretStorage, index: number): Promise<void> {
    const store = await getApiKeyStore(secrets);
    if (index < 0 || index >= store.keys.length) {
        return;
    }
    const [removed] = store.keys.splice(index, 1);
    // 清理被删 key 的瞬态冷却条目（避免内存残留；也防止之后添加相同 value
    // 的新 key 时意外继承旧冷却状态）
    if (removed) {
        getTransientExhaustedMap().delete(removed.value);
    }
    if (store.activeIndex >= store.keys.length) {
        store.activeIndex = store.keys.length > 0 ? store.keys.length - 1 : 0;
    }
    if (getRotationIndex() >= store.keys.length) {
        setRotationIndex(0);
    }
    await saveApiKeyStore(secrets, store);
}

/** 设置 single 模式的当前 key */
export async function setActiveKey(secrets: vscode.SecretStorage, index: number): Promise<void> {
    const store = await getApiKeyStore(secrets);
    if (index < 0 || index >= store.keys.length) {
        return;
    }
    store.activeIndex = index;
    await saveApiKeyStore(secrets, store);
}

/** 绑定 / 更新 / 清除指定 key 的平台登录凭据 */
export async function setKeyCredential(secrets: vscode.SecretStorage, index: number, credential?: string): Promise<void> {
    const store = await getApiKeyStore(secrets);
    if (index < 0 || index >= store.keys.length) {
        return;
    }
    store.keys[index].credential = credential ? credential.trim() : undefined;
    await saveApiKeyStore(secrets, store);
}

/**
 * 编辑指定 key 的三个字段（key 值 / 平台登录凭据 / 备注）。
 * 修改 key 值时会校验不与其它已存在 key 冲突。
 * 仅更新调用方提供的字段（undefined 表示不修改）。
 */
export async function updateApiKey(
    secrets: vscode.SecretStorage,
    index: number,
    fields: { value?: string; label?: string; credential?: string }
): Promise<{ ok: boolean; conflict?: boolean }> {
    const store = await getApiKeyStore(secrets);
    if (index < 0 || index >= store.keys.length) {
        return { ok: false };
    }
    const entry = store.keys[index];

    if (fields.value !== undefined && fields.value.trim()) {
        const newValue = fields.value.trim();
        if (newValue !== entry.value && store.keys.some((k) => k.value === newValue)) {
            return { ok: false, conflict: true }; // 与其他 key 冲突
        }
        if (newValue !== entry.value) {
            // 清理旧值的瞬态冷却条目（避免内存残留；新值不应继承旧冷却）
            getTransientExhaustedMap().delete(entry.value);
        }
        entry.value = newValue;
    }
    if (fields.label !== undefined) {
        entry.label = fields.label.trim() || undefined;
    }
    if (fields.credential !== undefined) {
        entry.credential = fields.credential.trim() || undefined;
    }
    await saveApiKeyStore(secrets, store);
    return { ok: true };
}
