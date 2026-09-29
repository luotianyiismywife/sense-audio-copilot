import * as vscode from "vscode";
import type { ProvideLanguageModelChatResponseOptions } from "vscode";
import type { ModelPreset, SenseAudioModelItem } from "../core/types";
import { getAnthropicModelIds, getResponsesModelIds } from "../models/provideModel";
import { getRequestedReasoningEffort } from "./errors";

/**
 * 请求参数解析：把 VS Code 的请求选项 + 用户设置合并进模型配置。
 *
 * 从 `provider.ts` 抽出，避免 Provider 类承担参数决策逻辑。
 */

/**
 * 应用推理强度（thinking 模式）到模型配置。
 * - `"disabled"` → 关闭思考（`thinkingMode="always"` 的模型除外）
 * - `"enabled"` → 开启思考，使用模型默认力度
 * - `"adaptive"` / `"high"` / `"max"` 等 → 开启思考并指定力度
 */
export function applyReasoningEffort(
    um: SenseAudioModelItem,
    options: ProvideLanguageModelChatResponseOptions
): void {
    const effort = getRequestedReasoningEffort(options);
    if (!effort) {
        return;
    }
    if (effort === "disabled") {
        if (um.thinkingMode !== "always") {
            um.enable_thinking = false;
            um.include_reasoning_in_request = false;
            um.reasoning_effort = undefined;
        }
    } else {
        um.enable_thinking = true;
        um.include_reasoning_in_request = true;
        if (effort !== "enabled") {
            um.reasoning_effort = effort;
        }
    }
}

/**
 * 注入 temperature / top_p（模型预设或自定义设置）。
 * 模型声明 `supportsTemperature === false` 时清空两者；
 * 模型声明 `fixedTopP`（如某模型仅接受 0.95）时覆盖用户/预设配置。
 */
export function applyTemperature(
    um: SenseAudioModelItem,
    config: vscode.WorkspaceConfiguration
): void {
    if (um.supportsTemperature === false) {
        // Model does not support temperature; ensure it's not sent
        um.temperature = undefined;
        um.top_p = undefined;
        return;
    }

    const tempPreset = config.get<string>("senseaudio.modelPreset", "custom");
    const presets = config.get<ModelPreset[]>("senseaudio.modelPresets", []);
    const matchedPreset = tempPreset !== "custom" ? presets.find((p) => p.id === tempPreset) : undefined;

    if (matchedPreset) {
        um.temperature = matchedPreset.temperature;
        // A preset may pin top_p; otherwise fall back to the configured value
        // (default 0.5) so preset mode and custom mode behave consistently.
        um.top_p = matchedPreset.top_p ?? config.get<number | null>("senseaudio.top_p", null) ?? undefined;
    } else {
        const userTemperature = config.get<number | null>("senseaudio.temperature", null);
        if (userTemperature !== null) {
            um.temperature = userTemperature;
        }
        const userTopP = config.get<number | null>("senseaudio.top_p", null);
        um.top_p = userTopP ?? undefined;
    }
    // Model-specific top_p whitelist (e.g. a model that only accepts 0.95):
    // override whatever the user/preset configured.
    if (um.fixedTopP !== undefined) {
        um.top_p = um.fixedTopP;
    }
}

/**
 * 确定本次请求使用的 API 协议。
 *
 * `senseaudio.apiMode` 用户设置优先（`openai`/`anthropic`/`responses` 强制）；
 * `auto` 时按能力动态探测（启动时从 `/v1/models` 缓存，不硬编码模型 ID）：
 *   1. `enableResponsesApi`（默认关闭）+ 模型 supports_responses=true → responses
 *   2. `enableAnthropicApi`（默认关闭）+ 模型 supports_anthropic=true → anthropic
 *   3. 否则 → openai
 */
export function resolveApiMode(
    modelId: string,
    config: vscode.WorkspaceConfiguration
): "openai" | "anthropic" | "responses" {
    const apiModeSetting = config.get<string>("senseaudio.apiMode", "auto");
    if (apiModeSetting === "openai" || apiModeSetting === "anthropic" || apiModeSetting === "responses") {
        return apiModeSetting;
    }
    const enableResponsesApi = config.get<boolean>("senseaudio.enableResponsesApi", false);
    const enableAnthropicApi = config.get<boolean>("senseaudio.enableAnthropicApi", false);
    if (enableResponsesApi && getResponsesModelIds().has(modelId)) {
        return "responses";
    }
    if (enableAnthropicApi && getAnthropicModelIds().has(modelId)) {
        return "anthropic";
    }
    return "openai";
}
