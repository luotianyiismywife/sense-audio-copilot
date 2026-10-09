import * as vscode from "vscode";
import type { CancellationToken } from "vscode";
import { l10n, l10nFormat } from "../core/localize";
import { logger } from "../core/logger";
import { CommonApi } from "../api/commonApi";
import {
    getApiKeyMode,
    getApiKeyStore,
    getSingleKeyFallback,
    getTransientRetryTimes,
    hasTransientExhaustedKey,
    markApiKeyAvailable,
    markApiKeyExhausted,
    maskApiKey,
    matchErrorRule,
    pickNextApiKey,
    setActiveKeyByValue,
    shouldSingleKeyFallbackSwitch,
    type ApiKeyEntry,
} from "../keys/keyManager";
import { REASON_TEXT, buildAllKeysUnavailableDetail, tryTransientRetryRound } from "./errors";

/**
 * 多 API Key 轮换循环。
 *
 * 每轮选一个 key，跳过余额不足（凭据主动预检）或返回轮换错误
 * （401/402/429/503，状态码与文本 patterns 可配置）的 key。
 * 全部 key 用尽时列出脱敏 key + 失败原因；若失败均为瞬态（429/503）
 * 则按 `senseaudio.transientRetryTimes` 指数退避重试整轮。
 *
 * **平台侧瞬态错误（如 500）不换 key**：500 是平台内部错误，与 key 无关，
 * 换 key 无意义。这类错误命中 `transientRetryStatusCodes` 但**不**命中
 * `apiKeyRotationStatusCodes` 时，仅退避后重试整轮（key 不标记失效）。
 *
 * 从 `provider.ts` 抽出，使 Provider 类只负责 VS Code 接口与编排。
 */

export interface RotationLoopParams {
    secrets: vscode.SecretStorage;
    token: CancellationToken;
    abortController: AbortController;
    /** 用选中的 key 执行一次完整请求（协议分发 + 视觉代理）。 */
    execute: (apiKey: string, requestHeaders: Record<string, string>) => Promise<void>;
    /** 模型自定义请求头（来自模型配置）。 */
    customHeaders?: Record<string, string>;
    /** 协议模式，用于构造请求头（anthropic 用 x-api-key）。 */
    apiMode: string;
    /** 成功使用 fallback key 后的通知回调（single 模式余额不足自动切换）。 */
    onFallbackSwitch?: (entry: ApiKeyEntry) => void;
}

/**
 * 运行轮换循环直到成功、用户取消、超时或全部 key 失败。
 * 失败时抛出带脱敏详情的错误。
 */
export async function runKeyRotationLoop(params: RotationLoopParams): Promise<void> {
    const { secrets, token, abortController, execute, customHeaders, apiMode } = params;

    const apiKeyMode = getApiKeyMode();
    const singleFallback = getSingleKeyFallback();
    let currentEntry: ApiKeyEntry | undefined;
    let usedFallbackKey = false; // single mode performed a balance-triggered switch
    // Platform-side transient error (e.g. 500) retry: force re-use of the
    // SAME key on the next round. Without this, rotation mode's cursor has
    // already advanced and pickNextApiKey would silently switch to the next
    // key — contradicting "500 is a platform problem, do not rotate keys".
    let forceKey: ApiKeyEntry | undefined;
    // Track per-key failure reasons so the "all keys exhausted" error can
    // show which key failed and why (masked), and distinguish transient
    // failures (429/503 — retry later) from permanent ones (402/401 — check).
    const failedKeys = new Map<string, string>();
    // Transient (429/503) whole-round auto-retry: when every key is busy or
    // rate-limited, wait with backoff and retry the whole round instead of
    // failing immediately (platform congestion usually clears within seconds).
    const maxTransientRetries = getTransientRetryTimes();
    // Per-scenario retry counters: a 500 same-key retry must not consume the
    // 429/503 whole-round retry quota (and vice versa) — otherwise a few 500s
    // could exhaust the quota and give up on a recoverable rate-limit burst.
    let wholeRoundRetryCount = 0; // all keys transient-failed / none eligible
    let sameKeyRetryCount = 0; // platform-side error, retry same key

    const store = await getApiKeyStore(secrets);
    if (store.keys.length === 0) {
        logger.warn("apiKey.missing", {});
        throw new Error(l10n("SenseAudio API key not found"));
    }
    const totalKeys = store.keys.length;

    while (true) {
        // If every key has failed at least one round, stop trying.
        if (totalKeys > 0 && failedKeys.size >= totalKeys) {
            const detail = [...failedKeys.entries()]
                .map(([key, reason]) => `${maskApiKey(key)}: ${l10n(REASON_TEXT[reason] ?? reason)}`)
                .join("; ");
            const hasTransient = [...failedKeys.values()].some((r) => r === "rate_limited" || r === "server_error");
            // Platform busy / rate-limited: back off and retry the whole
            // round automatically instead of failing immediately.
            if (hasTransient && (await tryTransientRetryRound(secrets, wholeRoundRetryCount, maxTransientRetries))) {
                wholeRoundRetryCount++;
                failedKeys.clear();
                continue;
            }
            logger.warn("key.allUnavailable", { detail });
            if (hasTransient) {
                throw new Error(l10nFormat("All API keys are temporarily unavailable ({0}). Please retry later.", detail));
            }
            throw new Error(l10nFormat("All API keys are unavailable ({0}). Use the Manage API Keys command to check availability.", detail));
        }

        // 1. Pick the next candidate key (forced re-use after a platform-side
        // transient error — the key itself is fine, do not rotate)
        currentEntry = forceKey ?? (await pickNextApiKey(secrets, apiKeyMode));
        forceKey = undefined;
        if (!currentEntry) {
            // single mode + fallback=switch → switch ONLY when the current
            // key is balance-exhausted (402 / balance pre-check failed this
            // round). Other rotation errors (401 invalid key, 429/503
            // transient) do NOT switch — they fail below (the transient
            // whole-round retry still applies for 429/503). On a balance
            // switch the new key also becomes the "current" key so later
            // requests use it directly (no repeated fallback+notification).
            if (
                apiKeyMode === "single" &&
                singleFallback === "switch" &&
                (await shouldSingleKeyFallbackSwitch(secrets, failedKeys))
            ) {
                usedFallbackKey = true;
                currentEntry = await pickNextApiKey(secrets, "rotation");
                if (currentEntry) {
                    await setActiveKeyByValue(secrets, currentEntry.value);
                    logger.info("key.singleSwitch", { key: maskApiKey(currentEntry.value) });
                }
            }
            if (!currentEntry) {
                // Every key is excluded (persisted unavailable / cooldown /
                // insufficient balance). If any key is merely in transient
                // cooldown (429/503), back off and retry the whole round.
                if (
                    (await hasTransientExhaustedKey(secrets)) &&
                    (await tryTransientRetryRound(secrets, wholeRoundRetryCount, maxTransientRetries))
                ) {
                    wholeRoundRetryCount++;
                    failedKeys.clear();
                    continue;
                }
                // Show why each key can't be used. In single mode only the
                // current key (plus any switched-to keys) were tried — use
                // a dedicated message instead of "all keys unavailable".
                const detail = await buildAllKeysUnavailableDetail(secrets);
                logger.warn("key.allUnavailable", { detail });
                if (apiKeyMode === "single") {
                    throw new Error(
                        l10nFormat(
                            "Current API key is unavailable ({0}). Single mode only switches keys on insufficient balance (402); retry later or check via the Manage API Keys command.",
                            detail
                        )
                    );
                }
                throw new Error(
                    l10nFormat("All API keys are unavailable ({0}). Use the Manage API Keys command to check availability.", detail)
                );
            }
        }

        // 2. Prepare headers with the selected key
        const requestHeaders = CommonApi.prepareHeaders(currentEntry.value, apiMode, customHeaders);
        logger.debug("request.headers", {
            key: maskApiKey(currentEntry.value),
            headers: logger.sanitizeHeaders(requestHeaders as Record<string, string>),
        });

        // 3. Execute the full API request (protocol dispatch + vision proxy)
        try {
            await execute(currentEntry.value, requestHeaders);

            // Success — self-heal if this key was previously marked unavailable
            if (currentEntry.available === false) {
                await markApiKeyAvailable(secrets, currentEntry.value);
                logger.info("key.recovered", { key: maskApiKey(currentEntry.value) });
            }
            if (usedFallbackKey) {
                params.onFallbackSwitch?.(currentEntry);
            }
            return;
        } catch (err) {
            // User cancellation / timeout → re-throw so the outer catch handles them
            if (token.isCancellationRequested) {
                throw err;
            }
            if (abortController.signal.aborted) {
                throw err; // timeout (outer catch shows friendly message)
            }
            // 错误分类（errorRules 四元组：code + message + statusCode + action）
            const rule = matchErrorRule(err);
            if (rule?.action === "rotateCooldown") {
                // 换 key + 仅内存冷却（瞬态，冷却到期自动恢复）
                const reason = rule.message ?? rule.code ?? "";
                failedKeys.set(currentEntry.value, reason);
                await markApiKeyExhausted(secrets, currentEntry.value, reason);
                logger.warn("key.rotation", {
                    key: maskApiKey(currentEntry.value),
                    reason,
                    error: err instanceof Error ? err.message : String(err),
                });
                continue; // try next key
            }
            if (rule?.action === "rotatePersist") {
                // 换 key + 持久化失效（确定性：封号 / 余额不足 / 无效 key）
                const reason = rule.message ?? rule.code ?? "";
                failedKeys.set(currentEntry.value, reason);
                await markApiKeyExhausted(secrets, currentEntry.value, reason);
                logger.warn("key.rotation", {
                    key: maskApiKey(currentEntry.value),
                    reason,
                    error: err instanceof Error ? err.message : String(err),
                });
                continue; // try next key
            }
            if (rule?.action === "retrySameKey") {
                // 不换 key，退避后重试同一个 key（平台侧/客户端侧瞬态问题）
                if (await tryTransientRetryRound(secrets, sameKeyRetryCount, maxTransientRetries)) {
                    sameKeyRetryCount++;
                    failedKeys.clear();
                    // Force the SAME key on the next round: the error is a
                    // platform/client-side problem, not a key problem.
                    forceKey = currentEntry;
                    logger.warn("key.transientRetrySameKey", {
                        key: maskApiKey(currentEntry.value),
                        attempt: sameKeyRetryCount,
                        error: err instanceof Error ? err.message : String(err),
                    });
                    continue; // retry the whole round with the same key
                }
                logger.warn("key.transientRetryExhausted", {
                    key: maskApiKey(currentEntry.value),
                    attempts: sameKeyRetryCount,
                });
            }

            throw err; // 未命中任何规则（403/网络/IMAGE_SENSITIVE…）
        }
    }
}
