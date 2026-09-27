import * as vscode from "vscode";
import { LanguageModelChatInformation, LanguageModelChatRequestMessage, LanguageModelChatTool } from "vscode";
import { countMessageTokens, countToolTokens } from "../tokenizer/provideToken";
import { l10n, l10nFormat } from "../core/localize";
import { logger } from "../core/logger";
import type { StreamUsage } from "../api/commonApi";
import {
    formatBalanceSummary,
    formatBillingModeLine,
    formatResetDuration,
    formatWindowLine,
    getPlanUsageCached,
    getPlanUsageSnapshot,
    getPrimaryWindow,
    getWindowPercent,
    isPlanExhausted,
    type PlanUsageSnapshot,
} from "../balance/balanceCheck";

// Cumulative token counters across the session (reset on VS Code restart)
let cumulativeInputTokens = 0;
let cumulativeOutputTokens = 0;
let cumulativeCacheHitTokens = 0;
let cumulativeCacheMissTokens = 0;

/** How long the status bar stays visible after the last SenseAudio model request. */
const STATUS_BAR_HIDE_DELAY_MS = 60 * 1000; // 1 minute of inactivity
/** Module-level timer for auto-hiding the status bar when SenseAudio models are no longer in use. */
let statusBarHideTimer: NodeJS.Timeout | null = null;

/**
 * Last rendered token-count text. Kept so the main text can be restored
 * immediately when `showUsageInStatusBar` is toggled off at runtime
 * (otherwise the plan-usage text would linger until the next request).
 */
let lastTokenText = "$(pulse) --";

// ── Plan usage polling state (mirrors upstream opencode-go-copilot) ──
/** Login-token provider, injected by `initStatusBar` (token lives in globalState). */
let usageTokenProvider: (() => string | undefined) | undefined;
/** Status bar item reference for background re-renders. */
let usageStatusBarItem: vscode.StatusBarItem | undefined;
/** Background refresh timer. */
let usagePollTimer: NodeJS.Timeout | undefined;
/** Guard against overlapping refreshes. */
let usageRefreshInFlight = false;

/**
 * Whether the plan-usage section is shown in the status bar tooltip.
 * Default on — the tooltip is only visible on hover, so it costs nothing.
 */
function isUsageTooltipEnabled(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>("senseaudio.showUsageInTooltip", true);
}

/**
 * Whether the status bar main text shows plan usage instead of token counts.
 * Default on — this is the primary value of the status bar for a
 * subscription-based provider (token counts remain in the tooltip).
 */
function isUsageInStatusBarEnabled(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>("senseaudio.showUsageInStatusBar", true);
}

/** Background refresh interval in ms (clamped to 1-60 minutes). */
function getUsageRefreshIntervalMs(): number {
    const minutes = vscode.workspace.getConfiguration().get<number>("senseaudio.usageRefreshInterval", 5);
    const clamped = Number.isFinite(minutes) ? Math.min(Math.max(minutes, 1), 60) : 5;
    return clamped * 60 * 1000;
}

/**
 * Refresh the cached plan usage (fire-and-forget). No-ops without a login
 * token or while a refresh is already in flight. On success the status bar
 * text and tooltip are re-rendered so the next glance/hover shows fresh data.
 */
async function refreshPlanUsage(): Promise<void> {
    if (usageRefreshInFlight || !usageTokenProvider) {
        return;
    }
    const token = usageTokenProvider();
    if (!token) {
        logger.debug("planUsage.poll.skip", { reason: "no-token" });
        return;
    }
    usageRefreshInFlight = true;
    try {
        const snapshot = await getPlanUsageCached(token);
        if (snapshot && usageStatusBarItem) {
            updateStatusBarUsageText(usageStatusBarItem);
            updateCumulativeTooltip(usageStatusBarItem);
        }
    } finally {
        usageRefreshInFlight = false;
    }
}

function stopUsagePolling(): void {
    if (usagePollTimer) {
        clearInterval(usagePollTimer);
        usagePollTimer = undefined;
        logger.debug("planUsage.poll.stop", {});
    }
}

function startUsagePolling(): void {
    stopUsagePolling();
    // Don't poll when nothing consumes the data — the status bar is hidden
    // entirely (both the plan-usage display and the token indicator are off),
    // so polling would only add needless network traffic.
    if (!isStatusBarEnabled()) {
        logger.debug("planUsage.poll.skip", { reason: "status-bar-disabled" });
        return;
    }
    void refreshPlanUsage();
    const intervalMs = getUsageRefreshIntervalMs();
    usagePollTimer = setInterval(() => {
        void refreshPlanUsage();
    }, intervalMs);
    logger.debug("planUsage.poll.start", { intervalMs });
}

/**
 * Force an immediate plan-usage refresh (used by the `checkUsage` command and
 * by clicking the status bar item) and re-render once fresh data arrives.
 */
export async function refreshPlanUsageNow(): Promise<PlanUsageSnapshot | null> {
    const token = usageTokenProvider?.();
    if (!token) {
        return null;
    }
    usageRefreshInFlight = true;
    try {
        const snapshot = await getPlanUsageCached(token, true);
        if (usageStatusBarItem) {
            updateStatusBarUsageText(usageStatusBarItem);
            updateCumulativeTooltip(usageStatusBarItem);
        }
        return snapshot;
    } finally {
        usageRefreshInFlight = false;
    }
}

/**
 * Render the status bar main text.
 *
 * Layout (mirrors upstream `Go 5H 65%`):
 * - plan quota available → `$(pulse) 5H 65%` (5-hour rate-limit window)
 * - plan quota exhausted → `$(pulse) 余额 ¥12.34` (billing from balance)
 * - no data yet → `$(pulse) --`
 * - plan usage disabled → restore the token-count text (legacy behaviour)
 */
function updateStatusBarUsageText(statusBarItem: vscode.StatusBarItem): void {
    if (!isUsageInStatusBarEnabled()) {
        // Restore the token-count text so toggling the setting off takes
        // effect immediately (instead of leaving the plan-usage text until
        // the next request re-renders it).
        statusBarItem.text = lastTokenText;
        return;
    }
    const snapshot = getPlanUsageSnapshot();
    const primary = getPrimaryWindow(snapshot);
    if (!snapshot || !primary) {
        statusBarItem.text = `$(pulse) --`;
        return;
    }
    if (isPlanExhausted(snapshot)) {
        statusBarItem.text = `$(pulse) ${l10n("Balance")} ${formatBalanceSummary(snapshot)}`;
        return;
    }
    statusBarItem.text = `$(pulse) ${l10n("5H")} ${getWindowPercent(primary)}%`;
}

/**
 * Append the plan-usage section to the tooltip lines.
 *
 * Layout:
 * ```
 * ↑ 12.3K (1.2K cached, 65%)
 * ↓ 4.5K
 *
 * 5H——65% (6,500 / 10,000 积分)
 * Week——30% (3,000 / 10,000 积分)
 * Month——12% (1,200 / 10,000 积分)
 * 五小时窗口将在 2H13M 后重置
 *
 * 余额——¥0.00 + 赠送 ¥358.78
 * 套餐额度内（5h / 周窗口耗尽仅限流，等待下一周期恢复，不扣余额）
 * ```
 */
function appendPlanUsageTooltipLines(lines: string[]): void {
    if (!isUsageTooltipEnabled()) {
        return;
    }
    const snapshot = getPlanUsageSnapshot();
    if (!snapshot) {
        return;
    }
    if (snapshot.windows.length > 0) {
        lines.push("");
        for (const window of snapshot.windows) {
            lines.push(formatWindowLine(window));
        }
        const primary = getPrimaryWindow(snapshot);
        const reset = formatResetDuration(primary?.resetTime);
        if (reset) {
            lines.push(l10nFormat("5h window resets in {0}", reset));
        }
    }
    // Balance line (always shown — it is the fallback billing source)
    lines.push("");
    lines.push(`${l10n("Balance")}——${formatBalanceSummary(snapshot)}`);
    const billingLine = formatBillingModeLine(snapshot);
    if (billingLine) {
        lines.push(billingLine);
    }
}

export function initStatusBar(
    context: vscode.ExtensionContext,
    getLoginToken?: () => string | undefined,
): vscode.StatusBarItem {
    // Reset cumulative counters on VS Code startup
    resetCumulativeCounters();

    const tokenCountStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    tokenCountStatusBarItem.name = l10n("Token Count");
    tokenCountStatusBarItem.text = `$(pulse) --`;
    tokenCountStatusBarItem.tooltip = l10n("Plan usage and token usage");
    // Clicking the status bar refreshes the plan usage immediately
    tokenCountStatusBarItem.command = "senseaudio.checkUsage";
    context.subscriptions.push(tokenCountStatusBarItem);

    // Plan usage polling for the status bar text and tooltip section
    usageTokenProvider = getLoginToken;
    usageStatusBarItem = tokenCountStatusBarItem;
    if (getLoginToken) {
        startUsagePolling();
    }
    context.subscriptions.push({ dispose: stopUsagePolling });
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            const usageSettingChanged =
                e.affectsConfiguration("senseaudio.showUsageInTooltip") ||
                e.affectsConfiguration("senseaudio.showUsageInStatusBar") ||
                e.affectsConfiguration("senseaudio.usageRefreshInterval");
            const indicatorChanged = e.affectsConfiguration("senseaudio.enableThirdPartyTokenIndicator");
            if (!usageSettingChanged && !indicatorChanged) {
                return;
            }
            // Re-evaluate polling (starts when enabled, stops when the whole
            // status bar is disabled) and re-render both text and tooltip.
            startUsagePolling();
            updateStatusBarUsageText(tokenCountStatusBarItem);
            updateCumulativeTooltip(tokenCountStatusBarItem);
            if (indicatorChanged) {
                if (isStatusBarEnabled()) {
                    tokenCountStatusBarItem.show();
                } else {
                    tokenCountStatusBarItem.hide();
                }
            }
        })
    );

    // Do NOT show on startup — only show while one of this extension's models is actually in use.
    tokenCountStatusBarItem.hide();
    return tokenCountStatusBarItem;
}

/**
 * Whether the extension's own (advanced) token indicator is enabled.
 * Default off — the native Copilot indicator is always reported separately.
 */
function isThirdPartyIndicatorEnabled(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>("senseaudio.enableThirdPartyTokenIndicator", false);
}

/**
 * Whether the extension status bar should be shown at all.
 *
 * The status bar carries **two independent features**:
 * - plan usage (main text + tooltip section) — `showUsageInStatusBar` / `showUsageInTooltip`
 * - advanced token counter — `enableThirdPartyTokenIndicator`
 *
 * It must be visible when **either** is enabled. Gating it solely on the token
 * indicator (default off) would make the plan-usage display unreachable.
 */
function isStatusBarEnabled(): boolean {
    return isThirdPartyIndicatorEnabled() || isUsageInStatusBarEnabled() || isUsageTooltipEnabled();
}

/**
 * Show the status bar and cancel any pending auto-hide.
 * Called when a chat request starts using one of this extension's models.
 * No-op when both the plan-usage display and the token indicator are disabled.
 */
export function showTokenStatusBar(statusBarItem: vscode.StatusBarItem): void {
    if (!isStatusBarEnabled()) {
        statusBarItem.hide();
        return;
    }
    if (statusBarHideTimer) {
        clearTimeout(statusBarHideTimer);
        statusBarHideTimer = null;
    }
    statusBarItem.show();
}

/**
 * Schedule hiding the status bar after a period of inactivity.
 * Called when a chat request finishes; the bar stays visible while the user
 * keeps using SenseAudio models and auto-hides once they stop (e.g. switched
 * to another model provider).
 */
export function scheduleStatusBarHide(statusBarItem: vscode.StatusBarItem, delayMs: number = STATUS_BAR_HIDE_DELAY_MS): void {
    if (statusBarHideTimer) {
        clearTimeout(statusBarHideTimer);
    }
    statusBarHideTimer = setTimeout(() => {
        statusBarHideTimer = null;
        statusBarItem.hide();
    }, delayMs);
}

/**
 * Format number to thousands (K, M, B) format.
 */
export function formatTokenCount(value: number): string {
    if (value >= 1_000_000_000) {
        return (value / 1_000_000_000).toFixed(1) + "B";
    } else if (value >= 1_000_000) {
        return (value / 1_000_000).toFixed(1) + "M";
    } else if (value >= 1_000) {
        return (value / 1_000).toFixed(1) + "K";
    }
    return value.toLocaleString();
}

/**
 * Create a visual progress bar showing token usage.
 */
export function createProgressBar(usedTokens: number, maxTokens: number): string {
    const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
    const usagePercentage = Math.min((usedTokens / maxTokens) * 100, 100);
    const blockIndex = Math.min(Math.floor((usagePercentage / 100) * blocks.length), blocks.length - 1);

    return `${blocks[blockIndex]} ${usagePercentage.toFixed(1)}%`;
}

/**
 * Update the status bar with token usage information.
 * Resets cumulative counters when a new conversation starts
 * (no assistant messages in the history).
 * @returns The estimated input token count (for fallback usage).
 */
export async function updateContextStatusBar(
    messages: readonly LanguageModelChatRequestMessage[],
    tools: readonly LanguageModelChatTool[] | undefined,
    model: LanguageModelChatInformation,
    statusBarItem: vscode.StatusBarItem,
    modelConfig: { includeReasoningInRequest: boolean }
): Promise<number> {
    try {
        // Detect new conversation: no assistant messages → reset cumulative counters
        const ASSISTANT = vscode.LanguageModelChatMessageRole.Assistant as unknown as number;
        const hasAssistantMessages = messages.some(m => (m.role as unknown as number) === ASSISTANT);
        if (!hasAssistantMessages) {
            resetCumulativeCounters();
        }

        let totalTokens = 0;

        for (const message of messages) {
            totalTokens += await countMessageTokens(message, modelConfig);
        }

        if (tools && tools.length > 0) {
            totalTokens += await countToolTokens(tools);
        }

        const maxTokens = model.maxInputTokens || 128000;
        const progressBar = createProgressBar(totalTokens, maxTokens);
        const formattedTokens = formatTokenCount(totalTokens);

        if (isUsageInStatusBarEnabled()) {
            // Plan usage owns the main text; token counts live in the tooltip.
            updateStatusBarUsageText(statusBarItem);
        } else {
            lastTokenText = `$(symbol-numeric) ${formattedTokens} ${progressBar}`;
            statusBarItem.text = lastTokenText;
        }
        // Always show cumulative tooltip (not per-request) to avoid flickering
        updateCumulativeTooltip(statusBarItem);
        return totalTokens;
    } catch {
        lastTokenText = "$(symbol-numeric) ?";
        statusBarItem.text = lastTokenText;
        return 0;
    }
}

/**
 * Update the status bar main text using API-reported prompt token count.
 * Called when API returns usage data, overriding the initial client-side estimate.
 * No-op on the main text when plan usage owns it (token counts stay in the tooltip).
 */
export function updateStatusBarWithApiPrompt(
    apiPromptTokens: number,
    maxTokens: number,
    statusBarItem: vscode.StatusBarItem
): void {
    if (!isUsageInStatusBarEnabled()) {
        const progressBar = createProgressBar(apiPromptTokens, maxTokens);
        const formattedTokens = formatTokenCount(apiPromptTokens);
        lastTokenText = `$(symbol-numeric) ${formattedTokens} ${progressBar}`;
        statusBarItem.text = lastTokenText;
    }
    updateCumulativeTooltip(statusBarItem);
}

/**
 * Reset all cumulative token counters (called on VS Code startup and new conversation).
 */
export function resetCumulativeCounters(): void {
    cumulativeInputTokens = 0;
    cumulativeOutputTokens = 0;
    cumulativeCacheHitTokens = 0;
    cumulativeCacheMissTokens = 0;
}

/**
 * Record streaming usage data into cumulative counters.
 */
export function recordUsage(usage: StreamUsage): void {
    cumulativeInputTokens += usage.promptTokens;
    cumulativeOutputTokens += usage.completionTokens;
    if (usage.cacheHitTokens !== undefined) {
        cumulativeCacheHitTokens += usage.cacheHitTokens;
    }
    if (usage.cacheMissTokens !== undefined) {
        cumulativeCacheMissTokens += usage.cacheMissTokens;
    }
}

/**
 * Update the status bar tooltip with cumulative input/output token counts,
 * DeepSeek cache info (if available) and the SenseAudio plan usage section
 * (if enabled and data is cached).
 */
export function updateCumulativeTooltip(statusBarItem: vscode.StatusBarItem): void {
    const arrowUp = "\u2191";
    const arrowDown = "\u2193";
    const lines: string[] = [];

    // Line 1: cumulative input + cache info
    let inputLine = `${arrowUp} ${formatTokenCount(cumulativeInputTokens)}`;
    if (cumulativeCacheHitTokens > 0 || cumulativeCacheMissTokens > 0) {
        const totalCache = cumulativeCacheHitTokens + cumulativeCacheMissTokens;
        const cachePercent = totalCache > 0
            ? Math.round((cumulativeCacheHitTokens / totalCache) * 100)
            : 0;
        const cacheFormatted = formatTokenCount(cumulativeCacheHitTokens);
        inputLine += ` ${l10nFormat("({0} cached, {1}%)", cacheFormatted, cachePercent)}`;
    }
    lines.push(inputLine);

    // Line 2: cumulative output
    lines.push(`${arrowDown} ${formatTokenCount(cumulativeOutputTokens)}`);

    // Section 3: SenseAudio plan usage + balance (optional)
    appendPlanUsageTooltipLines(lines);

    statusBarItem.tooltip = lines.join("\n");
}
