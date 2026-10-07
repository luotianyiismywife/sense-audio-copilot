import * as vscode from "vscode";
import { l10n, l10nFormat } from "../core/localize";
import { logger } from "../core/logger";
import {
    formatBalanceSummary,
    formatUsageSummary,
    getPlanUsageFetchStatus,
} from "../balance/balanceCheck";
import { refreshPlanUsageNow } from "../ui/statusBar";

/**
 * 套餐用量查询命令（`senseaudio.checkUsage`）。
 *
 * 强制刷新套餐用量（绕过 TTL）并弹窗展示 5h/周/月三窗口使用率 + 余额。
 * 同时绑定到状态栏条目点击（见 `ui/statusBar.ts` 的 `command` 设置）。
 *
 * 错误区分（对标上游 `checkUsage`）：
 * - 未配置登录 token → 提示先配置
 * - 401（token 失效）→ 提示重新从浏览器复制
 * - 其他失败 → 提示查看输出通道
 */
export async function checkUsageCommand(context: vscode.ExtensionContext): Promise<void> {
    const token = context.globalState.get<string>("senseaudio.loginToken");
    if (!token) {
        // 无 token 时静默返回（不弹输入框/不跳转——与上游 TokenRhythm 一致，
        // 余额显示依赖已配置的 token，未配置时状态栏显示 "--"）。
        logger.debug("planUsage.checkUsage.skip", { reason: "no-token" });
        return;
    }

    const snapshot = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: l10n("Querying plan usage...") },
        () => refreshPlanUsageNow(),
    );
    const status = getPlanUsageFetchStatus();

    // The refresh failed. `refreshPlanUsageNow` returns the last good snapshot
    // (stale-cache fallback), so a non-null snapshot does NOT mean the data is
    // fresh — surface the failure instead of silently showing stale numbers.
    if (status !== "ok") {
        logger.warn("planUsage.checkUsage.failed", { status, hasStale: snapshot !== null });
        if (status === "unauthorized") {
            vscode.window.showErrorMessage(
                l10n("Login token expired. Copy a fresh token from the browser (F12 → Application → Local Storage → senseaudio.cn → user → state.token)."),
            );
        } else {
            vscode.window.showErrorMessage(l10n("Failed to fetch plan usage. See the SenseAudio output channel for details."));
        }
        return;
    }

    if (!snapshot) {
        // status === "ok" but no snapshot: the account has no usage windows.
        vscode.window.showWarningMessage(l10n("No plan usage data available for this account."));
        return;
    }

    const usage = formatUsageSummary(snapshot);
    const balance = formatBalanceSummary(snapshot);
    const message = usage
        ? l10nFormat("Plan usage: {0}  ·  Balance: {1}", usage, balance)
        : l10nFormat("Balance: {0}", balance);
    vscode.window.showInformationMessage(`SenseAudio — ${message}`);
}
