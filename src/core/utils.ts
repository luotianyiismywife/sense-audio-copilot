import * as vscode from "vscode";
import type { RetryConfig } from "./types";
import type { StoredImage } from "../vision/types";
import { OpenAIFunctionToolDef } from "../api/openai/openaiTypes";

const RETRY_MAX_ATTEMPTS = 2;
const RETRY_INTERVAL_MS = 1000;
const RETRY_BACKOFF_FACTOR = 2;
const RETRY_MAX_INTERVAL_MS = 60000;

// HTTP status codes that should trigger an HTTP-layer retry.
//
// Deliberately limited to **gateway** errors (502/504) — a quick retry often
// clears a transient gateway blip. Platform errors that the whole-round retry
// already handles (429/500/503, see `senseaudio.transientRetryStatusCodes`)
// are intentionally ABSENT: retrying them here first would multiply the two
// retry layers (maxAttempts × (transientRetryTimes + 1) attempts) and delay
// failover to another key. Network errors are retried separately via
// `networkErrorPatterns` below.
const RETRYABLE_STATUS_CODES = [502, 504];

// Network error patterns to retry
const networkErrorPatterns = [
    "fetch failed",
    "ECONNRESET",
    "ETIMEDOUT",
    "ENOTFOUND",
    "ECONNREFUSED",
    "timeout",
    "TIMEOUT",
    "network error",
    "NetworkError",
];

/**
 * Map VS Code message role to OpenAI message role string.
 */
export function mapRole(message: vscode.LanguageModelChatRequestMessage): "user" | "assistant" | "system" {
    const USER = vscode.LanguageModelChatMessageRole.User as unknown as number;
    const ASSISTANT = vscode.LanguageModelChatMessageRole.Assistant as unknown as number;
    const r = message.role as unknown as number;
    if (r === USER) {
        return "user";
    }
    if (r === ASSISTANT) {
        return "assistant";
    }
    return "system";
}

/**
 * Convert VS Code tool definitions to OpenAI function tool definitions.
 */
export function convertToolsToOpenAI(
    options?: vscode.ProvideLanguageModelChatResponseOptions
): { tools?: OpenAIFunctionToolDef[]; tool_choice?: string } {
    if (!options?.tools || options.tools.length === 0) {
        return {};
    }

    const tools: OpenAIFunctionToolDef[] = options.tools.map((tool) => {
        const def: OpenAIFunctionToolDef = {
            type: "function",
            function: {
                name: tool.name,
                description: tool.description,
            },
        };
        // Use the tool's inputSchema as parameters if available
        if (tool.inputSchema) {
            def.function.parameters = tool.inputSchema;
        } else {
            def.function.parameters = { type: "object", properties: {} };
        }
        return def;
    });

    // Determine tool_choice mode
    const toolMode = (options?.modelOptions as Record<string, unknown> | undefined)
        ?.toolMode as string | undefined;

    let toolChoice: string | undefined;
    if (toolMode === "required") {
        toolChoice = "required";
    } else if (toolMode === "none") {
        toolChoice = "none";
    } else if (toolMode === "auto") {
        toolChoice = "auto";
    }

    return { tools, tool_choice: toolChoice };
}

/**
 * Create retry configuration from VS Code settings.
 *
 * This is the **HTTP layer** retry (same request, immediate backoff). It is
 * distinct from the **whole-round** retry in `provider/rotation.ts`
 * (`senseaudio.transientRetry*`), which re-runs the entire key-rotation loop
 * and can therefore also handle platform-side errors without switching keys.
 *
 * The two layers multiply: a request that fails with a status code present in
 * BOTH lists is attempted `maxAttempts × (transientRetryTimes + 1)` times.
 * Keep `maxAttempts` small (default 2) to avoid long hangs.
 */
export function createRetryConfig(): RetryConfig {
    const config = vscode.workspace.getConfiguration("senseaudio.retry");
    const enabled = config.get<boolean>("enabled", true);
    const maxAttempts = config.get<number>("maxAttempts", RETRY_MAX_ATTEMPTS);
    const intervalMs = config.get<number>("intervalMs", RETRY_INTERVAL_MS);
    const additionalStatusCodes = config.get<number[]>("statusCodes", []);

    return {
        enabled,
        maxAttempts,
        intervalMs,
        backoffFactor: RETRY_BACKOFF_FACTOR,
        maxIntervalMs: RETRY_MAX_INTERVAL_MS,
        statusCodes: [...RETRYABLE_STATUS_CODES, ...additionalStatusCodes],
    };
}

/**
 * Execute an async function with retry logic.
 */
export async function executeWithRetry<T>(
    fn: () => Promise<T>,
    retryConfig: RetryConfig
): Promise<T> {
    if (!retryConfig.enabled) {
        return fn();
    }

    let lastError: Error | undefined;
    let delay = retryConfig.intervalMs;

    for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));

            if (attempt === retryConfig.maxAttempts) {
                break;
            }

            // Check if error is retryable
            const isRetryable = isRetryableError(lastError, retryConfig.statusCodes);
            if (!isRetryable) {
                break;
            }

            // Wait before retrying
            await new Promise<void>((resolve) => setTimeout(resolve, delay));

            // Exponential backoff
            delay = Math.min(delay * retryConfig.backoffFactor, retryConfig.maxIntervalMs);
        }
    }

    throw lastError;
}

function isRetryableError(error: Error, retryableStatusCodes: number[]): boolean {
    const message = error.message.toLowerCase();

    // Check network error patterns
    for (const pattern of networkErrorPatterns) {
        if (message.includes(pattern.toLowerCase())) {
            return true;
        }
    }

    // Check HTTP status codes in error message
    for (const code of retryableStatusCodes) {
        if (message.includes(`[${code}]`) || message.includes(`status ${code}`)) {
            return true;
        }
    }

    return false;
}

/**
 * Check if a mime type is an image type.
 */
export function isImageMimeType(mimeType: string): boolean {
    return mimeType.startsWith("image/");
}

/**
 * Regex pattern to match data URI encoded images in text.
 * Matches: data:image/{format};base64,{base64_data}
 */
const DATA_URI_IMAGE_RE = /data:image\/(?:png|jpeg|jpg|gif|webp|bmp);base64,([A-Za-z0-9+/=]+)/g;

/**
 * Detect base64-encoded data URI images in text, decode and store them.
 * Used during the image storage pass in convertMessages.
 * @returns The number of data URI images found and stored.
 */
export function storeDataUriImages(text: string, imagesToStore: StoredImage[]): number {
    let count = 0;
    DATA_URI_IMAGE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = DATA_URI_IMAGE_RE.exec(text)) !== null) {
        const fullMatch = match[0];
        const base64Data = match[1];
        count++;

        let mimeType = "image/png";
        if (fullMatch.startsWith("data:image/jpeg")) mimeType = "image/jpeg";
        else if (fullMatch.startsWith("data:image/gif")) mimeType = "image/gif";
        else if (fullMatch.startsWith("data:image/webp")) mimeType = "image/webp";
        else if (fullMatch.startsWith("data:image/bmp")) mimeType = "image/bmp";

        const binaryStr = atob(base64Data);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
        }
        imagesToStore.push({ data: bytes, mimeType });
    }
    return count;
}

/**
 * Replace base64-encoded data URI images in text with image index references.
 * Does NOT store images (they should already be stored by the storage pass).
 * @param text The text to scan.
 * @param startIndex The starting imageIndex to assign.
 * @returns { text: string; count: number } The modified text and number of replacements.
 */
export function replaceDataUriImages(text: string, startIndex: number): { text: string; count: number } {
    let result = text;
    let offset = 0;
    let count = 0;
    let idx = startIndex;

    DATA_URI_IMAGE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = DATA_URI_IMAGE_RE.exec(text)) !== null) {
        const fullMatch = match[0];
        count++;
        const before = result.slice(0, match.index + offset);
        const after = result.slice(match.index + offset + fullMatch.length);
        const replacement = `\n[Image data from tool call (imageIndex=${idx}). I am a text-only model and CANNOT see images directly. I MUST call the ask_image tool to learn about it.\n\nRecommended strategy:\n1. First call ask_image for a brief description to get an overview of the image.\n2. Then call ask_image again with specific questions about details you need (e.g., colors, text content, UI elements, error messages, or any other visible information).\n]`;
        result = before + replacement + after;
        offset += replacement.length - fullMatch.length;
        idx++;
    }

    return { text: result, count };
}

/**
 * Create a data URL from a LanguageModelDataPart.
 */
export function createDataUrl(part: vscode.LanguageModelDataPart): string {
    const base64 = arrayBufferToBase64(part.data);
    return `data:${part.mimeType};base64,${base64}`;
}

function arrayBufferToBase64(buffer: Uint8Array): string {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * Check if a part is a tool result part.
 */
export function isToolResultPart(
    part: unknown
): part is vscode.LanguageModelToolResultPart {
    return part instanceof vscode.LanguageModelToolResultPart;
}

/**
 * Safely try to parse a JSON object from a string.
 * Returns { ok: true, value } or { ok: false }.
 */
export function tryParseJSONObject(
    text: string
): { ok: true; value: Record<string, unknown> } | { ok: false } {
    try {
        const parsed = JSON.parse(text);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            return { ok: true, value: parsed as Record<string, unknown> };
        }
        return { ok: false };
    } catch {
        return { ok: false };
    }
}

/**
 * Normalize a streamed tool-call arguments string and parse it tolerantly.
 *
 * Handles common model-side quirks before falling back to a repair pass:
 * 1. Trim whitespace.
 * 2. Strip markdown code fences (```json ... ```).
 * 3. Strip leading/trailing non-JSON prose (text before first `{` / after last `}`).
 * 4. Empty/undefined → `{}`.
 * 5. Repair common JSON defects: trailing commas, smart quotes, single-quoted
 *    strings, unclosed braces/brackets (stream truncation).
 *
 * Returns the parsed object, or undefined when unparseable.
 *
 * ⚠️ 平台兼容层坑点（2026-10-10 实测，移植到其他平台时保留此防御层）：
 * GLM 走 OpenAI 兼容接口时 arguments 字符串不干净——围栏包裹、前后杂质、
 * 尾逗号、中文智能引号、单引号、流截断（finish_reason=length）均实测出现过。
 * 解析失败直接 throw 会终止整个请求（用户看到 "Sorry, your request failed"），
 * 容错解析 + 失败时日志带 idx/name/snippet 才是正确姿势。三协议共用本函数。
 *
 * **为什么更兼容且对标准协议零损害（2026-10-10 实测验证）**：
 * 所有容错都是"严格解析失败后才走"的兜底——干净 JSON 在第 5 步之前就被
 * `tryParseJSONObject` 直接解析成功，修复路径（repairJsonText）根本不触发，
 * 标准输入的解析结果与不做任何容错时完全一致。不存在"为了兼容坏的而牺牲
 * 好的"：它只是把"坏输入直接终止整个长流式请求"变成"能救则救、救不回再
 * 报错"。实测背景：报错全部集中在 GLM 超长上下文（messageCount=1624）+
 * 146~149 秒长流式输出场景，同样的请求换 DeepSeek 成功、GLM 小上下文也
 * 全部成功——即 GLM 仅在长流尾部偶发把 JSON 写一半（流截断），本函数的
 * 未闭合括号补全正是覆盖该场景。8 个模型 × 2/4 路并行 × 开/关思考各 3 次
 * 探测中所有模型的标准输出均干净，证明此防御对标准上游零影响。
 */
export function parseToolCallArguments(raw: string | undefined): Record<string, unknown> | undefined {
    let text = (raw ?? "").trim();
    if (!text) {
        return {};
    }

    // Strip markdown code fences.
    const fence = text.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
    if (fence) {
        text = fence[1].trim();
    }

    // Strip prose before the first `{` / after the last `}`.
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first > 0 || (last !== -1 && last < text.length - 1)) {
        if (first !== -1 && last > first) {
            text = text.slice(first, last + 1);
        }
    }

    const direct = tryParseJSONObject(text);
    if (direct.ok) {
        return direct.value;
    }

    // Repair pass: fix common defects then retry.
    const repaired = repairJsonText(text);
    if (repaired !== text) {
        const retry = tryParseJSONObject(repaired);
        if (retry.ok) {
            return retry.value;
        }
    }
    return undefined;
}

/**
 * Best-effort repair of common JSON defects in streamed tool-call arguments.
 * Only used as a fallback when strict parsing fails.
 */
function repairJsonText(text: string): string {
    let out = text;
    // Smart quotes → straight quotes.
    out = out.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'");
    // Trailing commas before } or ].
    out = out.replace(/,\s*([}\]])/g, "$1");
    // Single-quoted keys/values → double quotes (only when no double quotes present in the segment).
    if (!out.includes('"')) {
        out = out.replace(/'([^'\\]*)'/g, '"$1"');
    }
    // Balance unclosed braces/brackets (stream truncation mid-JSON).
    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    for (const ch of out) {
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === "\\") {
            escaped = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (inString) {
            continue;
        }
        if (ch === "{" || ch === "[") {
            stack.push(ch);
        } else if (ch === "}" || ch === "]") {
            stack.pop();
        }
    }
    if (inString) {
        out += '"';
    }
    // Drop a dangling trailing fragment like `, "key":` or `, "key"` at the end.
    out = out.replace(/,\s*"[^"]*"?\s*:?\s*$/, "");
    out = out.replace(/,\s*$/, "");
    while (stack.length > 0) {
        out += stack.pop() === "{" ? "}" : "]";
    }
    return out;
}
