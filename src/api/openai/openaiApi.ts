import * as vscode from "vscode";
import {
    CancellationToken,
    LanguageModelChatRequestMessage,
    LanguageModelResponsePart,
    ProvideLanguageModelChatResponseOptions,
    Progress,
} from "vscode";

import type { SenseAudioModelItem } from "../../core/types";

import type {
    OpenAIChatMessage,
    OpenAIToolCall,
    ChatMessageContent,
    ReasoningDetail,
    ReasoningSummaryDetail,
    ReasoningTextDetail,
} from "./openaiTypes";

import {
    isImageMimeType,
    createDataUrl,
    isToolResultPart,
    convertToolsToOpenAI,
    mapRole,
    replaceDataUriImages,
    parseToolCallArguments,
} from "../../core/utils";

import { CommonApi, StreamUsage } from "../commonApi";
import { iterateSseEvents } from "../sse";
import {
    ASK_IMAGE_TOOL_DEF,
    ASK_WITH_MULTI_IMAGE_TOOL_DEF,
    buildUserImageReference,
    buildToolImageReference,
} from "../../vision/types";
import { parseVisionToolHistoryPart } from "../../vision/historyPart";
import { toOpenAIVisionToolMessages, type VisionToolHistoryEntry } from "../../vision/historyCodec";
import { postJson } from "../httpClient";

export class OpenaiApi extends CommonApi<OpenAIChatMessage, Record<string, unknown>> {
    constructor(modelId: string) {
        super(modelId);
    }

    /**
     * Convert VS Code chat request messages into OpenAI-compatible message objects.
     * For non-vision models, images are replaced with text references and stored
     * in instance-local _localImages for the ask_image tool.
     */
    convertMessages(
        messages: readonly LanguageModelChatRequestMessage[],
        modelConfig: { includeReasoningInRequest: boolean; vision?: boolean }
    ): OpenAIChatMessage[] {
        const modelSupportsVision = modelConfig.vision !== false;
        const out: OpenAIChatMessage[] = [];
        let imageIndex = 0;

        // Collect images to instance-local array if model doesn't support vision
        if (!modelSupportsVision) {
            this.collectLocalImages(messages);
        }

        for (const m of messages) {
            const role = mapRole(m);
            const textParts: string[] = [];
            const imageParts: vscode.LanguageModelDataPart[] = [];
            const toolCalls: OpenAIToolCall[] = [];
            const toolResults: { callId: string; content: string }[] = [];
            const reasoningParts: string[] = [];
            const visionToolHistory: VisionToolHistoryEntry[] = [];

            for (const part of m.content ?? []) {
                const historyEntry = parseVisionToolHistoryPart(part);
                if (historyEntry) {
                    visionToolHistory.push(historyEntry);
                } else if (part instanceof vscode.LanguageModelTextPart) {
                    if (modelSupportsVision) {
                        textParts.push(part.value);
                    } else {
                        // Replace data URI images with references, and track imageIndex
                        const result = replaceDataUriImages(part.value, imageIndex);
                        imageIndex += result.count;
                        textParts.push(result.text);
                    }
                } else if (part instanceof vscode.LanguageModelDataPart && isImageMimeType(part.mimeType)) {
                    if (modelSupportsVision) {
                        imageParts.push(part);
                    } else {
                        // For non-vision models, replace image with text reference
                        // Use strong directive language so the model knows it MUST use ask_image
                        textParts.push("\n" + buildUserImageReference(imageIndex));
                        imageIndex++;
                    }
                } else if (part instanceof vscode.LanguageModelToolCallPart) {
                    const id = part.callId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                    let args = "{}";
                    try {
                        args = JSON.stringify(part.input ?? {});
                    } catch {
                        args = "{}";
                    }
                    toolCalls.push({ id, type: "function", function: { name: part.name, arguments: args } });
                } else if (isToolResultPart(part)) {
                    const callId = (part as { callId?: string }).callId ?? "";
                    const toolContent = (part as { content?: ReadonlyArray<unknown> }).content;
                    const toolTexts: string[] = [];
                    if (toolContent) {
                        for (const inner of toolContent) {
                            if (inner instanceof vscode.LanguageModelTextPart) {
                                if (modelSupportsVision) {
                                    toolTexts.push(inner.value);
                                } else {
                                    const result = replaceDataUriImages(inner.value, imageIndex);
                                    imageIndex += result.count;
                                    toolTexts.push(result.text);
                                }
                            } else if (!modelSupportsVision && inner instanceof vscode.LanguageModelDataPart && isImageMimeType(inner.mimeType)) {
                                toolTexts.push("\n" + buildToolImageReference(imageIndex));
                                imageIndex++;
                            }
                        }
                    }
                    const content = toolTexts.join("\n").trim();
                    toolResults.push({ callId, content });
                } else if (part instanceof vscode.LanguageModelThinkingPart) {
                    const content = Array.isArray(part.value) ? part.value.join("") : part.value;
                    reasoningParts.push(content);
                }
            }

            const joinedText = textParts.join("").trim();
            const joinedThinking = reasoningParts.join("").trim();

            // Persisted ask_image calls are restored as ordinary API messages.
            // Put them before this message's normal content so that a DataPart
            // appended after the previous assistant text still forms the valid
            // sequence: assistant tool_call → tool result → assistant text.
            for (const entry of visionToolHistory) {
                out.push(...toOpenAIVisionToolMessages(entry));
            }

            // process assistant message
            if (role === "assistant") {
                const assistantMessage: OpenAIChatMessage = {
                    role: "assistant",
                };

                if (joinedText) {
                    assistantMessage.content = joinedText;
                }

                // Always set reasoning_content when includeReasoningInRequest is true.
                // DeepSeek thinking mode requires the reasoning_content field to be
                // present on EVERY assistant message for round-tripping — even an
                // empty string satisfies the requirement. VS Code does NOT re-send
                // LanguageModelThinkingPart in history messages, so reasoningParts is
                // usually empty on later turns of a conversation; without the field,
                // DeepSeek rejects the request with 400 ("reasoning_content ... must
                // be passed back to the API"). Thinking is off only when the user
                // disabled it (includeReasoningInRequest=false), so unconditional
                // emission here is safe.
                if (modelConfig.includeReasoningInRequest) {
                    assistantMessage.reasoning_content = joinedThinking;
                }

                if (toolCalls.length > 0) {
                    assistantMessage.tool_calls = toolCalls;
                }

                // Must have content or tool_calls — reasoning_content alone is rejected
                // by providers that require content/tool_calls to be set (e.g. DeepSeek).
                if (assistantMessage.content || assistantMessage.tool_calls) {
                    out.push(assistantMessage);
                }
            }

            // process tool result messages
            for (const tr of toolResults) {
                out.push({ role: "tool", tool_call_id: tr.callId, content: tr.content || "" });
            }

            // process user messages
            if (role === "user") {
                if (imageParts.length > 0) {
                    // multi-modal message
                    const contentArray: ChatMessageContent[] = [];

                    if (joinedText) {
                        contentArray.push({
                            type: "text",
                            text: joinedText,
                        });
                    }

                    for (const imagePart of imageParts) {
                        const dataUrl = createDataUrl(imagePart);
                        contentArray.push({
                            type: "image_url",
                            image_url: {
                                url: dataUrl,
                            },
                        });
                    }
                    out.push({ role, content: contentArray });
                } else {
                    // text-only message
                    if (joinedText) {
                        out.push({ role, content: joinedText });
                    }
                }
            }

            // process system messages
            if (role === "system" && joinedText) {
                out.push({ role, content: joinedText });
            }
        }
        this._originalApiMessages = out;
        return out;
    }

    prepareRequestBody(
        rb: Record<string, unknown>,
        um: SenseAudioModelItem | undefined,
        options?: ProvideLanguageModelChatResponseOptions
    ): Record<string, unknown> {
        // temperature / top_p
        this.applyTemperature(rb, um);

        // max_tokens / max_completion_tokens (mutually exclusive)
        if (um?.max_completion_tokens !== undefined) {
            rb.max_completion_tokens = um.max_completion_tokens;
        } else if (um?.max_tokens !== undefined) {
            rb.max_tokens = um.max_tokens;
        }

        // OpenAI reasoning configuration (only set when thinking is enabled)
        // Skip reasoning_effort for "adaptive" — it's not a standard API value
        if (um?.enable_thinking !== false && um?.reasoning_effort !== undefined && um.reasoning_effort !== 'adaptive') {
            rb.reasoning_effort = um.reasoning_effort;
        }

        // Thinking mode (OpenAI-compatible format: {"thinking": {"type": "enabled"}})
        // SenseAudio accepts only string values: "enabled" / "disabled" / "auto".
        // "adaptive" is rejected by the OpenAI endpoint — use "auto" instead.
        if (um?.enable_thinking === true) {
            if (um?.reasoning_effort === 'adaptive') {
                rb.thinking = { type: "auto" };
            } else {
                rb.thinking = { type: "enabled" };
                if (um?.thinking_budget !== undefined) {
                    (rb.thinking as Record<string, unknown>).budget_tokens = um.thinking_budget;
                }
            }
        } else {
            rb.thinking = { type: "disabled" };
        }

        // OpenRouter/SenseAudio reasoning configuration
        if (um?.reasoning !== undefined && um.reasoning.enabled !== false) {
            const reasoningObj: Record<string, unknown> = {};
            const effort = um.reasoning.effort;
            if (effort && effort !== "auto") {
                reasoningObj.effort = effort;
            } else {
                reasoningObj.max_tokens = um.reasoning.max_tokens || 2000;
            }
            if (um.reasoning.exclude !== undefined) {
                reasoningObj.exclude = um.reasoning.exclude;
            }
            rb.reasoning = reasoningObj;
        }

        // stop
        if (options?.modelOptions) {
            const mo = options.modelOptions as Record<string, unknown>;
            if (typeof mo.stop === "string" || Array.isArray(mo.stop)) {
                rb.stop = mo.stop;
            }
        }

        // tools
        const toolConfig = convertToolsToOpenAI(options);
        const toolsList: unknown[] = [];
        if (toolConfig.tools) {
            toolsList.push(...toolConfig.tools);
        }
        // Inject ask_image + ask_with_multi_image for non-vision models with stored images
        if (this._hasImages) {
            toolsList.push(ASK_IMAGE_TOOL_DEF);
            if (this._localImages.length >= 2) {
                toolsList.push(ASK_WITH_MULTI_IMAGE_TOOL_DEF);
            }
        }
        if (toolsList.length > 0) {
            rb.tools = toolsList;
        }
        if (this._hasImages) {
            // Set to "auto" so the model can freely choose to call ask_image.
            // Some providers (DeepSeek) reject forced function tool_choice.
            // The converted messages already contain strong directives telling the
            // model it MUST use ask_image, and the tool definition is available.
            rb.tool_choice = "auto";
        } else if (toolConfig.tool_choice) {
            rb.tool_choice = toolConfig.tool_choice;
        }

        // Extra model parameters
        if (um?.top_k !== undefined) { rb.top_k = um.top_k; }
        if (um?.min_p !== undefined) { rb.min_p = um.min_p; }
        if (um?.frequency_penalty !== undefined) { rb.frequency_penalty = um.frequency_penalty; }
        if (um?.presence_penalty !== undefined) { rb.presence_penalty = um.presence_penalty; }
        if (um?.repetition_penalty !== undefined) { rb.repetition_penalty = um.repetition_penalty; }

        // Extra body parameters
        this.mergeExtraParams(rb, um);

        return rb;
    }

    /**
     * Read and parse the SSE streaming response and report parts.
     */
    async processStreamingResponse(
        responseBody: ReadableStream<Uint8Array>,
        progress: Progress<LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        await this.runSseStream(
            responseBody,
            progress,
            token,
            "openai",
            async (parsed) => {
                const chunk = parsed as Record<string, unknown>;
                this.captureUsage(chunk);
                await this.processDelta(chunk, progress);
            },
            { debugChunks: true }
        );
    }

    /**
     * Capture token usage from a stream chunk (stream_options: include_usage).
     * Supports both OpenAI (prompt_tokens_details.cached_tokens) and
     * DeepSeek (prompt_cache_hit_tokens / prompt_cache_miss_tokens) formats.
     */
    private captureUsage(parsed: Record<string, unknown>): void {
        const usageData = parsed.usage as Record<string, unknown> | undefined;
        if (!usageData) {
            return;
        }
        let cacheHitTokens: number | undefined;
        let cacheMissTokens: number | undefined;

        // OpenAI format: prompt_tokens_details.cached_tokens
        const details = usageData.prompt_tokens_details as Record<string, unknown> | undefined;
        if (details && typeof details.cached_tokens === "number") {
            cacheHitTokens = details.cached_tokens;
            cacheMissTokens = ((usageData.prompt_tokens as number) ?? 0) - cacheHitTokens;
        }

        // DeepSeek format: prompt_cache_hit_tokens / prompt_cache_miss_tokens (overrides OpenAI)
        if (typeof usageData.prompt_cache_hit_tokens === "number") {
            cacheHitTokens = usageData.prompt_cache_hit_tokens as number;
        }
        if (typeof usageData.prompt_cache_miss_tokens === "number") {
            cacheMissTokens = usageData.prompt_cache_miss_tokens as number;
        }

        const usage: StreamUsage = {
            promptTokens: (usageData.prompt_tokens as number) ?? 0,
            completionTokens: (usageData.completion_tokens as number) ?? 0,
            cacheHitTokens,
            cacheMissTokens,
        };
        this._onUsage?.(usage);
    }

    /**
     * Handle a single streamed delta chunk, emitting text and tool call parts.
     */
    private async processDelta(
        delta: Record<string, unknown>,
        progress: Progress<LanguageModelResponsePart>
    ): Promise<boolean> {
        let emitted = false;
        const choice = (delta.choices as Record<string, unknown>[] | undefined)?.[0];
        if (!choice) {
            return false;
        }

        const deltaObj = choice.delta as Record<string, unknown> | undefined;

        // Process thinking content first (before regular text content)
        try {
            let maybeThinking =
                (choice as Record<string, unknown> | undefined)?.thinking ??
                (deltaObj as Record<string, unknown> | undefined)?.thinking ??
                (deltaObj as Record<string, unknown> | undefined)?.reasoning ??
                (deltaObj as Record<string, unknown> | undefined)?.reasoning_content;

            // OpenRouter reasoning_details array handling
            const maybeReasoningDetails =
                (deltaObj as Record<string, unknown>)?.reasoning_details ??
                (choice as Record<string, unknown>)?.reasoning_details;
            if (maybeReasoningDetails && Array.isArray(maybeReasoningDetails) && maybeReasoningDetails.length > 0) {
                const details: Array<ReasoningDetail> = maybeReasoningDetails as Array<ReasoningDetail>;
                const sortedDetails = details.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

                for (const detail of sortedDetails) {
                    let extractedText = "";
                    if (detail.type === "reasoning.summary") {
                        extractedText = (detail as ReasoningSummaryDetail).summary;
                    } else if (detail.type === "reasoning.text") {
                        extractedText = (detail as ReasoningTextDetail).text;
                    } else if (detail.type === "reasoning.encrypted") {
                        extractedText = "[REDACTED]";
                    } else {
                        extractedText = JSON.stringify(detail);
                    }

                    if (extractedText) {
                        this.bufferThinkingContent(extractedText, progress);
                        emitted = true;
                    }
                }
                maybeThinking = null;
            }

            if (maybeThinking !== undefined && maybeThinking !== null) {
                let text = "";
                if (maybeThinking && typeof maybeThinking === "object") {
                    const mt = maybeThinking as Record<string, unknown>;
                    text = typeof mt["text"] === "string" ? (mt["text"] as string) : JSON.stringify(mt);
                } else if (typeof maybeThinking === "string") {
                    text = maybeThinking;
                }
                if (text) {
                    // Accumulate reasoning content for echo-back in tool call proxy rounds
                    // DeepSeek thinking mode requires raw reasoning_content to be passed back verbatim
                    this._capturedReasoningContent += text;
                    this.bufferThinkingContent(text, progress);
                    emitted = true;
                }
            }
        } catch (e) {
            console.error("[SenseAudio] Failed to process thinking/reasoning_details:", e);
        }

        if (deltaObj?.content) {
            const content = String(deltaObj.content);

            const xmlRes = this.processXmlThinkBlocks(content, progress);
            if (xmlRes.emittedAny) {
                emitted = true;
            } else {
                this.reportEndThinking(progress);
                const res = this.processTextContent(content, progress);
                if (res.emittedAny) {
                    this._hasEmittedAssistantText = true;
                    emitted = true;
                }
            }
        }

        if (deltaObj?.tool_calls) {
            this.reportEndThinking(progress);

            const toolCalls = deltaObj.tool_calls as Array<Record<string, unknown>>;

            if (!this._emittedBeginToolCallsHint && this._hasEmittedAssistantText && toolCalls.length > 0) {
                progress.report(new vscode.LanguageModelTextPart(" "));
                this._emittedBeginToolCallsHint = true;
            }

            for (const tc of toolCalls) {
                // Buffer key: prefer the tool call id (stable across chunks even
                // when the provider omits or repeats `index`), then index, then
                // the last seen key, then an auto sequence. Never default to 0 —
                // some OpenAI-compatible providers (e.g. GLM) emit parallel tool
                // calls all with index 0 or without index, which would merge
                // fragments of different calls into one corrupted buffer.
                //
                // ⚠️ 平台兼容层坑点（2026-10-10 实测，移植到其他平台时勿删）：
                // GLM 走 OpenAI 兼容接口时流式 tool_calls 不符合标准协议：
                // ① 并行调用不给 index 或全给 0（标准要求唯一递增）——默认 0 会把
                //    不同调用的参数片段拼进同一缓冲产出 `{...}{...}` 半截 JSON；
                // ② arguments 偶发被 ```json 围栏包裹/前后混说明文字/尾逗号/
                //    中文智能引号/单引号——flush 侧用 parseToolCallArguments 容错；
                // ③ finish_reason=length 时 JSON 只写一半（流截断）。
                // 新平台接入先跑 scripts/dev/probe-api.mjs 验证流式工具调用格式。
                //
                // **为什么更兼容且对标准协议零损害**：分桶键的每一级回退只在
                // 上游偏离标准时才生效——标准 chunk 都带 id 和 index，走第一级
                // `id`，与标准行为完全一致；缺 index 的回退（上一个 key/自增
                // 序号）对标准输入不可达。实测（2026-10-10）：8 个模型 × 2/4 路
                // 并行 × 开/关思考各 3 次探测中所有模型均带唯一递增 index 且
                // arguments 干净，此防御对标准上游零影响；报错仅集中在 GLM
                // 超长上下文（1624 条消息）+ 146 秒长流式输出场景。
                const tcId = typeof tc.id === "string" && tc.id ? tc.id : undefined;
                const tcIndex = typeof tc.index === "number" ? String(tc.index) : undefined;
                let idx: string;
                if (tcId) {
                    idx = tcId;
                } else if (tcIndex) {
                    idx = tcIndex;
                } else if (this._lastToolCallKey) {
                    idx = this._lastToolCallKey;
                } else {
                    idx = `auto_${this._toolCallBuffers.size}`;
                }
                this._lastToolCallKey = idx;
                if (this._completedToolCallIndices.has(idx)) {
                    continue;
                }
                const buf = this._toolCallBuffers.get(idx) ?? { args: "" };
                if (tcId) {
                    buf.id = tcId;
                }
                const func = tc.function as Record<string, unknown> | undefined;
                if (func?.name && typeof func.name === "string") {
                    buf.name = func.name as string;
                }
                if (typeof func?.arguments === "string") {
                    buf.args += func.arguments as string;
                }
                this._toolCallBuffers.set(idx, buf);

                // 不在每个 delta 后尝试发射：流式参数的严格前缀本身可能是合法
                // JSON（如 `{"path":"a.ts"}` 是 `{"path":"a.ts","startLine":1}` 的
                // 前缀），提前发射会永久丢失后续参数。发射统一延迟到
                // finish_reason 时的 flushToolCallBuffers（与 Responses 路径一致）。
            }
        }

        const finish = (choice.finish_reason as string | undefined) ?? undefined;
        if (finish) {
            this._lastFinishReason = finish;
        }
        if (finish === "tool_calls" || finish === "stop") {
            await this.flushToolCallBuffers(progress, true);
        }
        return emitted;
    }

    /**
     * Create a non-streaming chat message (for Git commit generation).
     */
    async *createMessage(
        model: SenseAudioModelItem,
        systemPrompt: string,
        messages: { role: string; content: string }[],
        baseUrl: string,
        apiKey: string,
        signal?: AbortSignal
    ): AsyncGenerator<{ type: "text"; text: string }> {
        const openaiMessages = [...messages];
        if (systemPrompt) {
            openaiMessages.unshift({ role: "system", content: systemPrompt });
        }

        let requestBody: Record<string, unknown> = {
            model: model.id,
            messages: openaiMessages,
            stream: true,
        };
        requestBody = this.prepareRequestBody(requestBody, model, undefined);

        const headers = CommonApi.prepareHeaders(apiKey, model.apiMode ?? "openai", model.headers);

        const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

        const response = await postJson(url, headers, requestBody, signal, "API error");

        if (!response.body) {
            throw new Error("No response body from API");
        }

        for await (const event of iterateSseEvents(response.body, {
            tag: "openai",
            modelId: this._modelId,
            signal,
        })) {
            if (event.done) {
                continue;
            }
            const parsed = event.parsed as Record<string, unknown>;
            const choice = (parsed.choices as Record<string, unknown>[] | undefined)?.[0];
            if (choice?.delta) {
                const deltaObj = choice.delta as Record<string, unknown>;
                const content = deltaObj.content as string | undefined;
                if (content) {
                    yield { type: "text", text: content };
                }
            }
        }
    }
}
