import * as vscode from "vscode";
import { LanguageModelChatRequestMessage, LanguageModelChatTool } from "vscode";
import { countMessageTokens, countToolTokens } from "../tokenizer/provideToken";
import { l10n, l10nFormat } from "../core/localize";
import { logger } from "../core/logger";
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

/** How long the status bar stays visible after the last SenseAudio model request. */
const STATUS_BAR_HIDE_DELAY_MS = 60 * 1000; // 1 minute of inactivity
/** Module-level timer for auto-hiding the status bar when SenseAudio models are no longer in use. */
let statusBarHideTimer: NodeJS.Timeout | null = null;

// ── Plan usage polling state (mirrors upstream opencode-go-copilot) ──
/** Account credential provider, injected by `initStatusBar` (credential lives in the key store). */
let usageCredentialProvider: (() => Promise<string | undefined>) | undefined;
/** Status bar item reference for background re-renders. */
let usageStatusBarItem: vscode.StatusBarItem | undefined;
/** Background refresh timer. */
let usagePollTimer: NodeJS.Timeout | undefined;
/** Guard against overlapping refreshes. */
let usageRefreshInFlight = false;

/**
 * Whether the plan-usage status bar is enabled (main text + tooltip).
 * Default on. When off, the status bar is hidden entirely.
 */
function isUsageEnabled(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>("senseaudio.showUsage", true);
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
    if (usageRefreshInFlight || !usageCredentialProvider) {
        return;
    }
    // 先置 in-flight 标志再 await（否则两个并发调用都能通过上面的检查，
    // 各自 await 后都置标志并重复发起请求）。
    usageRefreshInFlight = true;
    try {
        const token = await usageCredentialProvider();
        if (!token) {
            logger.debug("planUsage.poll.skip", { reason: "no-credential" });
            return;
        }
        const snapshot = await getPlanUsageCached(token);
        if (snapshot && usageStatusBarItem) {
            updateStatusBarUsageText(usageStatusBarItem);
            updateStatusBarTooltip(usageStatusBarItem);
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
    // entirely (both the plan-usage main text and tooltip are off), so polling
    // would only add needless network traffic.
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
    // 并发保护：后台刷新在途时不重复发起（避免穿透 in-flight 标志形成并发请求），
    // 直接返回当前缓存快照。
    if (usageRefreshInFlight) {
        return getPlanUsageSnapshot();
    }
    // 先置 in-flight 标志再 await（否则两个并发调用都能通过上面的检查）。
    usageRefreshInFlight = true;
    try {
        const token = await usageCredentialProvider?.();
        if (!token) {
            return null;
        }
        const snapshot = await getPlanUsageCached(token, true);
        if (usageStatusBarItem) {
            updateStatusBarUsageText(usageStatusBarItem);
            updateStatusBarTooltip(usageStatusBarItem);
        }
        return snapshot;
    } finally {
        usageRefreshInFlight = false;
    }
}

/**
 * Render the status bar main text.
 *
 * Layout:
 * - 套餐额度内（billingMode=plan）→ `$(pulse) 65%`（5 小时窗口已用百分比）
 * - 用余额（billingMode=extra/free，月度额度耗尽）→ `$(pulse) ¥12.34`（现金+代金券合计）
 * - no data yet → `$(pulse) --`
 *
 * 区分依据：`isPlanExhausted`（只看月度额度窗口）——月度额度耗尽即进入
 * 超额计费（代金券→现金），此时显示余额；额度内显示 5 小时窗口已用百分比。
 */
function updateStatusBarUsageText(statusBarItem: vscode.StatusBarItem): void {
    const snapshot = getPlanUsageSnapshot();
    if (!snapshot) {
        statusBarItem.text = `$(pulse) --`;
        return;
    }
    if (isPlanExhausted(snapshot)) {
        // 用余额：月度套餐额度耗尽，超出部分按量计费（代金券→现金）
        statusBarItem.text = `$(pulse) ${formatBalanceSummary(snapshot)}`;
        return;
    }
    // 套餐额度内：显示 5 小时窗口已用百分比
    const primary = getPrimaryWindow(snapshot);
    if (!primary) {
        statusBarItem.text = `$(pulse) --`;
        return;
    }
    statusBarItem.text = `$(pulse) ${getWindowPercent(primary)}%`;
}

/**
 * Append the plan-usage section to the tooltip lines.
 *
 * Layout (2026-10-10 改版：仅套餐用量 + 余额，累计 Token 部分已移除——
 * VS Code 原生会话 Token 指示器已覆盖该信息):
 * ```
 * 5H——65% (6,500 / 10,000 积分)
 * Week——30% (3,000 / 10,000 积分)
 * Month——12% (1,200 / 10,000 积分)
 * 五小时窗口将在 2H13M 后重置
 *
 * 余额——¥358.78
 * 套餐额度内（5h / 周窗口耗尽仅限流，等待下一周期恢复，不扣余额）
 * ```
 */
function appendPlanUsageTooltipLines(lines: string[]): void {
    if (!isUsageEnabled()) {
        return;
    }
    const snapshot = getPlanUsageSnapshot();
    if (!snapshot) {
        return;
    }
    if (snapshot.windows.length > 0) {
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
    getCredential?: () => Promise<string | undefined>,
): vscode.StatusBarItem {
    const tokenCountStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    tokenCountStatusBarItem.name = l10n("Remaining Usage");
    tokenCountStatusBarItem.text = `$(pulse) --`;
    tokenCountStatusBarItem.tooltip = l10n("Remaining Usage");
    // Clicking the status bar refreshes the plan usage immediately
    tokenCountStatusBarItem.command = "senseaudio.checkUsage";
    context.subscriptions.push(tokenCountStatusBarItem);

    // Plan usage polling for the status bar text and tooltip section
    usageCredentialProvider = getCredential;
    usageStatusBarItem = tokenCountStatusBarItem;
    if (getCredential) {
        startUsagePolling();
    }
    context.subscriptions.push({ dispose: stopUsagePolling });
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            const usageSettingChanged =
                e.affectsConfiguration("senseaudio.showUsage") ||
                e.affectsConfiguration("senseaudio.usageRefreshInterval");
            if (!usageSettingChanged) {
                return;
            }
            // Re-evaluate polling (starts when enabled, stops when the whole
            // status bar is disabled) and re-render both text and tooltip.
            startUsagePolling();
            if (isStatusBarEnabled()) {
                tokenCountStatusBarItem.show();
                updateStatusBarUsageText(tokenCountStatusBarItem);
                updateStatusBarTooltip(tokenCountStatusBarItem);
            } else {
                tokenCountStatusBarItem.hide();
            }
        })
    );

    // 常态化显示（2026-10-10 改版）：不再静默隐藏，启动即显示并保持常显。
    if (isStatusBarEnabled()) {
        tokenCountStatusBarItem.show();
    }
    return tokenCountStatusBarItem;
}

/**
 * Whether the extension status bar should be shown at all.
 *
 * The status bar carries the plan-usage display (main text + tooltip section),
 * controlled by `showUsage`. It is hidden when that is disabled.
 */
function isStatusBarEnabled(): boolean {
    return isUsageEnabled();
}

/**
 * Show the status bar and cancel any pending auto-hide.
 * Called when a chat request starts using one of this extension's models.
 * Hidden when the plan-usage display is disabled.
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
 * 2026-10-10 改版：状态栏常态化显示，不再自动隐藏——本函数保留为空操作
 * 以兼容既有调用点（provider.ts 的 finally），后续可移除。
 */
export function scheduleStatusBarHide(statusBarItem: vscode.StatusBarItem, delayMs: number = STATUS_BAR_HIDE_DELAY_MS): void {
    if (statusBarHideTimer) {
        clearTimeout(statusBarHideTimer);
        statusBarHideTimer = null;
    }
    // No-op: the status bar is now always visible (常态化显示).
}

/**
 * Refresh the status bar (plan-usage main text + tooltip) for the current request.
 * @returns The estimated input token count (for fallback usage reporting).
 */
export async function updateContextStatusBar(
    messages: readonly LanguageModelChatRequestMessage[],
    tools: readonly LanguageModelChatTool[] | undefined,
    statusBarItem: vscode.StatusBarItem,
    modelConfig: { includeReasoningInRequest: boolean }
): Promise<number> {
    try {
        let totalTokens = 0;

        for (const message of messages) {
            totalTokens += await countMessageTokens(message, modelConfig);
        }

        if (tools && tools.length > 0) {
            totalTokens += await countToolTokens(tools);
        }

        // Plan usage owns the main text; refresh it and the tooltip.
        updateStatusBarUsageText(statusBarItem);
        updateStatusBarTooltip(statusBarItem);
        return totalTokens;
    } catch {
        return 0;
    }
}

/**
 * Update the status bar tooltip with the SenseAudio plan usage section
 * (if enabled and data is cached).
 *
 * 2026-10-10 改版：累计 Token 部分（↑/↓ 箭头行）已移除——VS Code 原生
 * 会话 Token 指示器已覆盖该信息，tooltip 仅保留套餐用量 + 余额。
 */
function updateStatusBarTooltip(statusBarItem: vscode.StatusBarItem): void {
    const lines: string[] = [];

    // SenseAudio plan usage + balance (optional)
    appendPlanUsageTooltipLines(lines);

    statusBarItem.tooltip = lines.length > 0 ? lines.join("\n") : l10n("Remaining Usage");
}
