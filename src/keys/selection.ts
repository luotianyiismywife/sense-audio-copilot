import * as vscode from "vscode";
import { getApiKeyMode } from "./config";
import { isApiKeyEligible } from "./health";
import { getRotationIndex, setRotationIndex } from "./state";
import { getApiKeyStore, saveApiKeyStore } from "./store";
import type { ApiKeyEntry, ApiKeyMode, ApiKeyStore } from "./types";

/**
 * Key 选择逻辑：主 key 获取、轮询/粘性选择、single 模式 fallback 判定。
 */

/**
 * 获取主 key（模型列表 / 启动同步等"任意有效 key 即可"的场景）。
 * - single → active key（跳过瞬态冷却与持久化不可用）
 * - sticky → 当前钉住的 key（不可用时从游标环形扫描第一个可用 key）
 * - rotation → 第一个可用的 key
 * 全部不可用时返回 undefined。注意：模型列表不校验余额（实测），无需关心 available 余额标记。
 */
export async function getPrimaryApiKey(secrets: vscode.SecretStorage): Promise<ApiKeyEntry | undefined> {
    const store = await getApiKeyStore(secrets);
    if (store.keys.length === 0) {
        return undefined;
    }

    if (getApiKeyMode() === "single") {
        const entry = store.keys[store.activeIndex] ?? store.keys[0];
        return isApiKeyEligible(entry) ? entry : undefined;
    }

    // rotation / sticky：从游标开始环形扫描
    const rotationIndex = getRotationIndex();
    for (let i = 0; i < store.keys.length; i++) {
        const entry = store.keys[(rotationIndex + i) % store.keys.length];
        if (isApiKeyEligible(entry)) {
            return entry;
        }
    }
    return undefined;
}

/**
 * 选择下一个要使用的 key。
 * - rotation：从游标开始环形扫描第一个可用 key，游标前移一位（每次请求都换 key）
 * - sticky：从游标开始环形扫描第一个可用 key，游标钉住不前移（固定使用该 key，
 *   仅当它失效——余额不足/401/429/503 等——变 ineligible 后下次才会切到下一个并钉住；
 *   原 key 恢复后不自动切回，保持前缀缓存亲和性）
 * - single：返回 active key（不可用返回 undefined，由调用方按 fallback 决定报错或降级为 rotation）
 */
export async function pickNextApiKey(
    secrets: vscode.SecretStorage,
    mode: ApiKeyMode
): Promise<ApiKeyEntry | undefined> {
    const store = await getApiKeyStore(secrets);
    if (store.keys.length === 0) {
        return undefined;
    }

    if (mode === "single") {
        const entry = store.keys[store.activeIndex] ?? store.keys[0];
        return isApiKeyEligible(entry) ? entry : undefined;
    }

    // rotation / sticky：从 rotationIndex 开始顺序查找第一个 eligible 的 key
    const rotationIndex = getRotationIndex();
    for (let i = 0; i < store.keys.length; i++) {
        const idx = (rotationIndex + i) % store.keys.length;
        const entry = store.keys[idx];
        if (isApiKeyEligible(entry)) {
            if (mode === "rotation") {
                setRotationIndex((idx + 1) % store.keys.length); // 游标前移到下一个
            } else {
                setRotationIndex(idx); // sticky：钉住当前 key，不前移
            }
            return entry;
        }
    }
    return undefined;
}

/**
 * single 模式（fallback=switch）下是否应因当前 key 不可用而自动切换。
 * 仅当**本轮请求**中当前 active key 因“余额不足”失败（`failedKeys` 记录的 reason ===
 * "balance"，来源：402 轮换错误或余额预检不足）时返回 true：
 * - balance（402）：确定性失败，换一个有余额的 key 即可继续 → 切换
 * - invalid（401）：key 配置问题，应报错交由用户处理 → 不切换
 * - rate_limited / server_error（429/503）：瞬态错误，换 key 规避不了平台限流/繁忙，
 *   由瞬态整轮重试兜底 → 不切换
 *
 * 本轮 `failedKeys` 无记录（请求开始时 active key 已因**历史**请求处于不可用/冷却状态）
 * 时不切换：上次 402 切换成功时 activeIndex 已随 `setActiveKeyByValue` 移到新 key，
 * 不会再走到这里；剩余场景（error 模式遗留、上次切换失败）直接报错更符合 single 模式
 * “严格使用当前 key”的语义。
 */
export async function shouldSingleKeyFallbackSwitch(
    secrets: vscode.SecretStorage,
    currentRequestFailures: ReadonlyMap<string, string>
): Promise<boolean> {
    const store = await getApiKeyStore(secrets);
    const active = store.keys[store.activeIndex] ?? store.keys[0];
    if (!active) {
        return false;
    }
    return currentRequestFailures.get(active.value) === "balance";
}

/**
 * 按 key 值把指定 key 设为 single 模式的当前 key（activeIndex 跟随移动）。
 * 供 single 模式 402 余额不足自动切换后调用——后续请求直接使用新 key，
 * 避免每次请求都重复“fallback 选择 + 弹窗通知”。
 */
export async function setActiveKeyByValue(secrets: vscode.SecretStorage, keyValue: string): Promise<void> {
    const store = await getApiKeyStore(secrets);
    const idx = store.keys.findIndex((k) => k.value === keyValue);
    if (idx < 0 || idx === store.activeIndex) {
        return;
    }
    store.activeIndex = idx;
    await saveApiKeyStore(secrets, store);
}

/**
 * 从 store 中选取账号级平台登录凭据（余额/套餐用量查询用）。
 *
 * 余额按**账号**粒度，所有 key 共享同一份凭据。优先取当前使用 key 的凭据，
 * 否则取第一个绑定了凭据的 key。均无凭据时返回 undefined（UI 显示“余额未知”）。
 */
export function pickAccountCredential(store: ApiKeyStore): string | undefined {
    const active = store.keys[store.activeIndex];
    if (active?.credential) {
        return active.credential;
    }
    return store.keys.find((k) => k.credential)?.credential;
}

/**
 * 读取 store 并选取账号级平台登录凭据（异步便捷封装）。
 */
export async function getAccountCredential(secrets: vscode.SecretStorage): Promise<string | undefined> {
    return pickAccountCredential(await getApiKeyStore(secrets));
}
