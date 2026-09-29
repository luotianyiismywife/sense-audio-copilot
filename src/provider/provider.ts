import * as vscode from "vscode";
import {
    CancellationToken,
    LanguageModelChatInformation,
    LanguageModelChatProvider,
    LanguageModelChatRequestMessage,
    LanguageModelResponsePart,
    PrepareLanguageModelChatModelOptions,
    ProvideLanguageModelChatResponseOptions,
    Progress,
} from "vscode";

import * as path from "path";

import type { SenseAudioModelItem } from "../core/types";

import { createRetryConfig } from "../core/utils";

import { prepareLanguageModelChatInformation, getAutoDiscoveredModelConfig } from "../models/provideModel";
import { getBuiltInModelConfig } from "../models/models";
import { l10n, l10nFormat } from "../core/localize";
import { countMessageTokens, textTokenLength } from "../tokenizer/provideToken";
import {
    updateContextStatusBar,
    recordUsage,
    updateCumulativeTooltip,
    updateStatusBarWithApiPrompt,
    showTokenStatusBar,
    scheduleStatusBarHide,
} from "../ui/statusBar";
import type { StreamUsage } from "../api/commonApi";
import { logger } from "../core/logger";
import { maskApiKey } from "../keys/keyManager";
import { reportNativeUsage } from "./errors";
import { applyReasoningEffort, applyTemperature, resolveApiMode } from "./requestOptions";
import { runKeyRotationLoop } from "./rotation";
import { executeApiRequest } from "./apiDispatch";

// Re-export for backward compatibility (gitCommit imports these from provider).
export { REASON_TEXT, buildAllKeysUnavailableDetail, tryTransientRetryRound } from "./errors";

/**
 * VS Code Chat provider backed by SenseAudio API.
 *
 * 本类只负责 VS Code 接口实现与请求编排；具体逻辑分散在：
 * - `requestOptions.ts` — 推理强度 / temperature / apiMode 决策
 * - `rotation.ts`       — 多 key 轮换循环
 * - `apiDispatch.ts`    — 三协议分发与流式处理
 * - `visionRounds.ts`   — ask_image 图片代理多轮
 * - `errors.ts`         — 错误文案、瞬态重试、原生 token 指示器
 */
export class SenseAudioChatModelProvider implements LanguageModelChatProvider {
    /** Track last request completion time for delay calculation. */
    private _lastRequestTime: number | null = null;

    /**
     * Emitter for the optional `onDidChangeLanguageModelChatInformation` event.
     * Fired when the API mode setting changes so VS Code re-invokes
     * `provideLanguageModelChatInformation` and refreshes the model picker
     * without requiring a window reload.
     */
    private readonly _onDidChangeLanguageModelChatInformation = new vscode.EventEmitter<void>();

    /**
     * An optional event fired when the available set of language models changes.
     * Lets VS Code re-query the model list when `senseaudio.apiMode` changes,
     * so the picker only shows models supported by the selected protocol.
     */
    readonly onDidChangeLanguageModelChatInformation = this._onDidChangeLanguageModelChatInformation.event;

    /**
     * Notify VS Code that the model list may have changed (e.g. apiMode setting
     * was switched). VS Code re-invokes provideLanguageModelChatInformation.
     */
    notifyModelListChanged(): void {
        this._onDidChangeLanguageModelChatInformation.fire();
    }

    /**
     * Create a provider using the given secret storage for the API key.
     */
    constructor(
        private readonly secrets: vscode.SecretStorage,
        private readonly statusBarItem: vscode.StatusBarItem
    ) { }

    /**
     * Cache of undici Agents keyed by bodyTimeout, so connection pools are
     * reused across requests instead of being rebuilt (and losing keep-alive
     * connections) on every chat request.
     */
    private _undiciAgents = new Map<number, { agent: unknown; fetch: typeof fetch }>();

    /**
     * Create an undici fetch function with custom bodyTimeout to prevent premature
     * connection termination during long streaming responses.
     * Falls back to global fetch if undici is unavailable.
     */
    private _createFetchWithTimeout(requestTimeoutMs: number): typeof fetch {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const undici = require(path.join(vscode.env.appRoot, 'node_modules', 'undici'));
            const cached = this._undiciAgents.get(requestTimeoutMs);
            if (cached) {
                return cached.fetch;
            }
            const agent = new undici.Agent({ bodyTimeout: requestTimeoutMs });
            const fetchFn: typeof fetch = (url: RequestInfo | URL, init?: RequestInit) => {
                return undici.fetch(url, { ...init, dispatcher: agent });
            };
            this._undiciAgents.set(requestTimeoutMs, { agent, fetch: fetchFn });
            return fetchFn;
        } catch {
            return fetch;
        }
    }

    /**
     * Get the list of available language models contributed by this provider.
     */
    async provideLanguageModelChatInformation(
        options: PrepareLanguageModelChatModelOptions,
        _token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        return prepareLanguageModelChatInformation(options, _token, this.secrets);
    }

    /**
     * Returns the number of tokens for a given text using the model specific tokenizer logic.
     */
    async provideTokenCount(
        _model: LanguageModelChatInformation,
        text: string | LanguageModelChatRequestMessage,
        _token: CancellationToken
    ): Promise<number> {
        return countMessageTokens(text, { includeReasoningInRequest: true });
    }

    /**
     * Returns the response for a chat request, passing the results to the progress callback.
     */
    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: readonly LanguageModelChatRequestMessage[],
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        let usageReportedDuringStream = false;
        const collectedOutputText: string[] = [];
        const trackingProgress: Progress<LanguageModelResponsePart> = {
            report: (part) => {
                try {
                    if (part instanceof vscode.LanguageModelTextPart) {
                        collectedOutputText.push(part.value);
                    }
                    progress.report(part);
                } catch (e) {
                    console.error("[SenseAudio] Progress.report failed", {
                        modelId: model.id,
                        error: e instanceof Error ? { name: e.name, message: e.message } : String(e),
                    });
                }
            },
        };
        const requestStartTime = Date.now();

        // Timeout controller (declared outside try so accessible in catch/finally)
        let abortController = new AbortController();
        let requestTimeoutMs = 600000;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        let dispatchFetch: typeof fetch;

        try {
            // Get built-in model config (with fallback to auto-discovered config)
            const config = vscode.workspace.getConfiguration();
            let um: SenseAudioModelItem | undefined = getBuiltInModelConfig(model.id);
            if (!um) {
                um = getAutoDiscoveredModelConfig(model.id);
            }

            // Apply reasoning effort / temperature from user settings
            if (um) {
                applyReasoningEffort(um, options);
                applyTemperature(um, config);
            }

            // Determine API mode (user setting overrides model config)
            const apiMode = resolveApiMode(model.id, config);
            const baseUrl = um?.baseUrl || "https://api.senseaudio.cn/v1/";

            logger.info("request.start", {
                modelId: model.id,
                messageCount: messages.length,
                apiMode,
                baseUrl,
            });

            // Prepare model configuration
            const modelConfig = {
                includeReasoningInRequest: um?.include_reasoning_in_request ?? true,
                vision: um?.vision ?? false,
            };

            // Read Advanced Token indicator setting (default off — the native
            // Copilot indicator is always reported; this only controls the
            // extension's own status-bar counter)
            const enableThirdPartyIndicator = config.get<boolean>("senseaudio.enableThirdPartyTokenIndicator", false);

            // Calculate client-side token estimate for fallback (also updates Advanced Token indicator if enabled)
            // Show the status bar — this request is using one of this extension's models.
            // (It stays hidden on startup and while other chat model providers are in use.)
            showTokenStatusBar(this.statusBarItem);

            const estimatedInputTokens = await updateContextStatusBar(messages, options.tools, model, this.statusBarItem, modelConfig);

            // Apply delay between consecutive requests
            const modelDelay = um?.delay;
            const globalDelay = config.get<number>("senseaudio.delay", 0);
            const delayMs = modelDelay !== undefined ? modelDelay : globalDelay;

            if (delayMs > 0 && this._lastRequestTime !== null) {
                const elapsed = Date.now() - this._lastRequestTime;
                if (elapsed < delayMs) {
                    const remainingDelay = delayMs - elapsed;
                    logger.debug("request.delay", { delayMs, elapsed, remainingDelay });
                    await new Promise<void>((resolve) => {
                        const timeout = setTimeout(() => {
                            clearTimeout(timeout);
                            resolve();
                        }, remainingDelay);
                    });
                }
            }

            // Send chat request
            const BASE_URL = baseUrl;
            if (!BASE_URL || !BASE_URL.startsWith("http")) {
                throw new Error(l10n("Invalid base URL configuration."));
            }

            // Get retry config
            const retryConfig = createRetryConfig();

            // Create request timeout abort controller (default: 10 minutes)
            requestTimeoutMs = config.get<number>("senseaudio.requestTimeout", 600000);
            abortController = new AbortController();
            timeoutId = setTimeout(() => abortController.abort(), requestTimeoutMs);
            // Connect VS Code cancellation token to abort the fetch immediately when user stops
            if (token.onCancellationRequested) {
                token.onCancellationRequested(() => {
                    if (!abortController.signal.aborted) {
                        abortController.abort();
                    }
                });
            }
            // Create undici fetch with custom bodyTimeout (extends TCP idle timeout during streaming)
            dispatchFetch = this._createFetchWithTimeout(requestTimeoutMs);

            // ── Multi-API-Key rotation loop ─────────────────────────────────────
            await runKeyRotationLoop({
                secrets: this.secrets,
                token,
                abortController,
                apiMode,
                customHeaders: um?.headers,
                onFallbackSwitch: (entry) => {
                    vscode.window.showInformationMessage(
                        l10nFormat(
                            "Current API key is out of balance, switched to {0} and set it as the current key",
                            maskApiKey(entry.value)
                        )
                    );
                },
                execute: async (apiKey, requestHeaders) => {
                    logger.debug("request.messages.origin", { messages });
                    await executeApiRequest({
                        apiMode,
                        model,
                        um,
                        modelConfig,
                        messages,
                        options,
                        trackingProgress,
                        token,
                        apiKey,
                        baseUrl: BASE_URL,
                        requestHeaders,
                        retryConfig,
                        abortController,
                        dispatchFetch,
                        timeoutId,
                        collectedOutputText,
                        onUsage: (usage) => {
                            usageReportedDuringStream = true;
                            // Always report to native Copilot indicator (use original progress, not trackingProgress wrapper)
                            reportNativeUsage(usage, progress);
                            // Conditionally update Advanced Token indicator
                            if (enableThirdPartyIndicator) {
                                recordUsage(usage);
                                updateCumulativeTooltip(this.statusBarItem);
                                updateStatusBarWithApiPrompt(usage.promptTokens, model.maxInputTokens || 128000, this.statusBarItem);
                            }
                        },
                    });
                },
            });

            // Fallback: if API did not return usage data, use client-side calculation for native indicator
            if (!usageReportedDuringStream) {
                const outputText = collectedOutputText.join("");
                const estimatedOutputTokens = outputText ? await textTokenLength(outputText) : 0;
                const fallbackUsage: StreamUsage = {
                    promptTokens: estimatedInputTokens,
                    completionTokens: estimatedOutputTokens,
                };
                reportNativeUsage(fallbackUsage, progress);
                if (enableThirdPartyIndicator) {
                    recordUsage(fallbackUsage);
                    updateCumulativeTooltip(this.statusBarItem);
                }
            }
        } catch (err) {
            // Determine if the request was aborted/terminated (friendly message instead of raw error)
            const errMessage = err instanceof Error ? err.message : String(err);
            // Distinguish user cancellation from timeout: the AbortController is aborted
            // by BOTH the timeout timer AND the user cancellation listener; check the
            // VS Code cancellation token to tell them apart.
            const isUserCancelled = token.isCancellationRequested;
            const isTimeout = abortController.signal.aborted && !isUserCancelled;
            const isForceTerminated =
                !isTimeout &&
                !isUserCancelled &&
                (errMessage.includes("terminated") ||
                 errMessage.includes("aborted") ||
                 (err instanceof Error && err.name === "AbortError"));

            // If user cancelled, just re-throw the original error without wrapping
            if (isUserCancelled) {
                throw err;
            }

            if (isTimeout || isForceTerminated) {
                logger.error("request.timeout", {
                    modelId: model.id,
                    timeoutMs: requestTimeoutMs,
                    durationMs: Date.now() - requestStartTime,
                    reason: isForceTerminated ? "connection_terminated" : "timeout",
                });
                if (isForceTerminated) {
                    throw new Error(l10n("The connection was closed by the server. The generation took too long. Please try again or request shorter content."));
                }
                throw new Error(l10n("Request timed out. The generation took too long. You can increase the timeout in settings (senseaudio.requestTimeout)."));
            }

            // Detect image content moderation rejection from the API
            if (errMessage.includes("IMAGE_SENSITIVE:")) {
                logger.error("request.error", {
                    modelId: model.id,
                    error: "image_sensitive",
                    errorMessage: errMessage,
                });
                throw new Error(l10n("The image you sent was flagged as sensitive by the content moderation system. Please try a different image."));
            }

            console.error("[SenseAudio] Chat request failed", {
                modelId: model.id,
                messageCount: messages.length,
                error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
            });
            logger.error("request.error", {
                modelId: model.id,
                messageCount: messages.length,
                errorName: err instanceof Error ? err.name : String(err),
                errorMessage: err instanceof Error ? err.message : String(err),
            });
            throw err;
        } finally {
            clearTimeout(timeoutId);
            const durationMs = Date.now() - requestStartTime;
            logger.info("request.end", { modelId: model.id, durationMs });
            this._lastRequestTime = Date.now();

            // Auto-hide the status bar after inactivity — it only reflects SenseAudio
            // model usage, so hide it once the user stops using these models.
            scheduleStatusBarHide(this.statusBarItem);
        }
    }
}
