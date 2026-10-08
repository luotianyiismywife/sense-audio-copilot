/**
 * apiKeyDisplay.ts — API Key 管理界面的**展示辅助**（纯函数，无副作用）。
 *
 * 从 `apiKeyManagerUi.ts` 拆出：余额格式化、账号信息查询、key 详情行构建、
 * key 列表 QuickPick 项构建。主界面 / key 选择界面 / 检测二级界面共用，
 * 保证展示逻辑只写一处。
 */
import * as vscode from "vscode";
import { l10n, l10nFormat } from "../core/localize";
import {
    getApiKeyMode,
    getKeyDisplayStatus,
    getRotationCursorIndex,
    getTransientExhaustedInfo,
    maskApiKey,
    pickAccountCredential,
    type ApiKeyEntry,
    type ApiKeyStore,
} from "../keys/keyManager";
import {
    getBalanceCheckIntervalSec,
    getMinBalanceCny,
    formatExpiryDate,
    getAccountInfoCached,
    type AccountInfo,
} from "../balance/balanceCheck";

/**
 * 格式化账号余额为显示文本：现金余额 + 代金券（含最早到期日）。
 *
 * 平台余额分「现金」与「代金券（限时）」两部分，分开显示（对应平台页面的
 * 「备用扣减 / 优先扣减」）。代金券可用 > 0 时附加最早到期日（如 "（至 2026-09-01）"）。
 *
 * 图标依据**合计可用余额**（现金 + 代金券）而非仅现金——用户余额通常主要在
 * 代金券里，只看现金会把「有 358 元代金券」误标为余额不足。
 */
export function formatBalanceDetailText(info: AccountInfo | undefined, minBalance: number): string {
    if (!info) {
        return "";
    }
    const cash = info.balance;
    const gift = info.voucherAvailableCny;
    const total = cash + gift;
    const cashIcon = total > minBalance ? "$(coin)" : "$(error)";
    const parts: string[] = [`${cashIcon} ${l10n("Recharge")} ¥${cash.toFixed(2)}`];
    if (gift > 0) {
        const expiry = formatExpiryDate(info.earliestVoucherExpiry);
        parts.push(`$(gift) ${l10n("Gift")} ¥${gift.toFixed(2)}${expiry ? l10nFormat(" (until {0})", expiry) : ""}`);
    }
    return parts.join(" · ");
}

/**
 * 查询账号余额（TTL 缓存）。
 *
 * 数据源：key 绑定的平台登录凭据（PASETO token）查
 * `platform.senseaudio.cn/api/user/self`（`getAccountInfoCached`）。
 * 余额按**账号**粒度，所有 key 共享同一份凭据（优先当前使用 key，
 * 否则第一个绑定了凭据的 key）。无凭据或查询失败 → undefined（UI 显示 "余额未知"）。
 */
export async function fetchAccountInfo(store: ApiKeyStore): Promise<AccountInfo | undefined> {
    const credential = pickAccountCredential(store);
    if (!credential) {
        return undefined;
    }
    return getAccountInfoCached(credential, getBalanceCheckIntervalSec());
}

/**
 * 构建单个 key 的详情行（与主页 render() 一致的展示）。
 *
 * 包含：可用性状态（可用/不可用/冷却倒计时/未检测）、账号余额、
 * 当前使用（★ Current，仅 single 模式）、固定使用（$(pinned)，仅 sticky 模式）、
 * 凭据绑定状态。删除/设为当前/编辑/绑定/清除凭据等 key 选择界面共用。
 */
export function buildKeyDetailLine(
    entry: ApiKeyEntry,
    balanceText: string,
    options: { isActive?: boolean; isPinned?: boolean } = {},
): string {
    const status = getKeyDisplayStatus(entry);
    const transient = getTransientExhaustedInfo(entry.value);
    let statusIcon = "$(question)";
    let statusText = l10n("Not checked");
    if (status === "available") {
        statusIcon = "$(check)";
        statusText = l10n("Available");
    } else if (status === "unavailable") {
        statusIcon = "$(error)";
        statusText = l10n("Unavailable");
    } else if (status === "cooldown" && transient) {
        statusIcon = "$(clock)";
        statusText = l10nFormat("Cooldown ({0}s)", String(transient.remainingSec));
    } else if (status === "cooldown") {
        statusIcon = "$(clock)";
        statusText = l10n("Cooldown");
    }
    return [
        `${statusIcon} ${statusText}`,
        balanceText,
        options.isActive ? `$(star) ${l10n("Current")}` : "",
        options.isPinned ? `$(pinned) ${l10n("Pinned")}` : "",
        entry.credential ? `$(key) ${l10n("Credential bound")}` : `$(key) ${l10n("Credential not bound")}`,
    ]
        .filter(Boolean)
        .join("  ·  ");
}

/**
 * 构建 key 列表的 QuickPick 项（label + 详情行），供主界面 `render()`、
 * key 选择界面 `pickKey()`、检测二级界面 `showCheckMenu()` 共用。
 *
 * 统一处理：账号余额查询（TTL 缓存）、模式判定（single/sticky 的当前/固定标记）、
 * 逐 key 详情行（`buildKeyDetailLine`）。展示逻辑只写一处。
 */
export async function buildKeyQuickPickItems(
    store: ApiKeyStore,
    action: string,
): Promise<(vscode.QuickPickItem & { action?: string; index?: number; entry?: ApiKeyEntry })[]> {
    // Balance display: account-level (all keys share one account).
    // Source: key credential → platform.senseaudio.cn/api/user/self.
    const accountInfo = await fetchAccountInfo(store);
    const balanceText = accountInfo
        ? formatBalanceDetailText(accountInfo, getMinBalanceCny())
        : `$(warning) ${l10n("Balance unknown")}`;
    // Current/pinned markers follow the same mode rules as the main interface.
    const keyMode = getApiKeyMode();
    const isSingleMode = keyMode === "single";
    const isStickyMode = keyMode === "sticky";
    const stickyCursor = isStickyMode ? getRotationCursorIndex() : -1;
    return store.keys.map((entry, i) => ({
        label: `${maskApiKey(entry.value)}${entry.label ? ` (${entry.label})` : ""}`,
        description: buildKeyDetailLine(entry, balanceText, {
            isActive: isSingleMode && i === store.activeIndex,
            isPinned: isStickyMode && i === stickyCursor,
        }),
        action,
        index: i,
        entry,
    }));
}
