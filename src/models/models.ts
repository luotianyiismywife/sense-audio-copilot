import * as vscode from "vscode";
import type { LanguageModelChatInformation } from "vscode";
import type { SenseAudioModelItem } from "../core/types";
import { l10n } from "../core/localize";

/**
 * Built-in model definition for SenseAudio.
 */
interface BuiltInModelDef {
    /** Base model ID sent to the API (e.g., "glm-5.3-flash") */
    baseId: string;
    /** User-friendly display name (e.g., "GLM-5.3-Flash") */
    displayName: string;
    /** Whether the model supports image input */
    vision: boolean;
    /** Thinking mode: "switchable" = user can toggle, "always" = thinking forced on, "adaptive" = only disabled/adaptive */
    thinkingMode: "switchable" | "always" | "adaptive";
    /** Default reasoning effort when thinking is enabled */
    defaultReasoningEffort?: string;
    /** Supported reasoning effort levels for the model picker UI */
    supportedReasoningEfforts?: string[];
    /** Whether to include reasoning_content in assistant messages */
    includeReasoningInRequest?: boolean;
    /** Whether the model supports setting temperature/top_p. Default true. */
    supportsTemperature?: boolean;
    /** Optional fixed top_p value the model accepts (e.g. a model that only allows 0.95). */
    fixedTopP?: number;
    /** Default context length */
    contextLength?: number;
    /** Default max output tokens */
    maxTokens?: number;
    /** Extra body parameters to include in API requests */
    extra?: Record<string, unknown>;
    /** API mode: "openai" (default) or "anthropic" */
    apiMode?: "openai" | "anthropic" | "responses";
}

const EXTENSION_LABEL = "SenseAudio";
const DEFAULT_CONTEXT_LENGTH = 128000;
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Default ratio of the real context window to declare as `maxInputTokens`.
 * Overridable via the `senseaudio.maxInputTokensRatio` setting.
 *
 * VS Code triggers agent auto-compaction (chat.summarizeAgentConversationHistory.enabled)
 * at ~90% of the declared maxInputTokens. Declaring the full context length
 * (e.g. 1M tokens) means compaction would only fire at 900K tokens — effectively
 * never for typical conversations. A lower ratio (e.g. 0.8) makes compaction
 * fire at ~72% of the real window, leaving headroom.
 */
const DEFAULT_MAX_INPUT_TOKENS_RATIO = 1.0;
/** Lower bound for maxInputTokensRatio — prevents declaring a tiny context that
 * triggers compaction far too early. */
const MIN_MAX_INPUT_TOKENS_RATIO = 0.1;
/** Upper bound — 1.0 means declaring the full context window. */
const MAX_MAX_INPUT_TOKENS_RATIO = 1.0;

/**
 * Read the configurable maxInputTokens ratio from the `senseaudio.maxInputTokensRatio`
 * setting and clamp it into the valid range [0.1, 1.0]. Falls back to the default
 * (1.0) when the setting is missing or invalid.
 */
export function getMaxInputTokensRatio(): number {
    const configured = vscode.workspace.getConfiguration("senseaudio").get<number>("maxInputTokensRatio", DEFAULT_MAX_INPUT_TOKENS_RATIO);
    if (typeof configured !== "number" || !Number.isFinite(configured)) {
        return DEFAULT_MAX_INPUT_TOKENS_RATIO;
    }
    return Math.min(MAX_MAX_INPUT_TOKENS_RATIO, Math.max(MIN_MAX_INPUT_TOKENS_RATIO, configured));
}

/**
 * Built-in model definitions.
 *
 * Model list verified against the live `/v1/models` endpoint on 2026-09-29
 * (9 llm models) and the official model page:
 * https://docs.senseaudio.cn/guides/account/model-list
 *
 * IMPORTANT: `/v1/models` returns NO spec fields — only
 * `id / display_name / mode / protocols / desc / created / owned_by`.
 * It does NOT return `context_length`, `max_completion_tokens` or any
 * `supports_*` capability flag. All specs below therefore come from the
 * official docs table (context / max output) and models.dev + OpenRouter
 * (vision capability, cross-checked and in agreement).
 *
 * The previous list (kimi-k2.5/k2.6/k2.7-code, glm-5/5.1/5.2/5.3,
 * deepseek-v4-pro/flash, mimo-v2.5-pro, minimax-m2.5/m2.7, qwen3.7-max,
 * qwen3.8-max) is entirely retired by the platform — those IDs now 404.
 *
 * Image-generation models (senseaudio-image-2.0, doubao-seedream-5-0, …) are
 * excluded — they cannot be used for chat.
 */
const BUILT_IN_MODELS: BuiltInModelDef[] = [
    // ── SenseAudio 自研系列 ──
    // S2: 1M context / 128K output. desc mentions 深度推理与复杂工具调用 (no vision).
    { baseId: "senseaudio-s2", displayName: "SenseAudio-S2", vision: false, thinkingMode: "switchable", contextLength: 1000000, maxTokens: 131072 },
    // S2-Flash / S2-Lite: 256K context / 64K output.
    { baseId: "senseaudio-s2-flash", displayName: "SenseAudio-S2-Flash", vision: false, thinkingMode: "switchable", contextLength: 262144, maxTokens: 65536 },
    { baseId: "senseaudio-s2-lite", displayName: "SenseAudio-S2-Lite", vision: false, thinkingMode: "switchable", contextLength: 262144, maxTokens: 65536 },

    // ── SenseNova 系列 ──
    // The official docs table lists "—" for every spec of this model, and it is
    // absent from models.dev / OpenRouter. 256K / 64K is assumed (same class as
    // the S2-Flash/Lite entries); revisit if the platform publishes real values.
    { baseId: "sensenova-6.8-flash-lite", displayName: "SenseNova-6.8-Flash-Lite", vision: false, thinkingMode: "switchable", contextLength: 262144, maxTokens: 65536 },

    // ── 其他厂商模型 ──
    // Qwen3.8-27B: 256K context. Vision confirmed (models.dev attachment=true,
    // OpenRouter input_modalities=[text,image,video]).
    { baseId: "qwen3.8-27b", displayName: "Qwen3.8-27B", vision: true, thinkingMode: "switchable", contextLength: 262144, maxTokens: 32768 },
    // Qwen3.6-35B-A3B: 256K context / 64K output. Vision confirmed by BOTH the
    // API desc ("面向复杂多模态任务的视觉语言旗舰模型") and models.dev/OpenRouter.
    { baseId: "qwen3.6-35b-a3b", displayName: "Qwen3.6-35B-A3B", vision: true, thinkingMode: "switchable", contextLength: 262144, maxTokens: 65536 },
    // DeepSeek-V4.1-Flash: 1M context. Vision confirmed (models.dev attachment=true,
    // OpenRouter input_modalities=[text,image]).
    { baseId: "deepseek-v4.1-flash", displayName: "DeepSeek-V4.1-Flash", vision: true, thinkingMode: "switchable", contextLength: 1000000, maxTokens: 384000 },
    // DeepSeek-V4-Flash-0731: 1M context / 384K output. Text-only
    // (models.dev attachment=false, OpenRouter input_modalities=[text]).
    { baseId: "deepseek-v4-flash-0731", displayName: "DeepSeek-V4-Flash-0731", vision: false, thinkingMode: "switchable", contextLength: 1000000, maxTokens: 393216 },
    // GLM-5.3-Flash: 1M context / 128K output. Vision confirmed
    // (models.dev attachment=true, OpenRouter input_modalities=[text,image,video]).
    { baseId: "glm-5.3-flash", displayName: "GLM-5.3-Flash", vision: true, thinkingMode: "switchable", contextLength: 1000000, maxTokens: 131072 },
];

/**
 * Get the set of built-in model base IDs.
 * Used by the startup model sync (src/modelSync.ts) to detect new models
 * returned by the API that are not yet in the built-in list.
 */
export function getBuiltInModelIds(): Set<string> {
    return new Set(BUILT_IN_MODELS.map((m) => m.baseId));
}

/**
 * Get the built-in model list as LanguageModelChatInformation[].
 * Each model registers one entry with a configurationSchema for reasoning effort selection.
 * - switchable models: include "禁用思考" option so user can turn off thinking
 * - always models: no "禁用思考" option, thinking always on
 * All labels and descriptions use l10n() for i18n.
 */
export function getBuiltInModelInfos(): LanguageModelChatInformation[] {
    const infos: LanguageModelChatInformation[] = [];

    for (const def of BUILT_IN_MODELS) {
        // Declare maxInputTokens as a configurable ratio (default 80%) of the real
        // context window so VS Code's agent auto-compaction (~90% of maxInputTokens)
        // fires before the context actually fills up.
        const maxInput = Math.floor((def.contextLength ?? DEFAULT_CONTEXT_LENGTH) * getMaxInputTokensRatio());

        const info: LanguageModelChatInformation = {
            id: def.baseId,
            name: def.displayName,
            detail: `SenseAudio`,
            tooltip: `SenseAudio`,
            family: EXTENSION_LABEL,
            version: "1.0.0",
            maxInputTokens: maxInput,
            maxOutputTokens: def.maxTokens ?? DEFAULT_MAX_TOKENS,
            isUserSelectable: true,
            capabilities: {
                toolCalling: true,
                // Always declare imageInput=true so VS Code passes image data through.
                // Non-vision models handle images via the ask_image tool proxy internally.
                imageInput: true,
            },
        };

        // Build enum values based on thinking mode
        // - "switchable" + hasEfforts: disabled / [effort levels]             (e.g. disabled/high/max)
        // - "switchable" + no efforts: disabled / enabled
        // - "adaptive"               : disabled / adaptive                    (only two: off or auto-decide)
        // - "always"    + hasEfforts: [effort levels]
        // - "always"    + no efforts: enabled
        const hasEfforts = def.supportedReasoningEfforts && def.supportedReasoningEfforts.length > 0;
        let enumValues: string[];
        if (hasEfforts) {
            if (def.thinkingMode === "switchable") {
                enumValues = ["disabled", ...def.supportedReasoningEfforts!];
            } else {
                enumValues = [...def.supportedReasoningEfforts!];
            }
        } else {
            if (def.thinkingMode === "switchable") {
                enumValues = ["disabled", "enabled"];
            } else if (def.thinkingMode === "adaptive") {
                enumValues = ["disabled", "adaptive"];
            } else {
                enumValues = ["enabled"];
            }
        }

        // Map effort values to localized labels and descriptions
        // Keys are English strings that serve as fallback for non-Chinese locales
        const getLabel = (e: string): string => {
            switch (e) {
                case 'disabled': return l10n("Disabled");
                case 'adaptive': return l10n("Adaptive");
                case 'enabled': return l10n("Thinking");
                case 'low': return l10n("Low");
                case 'medium': return l10n("Medium");
                case 'high': return l10n("High");
                case 'max': return l10n("Maximum");
                default: return e.charAt(0).toUpperCase() + e.slice(1);
            }
        };
        const getDesc = (e: string): string => {
            switch (e) {
                case 'disabled': return l10n("Do not enable thinking");
                case 'adaptive': return l10n("Automatically decide when to think");
                case 'enabled': return l10n("Enable thinking");
                case 'low': return l10n("Reduce thinking, faster response");
                case 'medium': return l10n("Balance thinking and speed");
                case 'high': return l10n("Deeper thinking, slower response");
                case 'max': return l10n("Maximum thinking depth, slowest response");
                default: return e;
            }
        };

        const enumItemLabels = enumValues.map(getLabel);
        const enumDescriptions = enumValues.map(getDesc);

        // Determine default: for switchable with efforts, use defaultReasoningEffort or last item;
        // for others, use the last enum value (enabled/highest effort)
        const defaultEffort = (hasEfforts && def.defaultReasoningEffort)
            ? def.defaultReasoningEffort
            : enumValues[enumValues.length - 1];

        infos.push({
            ...info,
            configurationSchema: {
                properties: {
                    reasoningEffort: {
                        type: 'string',
                        title: l10n("Reasoning Effort"),
                        enum: enumValues,
                        enumItemLabels: enumItemLabels,
                        enumDescriptions: enumDescriptions,
                        default: defaultEffort,
                        group: 'navigation',
                    },
                },
            },
        } satisfies LanguageModelChatInformation);
    }

    return infos;
}

/**
 * Find a built-in model definition by model ID.
 * Returns the model properties including thinking mode, API mode, and extra parameters.
 * Thinking state (enable_thinking) is initially set to true and will be adjusted
 * by provider.ts based on the user's reasoning effort selection.
 */
export function getBuiltInModelConfig(modelId: string): SenseAudioModelItem | undefined {
    const def = BUILT_IN_MODELS.find((m) => m.baseId === modelId);
    if (!def) {
        return undefined;
    }

    const model: SenseAudioModelItem = {
        id: def.baseId,
        owned_by: "senseaudio",
        displayName: def.displayName,
        vision: def.vision,
        supportsTemperature: def.supportsTemperature ?? true,
        fixedTopP: def.fixedTopP,
        context_length: def.contextLength ?? DEFAULT_CONTEXT_LENGTH,
        max_completion_tokens: def.maxTokens ?? DEFAULT_MAX_TOKENS,
        apiMode: def.apiMode ?? "openai",
        enable_thinking: true,
        include_reasoning_in_request: true,
        thinkingMode: def.thinkingMode,
    };

    // Set default reasoning effort if configured
    if (def.defaultReasoningEffort) {
        model.reasoning_effort = def.defaultReasoningEffort;
    }

    // Pass through extra body parameters
    if (def.extra) {
        model.extra = { ...def.extra };
    }

    return model;
}
