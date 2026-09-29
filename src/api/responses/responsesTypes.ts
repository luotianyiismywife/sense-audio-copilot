/**
 * OpenAI Responses API types (POST /v1/responses).
 *
 * SenseAudio's Responses endpoint supports a subset of the standard
 * OpenAI Responses API:
 * - Content block types: input_text / output_text / input_image
 * - Top-level input items: message items + function_call / function_call_output
 *   items (verified live 2026-09-29 — the endpoint accepts the standard
 *   structured backfill; the `output` field name is required on
 *   function_call_output, `content` is silently ignored)
 * - Tool calls: function_call output items + function_call_arguments stream events
 * - Reasoning: reasoning items with summary_text blocks
 * - tool_choice: "auto" / "none" / "required" (the named object form returns a
 *   deterministic 500, so it is never sent)
 */

/** Content block types supported by SenseAudio's Responses endpoint. */
export type ResponsesContentType = "input_text" | "output_text" | "input_image";

/** A single content block inside a response input/output message. */
export interface ResponsesContentBlock {
    type: ResponsesContentType;
    /** Text content for input_text / output_text blocks. */
    text?: string;
    /** Data URL for input_image blocks. */
    image_url?: string;
    /** Annotations (output_text only). */
    annotations?: unknown[];
}

/** A message item in the input array. */
export interface ResponsesInputMessage {
    role: "user" | "assistant" | "system" | "developer";
    content: string | ResponsesContentBlock[];
}

/**
 * A top-level function_call input item (historical tool call backfill).
 * `call_id` is required; `id` is optional (both verified accepted live).
 */
export interface ResponsesFunctionCallInputItem {
    type: "function_call";
    id?: string;
    call_id: string;
    name: string;
    arguments: string;
}

/**
 * A top-level function_call_output input item (historical tool result backfill).
 * The result field MUST be named `output` — `content` is accepted with 200 but
 * the model does not see the value (verified live 2026-09-29).
 */
export interface ResponsesFunctionCallOutputInputItem {
    type: "function_call_output";
    call_id: string;
    output: string;
}

/** Union of all item types allowed in the input array. */
export type ResponsesInputItem = ResponsesInputMessage | ResponsesFunctionCallInputItem | ResponsesFunctionCallOutputInputItem;

/** A function_call output item (model decided to call a tool). */
export interface ResponsesFunctionCallItem {
    type: "function_call";
    id: string;
    call_id?: string;
    name: string;
    arguments: string;
    status?: string;
}

/** A reasoning output item. */
export interface ResponsesReasoningItem {
    type: "reasoning";
    id: string;
    summary?: Array<{ type: "summary_text"; text: string }>;
    content?: Array<{ type: "summary_text"; text: string }>;
}

/** A message output item. */
export interface ResponsesMessageItem {
    type: "message";
    id: string;
    role: string;
    status?: string;
    content: ResponsesContentBlock[];
}

/** Union of all possible output items. */
export type ResponsesOutputItem = ResponsesFunctionCallItem | ResponsesReasoningItem | ResponsesMessageItem;

/** Function tool definition for the Responses API. */
export interface ResponsesFunctionTool {
    type: "function";
    name: string;
    description?: string;
    parameters?: object;
}

/** Usage information returned by the Responses API. */
export interface ResponsesUsage {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_tokens_details?: {
        cached_tokens?: number;
        cache_creation_tokens?: number | null;
    };
    output_tokens_details?: {
        reasoning_tokens?: number;
    };
    x_details?: unknown[];
}

/** Non-streaming response object. */
export interface ResponsesResponse {
    id: string;
    object: "response";
    model: string;
    status: string;
    output: ResponsesOutputItem[];
    output_text?: string;
    usage?: ResponsesUsage;
    error?: unknown;
    cost_cny?: number;
    trace_id?: string;
}

/** A parsed streaming event. */
export interface ResponsesStreamEvent {
    type: string;
    sequence_number?: number;
    item?: ResponsesOutputItem;
    output_index?: number;
    content_index?: number;
    delta?: string;
    arguments?: string;
    response?: Partial<ResponsesResponse>;
    error?: unknown;
}
