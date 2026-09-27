import * as vscode from "vscode";
import { l10n, l10nFormat } from "../core/localize";
import {
    addApiKey,
    addApiKeys,
    getApiKeyMode,
    getApiKeyStore,
    getKeyDisplayStatus,
    getRotationCursorIndex,
    getTransientExhaustedInfo,
    maskApiKey,
    maskCookie,
    removeApiKey,
    resetExhaustedKeys,
    setActiveKey,
    setKeyCookie,
    updateApiKey,
    updateKeyAvailability,
    type ApiKeyEntry,
} from "../keys/keyManager";
import {
    testKeyAvailability,
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
 * 数据源：登录 PASETO token 查 `platform.senseaudio.cn/api/user/self`
 * （`getAccountInfoCached`）。余额按**账号**粒度，所有 key 共享同一份。
 * 无登录 token 或查询失败 → undefined（UI 显示 "余额未知"）。
 */
export async function fetchAccountInfo(
    getLoginToken: () => string | undefined,
): Promise<AccountInfo | undefined> {
    const token = getLoginToken();
    if (!token) {
        return undefined;
    }
    return getAccountInfoCached(token, getBalanceCheckIntervalSec());
}

/**
 * API Key 管理 QuickPick。
 * 支持：添加 / 批量导入 / 删除 / 设为当前使用 / 编辑 / 重置失效状态 /
 * 绑定或清除 cookie / 检测可用性 / 查询余额。
 * 所有 key 与 cookie 均以脱敏形式展示。
 */
export async function showApiKeyManager(context: vscode.ExtensionContext): Promise<void> {
    const secrets = context.secrets;

    // 登录 PASETO token（60 天有效，查余额/套餐用量用）。
    // 存在 globalState（非 SecretStorage——token 本身是短期凭证，且需跨窗口共享）。
    const getLoginToken = (): string | undefined => context.globalState.get<string>("senseaudio.loginToken");
    const setLoginToken = async (token: string | undefined): Promise<void> => {
        await context.globalState.update("senseaudio.loginToken", token);
    };

    // ---- 查询余额/套餐用量流程（登录 token）----
    const queryBalanceFlow = async (): Promise<void> => {
        let token = getLoginToken();
        if (!token) {
            const input = await vscode.window.showInputBox({
                title: l10n("Query Balance / Plan Usage"),
                prompt: l10n("Enter the login PASETO token (F12 → Application → Local Storage → senseaudio.cn → user → state.token, valid 60 days)"),
                ignoreFocusOut: true,
                password: true,
            });
            if (!input?.trim()) {
                return;
            }
            token = input.trim();
            await setLoginToken(token);
        }
        const info = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: l10n("Querying balance...") },
            () => getAccountInfoCached(token!, getBalanceCheckIntervalSec()),
        );
        if (!info) {
            // 查询失败（token 失效/网络）→ 提示重新输入
            const retry = await vscode.window.showWarningMessage(
                l10n("Failed to query balance (token may be expired)"),
                l10n("Re-enter token"),
            );
            if (retry) {
                await setLoginToken(undefined);
                await queryBalanceFlow();
            }
            return;
        }
        // 展示余额（与上游一致：只显示余额，不做套餐重置）
        const lines: string[] = [];
        lines.push(l10nFormat("Voucher balance: ¥{0} ({1} vouchers)", info.voucherAvailableCny.toFixed(2), String(info.vouchers.filter((v) => v.available > 0).length)));
        lines.push(l10nFormat("Cash balance: ¥{0}", info.balance.toFixed(2)));
        vscode.window.showInformationMessage(lines.join("\n"), { modal: true });
    };

    const render = async (): Promise<vscode.QuickPickItem[] | undefined> => {
        const store = await getApiKeyStore(secrets);
        // "Set as Current" / ★ Current marker only make sense in single mode;
        // in rotation mode they are hidden entirely. In sticky mode the pinned
        // key (rotation cursor) is shown as a read-only $(pinned) marker.
        const keyMode = getApiKeyMode();
        const isSingleMode = keyMode === "single";
        const isStickyMode = keyMode === "sticky";
        const stickyCursor = isStickyMode ? getRotationCursorIndex() : -1;
        const items: (vscode.QuickPickItem & { action?: string; index?: number })[] = [];

        if (store.keys.length === 0) {
            items.push({ label: l10n("No API keys configured"), kind: vscode.QuickPickItemKind.Separator });
        } else {
            // Balance display: account-level (all keys share one account).
            // Source: login token → platform.senseaudio.cn/api/user/self.
            const accountInfo = await fetchAccountInfo(getLoginToken);
            const balanceText = accountInfo
                ? formatBalanceDetailText(accountInfo, getMinBalanceCny())
                : `$(warning) ${l10n("Balance unknown")}`;
            store.keys.forEach((entry, i) => {
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
                }
                const isActive = isSingleMode && i === store.activeIndex;
                const isPinned = isStickyMode && i === stickyCursor;
                const detailLine = [
                    `${statusIcon} ${statusText}`,
                    balanceText,
                    isActive ? `$(star) ${l10n("Current")}` : "",
                    isPinned ? `$(pinned) ${l10n("Pinned")}` : "",
                    entry.cookie ? `$(key) ${l10n("Cookie bound")}` : `$(key) ${l10n("Cookie not bound")}`,
                ]
                    .filter(Boolean)
                    .join("  ·  ");
                items.push({
                    label: `${maskApiKey(entry.value)}${entry.label ? ` (${entry.label})` : ""}`,
                    description: detailLine,
                    action: "select",
                    index: i,
                });
            });
        }

        items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
        items.push({ label: `$(plus) ${l10n("Add API Key")}`, action: "add" });
        items.push({ label: `$(import) ${l10n("Import API Keys (batch)")}`, action: "import" });
        if (store.keys.length > 0) {
            items.push({ label: `$(trash) ${l10n("Delete API Key")}`, action: "delete" });
            // "Set as Current" only matters in single mode — hide it entirely in rotation mode.
            if (isSingleMode) {
                items.push({ label: `$(star) ${l10n("Set as Current")}`, action: "setActive" });
            }
            items.push({ label: `$(edit) ${l10n("Edit API Key")}`, action: "edit" });
            items.push({ label: `$(refresh) ${l10n("Reset Exhausted States")}`, action: "reset" });
            items.push({ label: `$(beaker) ${l10n("Check Availability")}`, action: "check" });
            items.push({ label: `$(link) ${l10n("Bind/Update Cookie")}`, action: "bindCookie" });
            items.push({ label: `$(unlink) ${l10n("Clear Cookie")}`, action: "clearCookie" });
        }
        return items;
    };

    // ---- Add key flow ----
    const addKeyFlow = async (): Promise<boolean> => {
        const keyValue = await vscode.window.showInputBox({
            title: l10n("Add API Key"),
            prompt: l10n("Enter your SenseAudio API key"),
            ignoreFocusOut: true,
            password: true,
        });
        if (keyValue === undefined || !keyValue.trim()) {
            return false;
        }
        const trimmed = keyValue.trim();
        // Unified triple order: key → cookie → label (matches batch import & edit).
        const cookie = await vscode.window.showInputBox({
            title: l10n("Add API Key"),
            prompt: l10n("Enter the tr_session cookie for this key (optional)"),
            ignoreFocusOut: true,
            password: true,
        });
        const label = await vscode.window.showInputBox({
            title: l10n("Add API Key"),
            prompt: l10n("Enter an optional label for this key"),
            ignoreFocusOut: true,
        });
        const added = await addApiKey(secrets, {
            value: trimmed,
            label: label?.trim() || undefined,
            cookie: cookie?.trim() || undefined,
            available: null,
        });
        if (!added) {
            vscode.window.showWarningMessage(l10n("API key already exists"));
            return false;
        }
        vscode.window.showInformationMessage(l10n("API key added"));
        return true;
    };

    // ---- Batch import flow: QuickPick list of (key/cookie/label) triples ----
    const batchImportFlow = async (): Promise<void> => {
        interface ImportTriple {
            value: string;
            cookie?: string;
            label?: string;
        }
        const pending: ImportTriple[] = [];

        // Render current pending list + actions
        const renderImport = (): vscode.QuickPickItem[] => {
            const items: (vscode.QuickPickItem & { action?: string; index?: number })[] = [];
            if (pending.length === 0) {
                items.push({ label: l10n("No entries yet — click below to add a triple"), kind: vscode.QuickPickItemKind.Separator });
            } else {
                pending.forEach((t, i) => {
                    items.push({
                        label: `${maskApiKey(t.value)}${t.label ? ` (${t.label})` : ""}`,
                        description: t.cookie ? `$(key) ${maskCookie(t.cookie)}` : l10n("Cookie not bound"),
                        action: "remove",
                        index: i,
                    });
                });
            }
            items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
            items.push({ label: `$(plus) ${l10n("Add a triple (key/cookie/label)")}`, action: "addTriple" });
            if (pending.length > 0) {
                items.push({ label: `$(check) ${l10n("Finish import")}`, action: "finish" });
                items.push({ label: `$(trash) ${l10n("Remove entry")}`, action: "remove" });
            }
            items.push({ label: `$(arrow-left) ${l10n("Cancel import")}`, action: "cancel" });
            return items;
        };

        while (true) {
            const picked = await vscode.window.showQuickPick(renderImport(), {
                title: l10n("Import API Keys (batch)"),
                placeHolder: l10n("Add triples, then finish import"),
                ignoreFocusOut: true,
            });
            if (!picked) {
                return; // canceled
            }
            const action = (picked as { action?: string }).action;
            const index = (picked as { index?: number }).index;

            if (action === "addTriple") {
                // Input key
                const key = await vscode.window.showInputBox({
                    title: l10n("Add a triple (key/cookie/label)"),
                    prompt: l10n("Enter the API key"),
                    ignoreFocusOut: true,
                    password: true,
                });
                if (key === undefined || !key.trim()) {
                    continue;
                }
                // Input cookie (optional)
                const cookie = await vscode.window.showInputBox({
                    title: l10n("Add a triple (key/cookie/label)"),
                    prompt: l10n("Enter the tr_session cookie (optional)"),
                    ignoreFocusOut: true,
                    password: true,
                });
                if (cookie === undefined) {
                    continue;
                }
                // Input label (optional)
                const label = await vscode.window.showInputBox({
                    title: l10n("Add a triple (key/cookie/label)"),
                    prompt: l10n("Enter an optional label (optional)"),
                    ignoreFocusOut: true,
                });
                if (label === undefined) {
                    continue;
                }
                pending.push({
                    value: key.trim(),
                    cookie: cookie.trim() || undefined,
                    label: label.trim() || undefined,
                });
            } else if (action === "remove" && typeof index === "number") {
                pending.splice(index, 1);
            } else if (action === "finish") {
                if (pending.length === 0) {
                    return;
                }
                const { added, updated } = await addApiKeys(secrets, pending);
                if (added > 0 || updated > 0) {
                    vscode.window.showInformationMessage(
                        l10nFormat("Imported {0} API keys ({1} cookies updated)", String(added), String(updated))
                    );
                } else {
                    vscode.window.showInformationMessage(l10n("No changes (keys already exist with same cookies)"));
                }
                return;
            } else if (action === "cancel") {
                return;
            }
        }
    };

    // ---- Select a key (for delete/setActive/check/bind/clear) ----
    // Shows the same recharge/gift balance + gift expiry info as the main
    // interface so users can tell keys apart by their balance, not just the
    // last few chars of the key/cookie.
    const pickKey = async (title: string): Promise<{ index: number; entry: ApiKeyEntry } | undefined> => {
        const store = await getApiKeyStore(secrets);
        if (store.keys.length === 0) {
            vscode.window.showInformationMessage(l10n("No API keys configured"));
            return undefined;
        }
        // Balance display: account-level (all keys share one account).
        const accountInfo = await fetchAccountInfo(getLoginToken);
        const balanceText = accountInfo
            ? formatBalanceDetailText(accountInfo, getMinBalanceCny())
            : `$(warning) ${l10n("Balance unknown")}`;
        const picked = await vscode.window.showQuickPick(
            store.keys.map((entry, i) => {
                const desc = [
                    entry.cookie ? `$(key) ${maskCookie(entry.cookie)}` : undefined,
                    balanceText || undefined,
                ]
                    .filter(Boolean)
                    .join("  ·  ");
                return {
                    label: `${maskApiKey(entry.value)}${entry.label ? ` (${entry.label})` : ""}`,
                    description: desc || undefined,
                    index: i,
                    entry,
                };
            }),
            { title, ignoreFocusOut: true }
        );
        if (!picked) {
            return undefined;
        }
        return { index: picked.index as number, entry: picked.entry as ApiKeyEntry };
    };

    // ---- Check availability flow (single key) ----
    const checkAvailabilityFlow = async (index: number): Promise<void> => {
        const store = await getApiKeyStore(secrets);
        const entry = store.keys[index];
        if (!entry) {
            return;
        }
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: l10n("Checking availability...") },
            async () => {
                const result = await testKeyAvailability(entry);
                if (result.ok === true) {
                    await updateKeyAvailability(secrets, entry.value, true);
                    vscode.window.showInformationMessage(l10n("Key is available"));
                } else if (result.ok === false) {
                    await updateKeyAvailability(secrets, entry.value, false);
                    if (result.reason === "balance") {
                        vscode.window.showWarningMessage(
                            l10nFormat("Key balance is insufficient (≤ {0} CNY)", String(getMinBalanceCny()))
                        );
                    } else {
                        vscode.window.showWarningMessage(l10n("Key is invalid (401)"));
                    }
                } else {
                    vscode.window.showWarningMessage(l10n("Unable to determine availability, please retry later"));
                }
            }
        );
    };

    // ---- Check availability flow (ALL keys) ----
    const checkAllAvailabilityFlow = async (): Promise<void> => {
        const store = await getApiKeyStore(secrets);
        if (store.keys.length === 0) {
            vscode.window.showInformationMessage(l10n("No API keys configured"));
            return;
        }
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: l10n("Checking availability of all keys..."),
                cancellable: false,
            },
            async (progress) => {
                let available = 0;
                let unavailable = 0;
                let unknown = 0;
                for (let i = 0; i < store.keys.length; i++) {
                    const entry = store.keys[i];
                    if (progress) {
                        progress.report({ message: l10nFormat("Checking {0}/{1}: {2}", String(i + 1), String(store.keys.length), maskApiKey(entry.value)) });
                    }
                    const result = await testKeyAvailability(entry);
                    if (result.ok === true) {
                        await updateKeyAvailability(secrets, entry.value, true);
                        available++;
                    } else if (result.ok === false) {
                        await updateKeyAvailability(secrets, entry.value, false);
                        unavailable++;
                    } else {
                        unknown++;
                    }
                }
                vscode.window.showInformationMessage(
                    l10nFormat("Availability check done: {0} available, {1} unavailable, {2} unknown", String(available), String(unavailable), String(unknown))
                );
            }
        );
    };

    // ---- Check availability menu (sub-menu with "Check All" option) ----
    const showCheckMenu = async (): Promise<void> => {
        while (true) {
            const store = await getApiKeyStore(secrets);
            const items: (vscode.QuickPickItem & { action?: string; index?: number })[] = [];

            // Balance display: account-level (all keys share one account).
            const accountInfo = await fetchAccountInfo(getLoginToken);
            const balanceText = accountInfo
                ? formatBalanceDetailText(accountInfo, getMinBalanceCny())
                : `$(warning) ${l10n("Balance unknown")}`;

            // List all keys with their current status
            store.keys.forEach((entry, i) => {
                const status = getKeyDisplayStatus(entry);
                let statusText = l10n("Not checked");
                if (status === "available") statusText = `$(check) ${l10n("Available")}`;
                else if (status === "unavailable") statusText = `$(error) ${l10n("Unavailable")}`;
                else if (status === "cooldown") statusText = `$(clock) ${l10n("Cooldown")}`;
                const statusLine = [statusText, balanceText].filter(Boolean).join("  ·  ");
                items.push({
                    label: `${maskApiKey(entry.value)}${entry.label ? ` (${entry.label})` : ""}`,
                    description: statusLine,
                    action: "checkOne",
                    index: i,
                });
            });

            items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
            items.push({ label: `$(beaker) ${l10n("Check All Availability")}`, action: "checkAll" });
            items.push({ label: `$(coin) ${l10n("Query Balance / Plan Usage")}`, action: "queryBalance" });
            items.push({ label: `$(arrow-left) ${l10n("Back")}`, action: "back" });

            const picked = await vscode.window.showQuickPick(items, {
                title: l10n("Check Availability"),
                placeHolder: l10n("Select a key to check, or check all"),
                ignoreFocusOut: true,
            });
            if (!picked) {
                return;
            }
            const action = (picked as { action?: string }).action;
            const index = (picked as { index?: number }).index;

            if (action === "checkOne" && typeof index === "number") {
                await checkAvailabilityFlow(index);
                // Refresh the menu after checking
                continue;
            } else if (action === "checkAll") {
                await checkAllAvailabilityFlow();
                continue;
            } else if (action === "queryBalance") {
                await queryBalanceFlow();
                continue;
            } else {
                return; // back or cancel
            }
        }
    };

    // ---- Cookie binding flow ----
    const bindCookieFlow = async (index: number): Promise<void> => {
        const store = await getApiKeyStore(secrets);
        const entry = store.keys[index];
        if (!entry) {
            return;
        }
        const cookie = await vscode.window.showInputBox({
            title: l10n("Bind/Update Cookie"),
            prompt: l10n("Enter the tr_session cookie value for this key"),
            ignoreFocusOut: true,
            password: true,
            value: entry.cookie ?? "",
        });
        if (cookie === undefined) {
            return;
        }
        await setKeyCookie(secrets, index, cookie.trim() || undefined);
        vscode.window.showInformationMessage(cookie.trim() ? l10n("Cookie updated") : l10n("Cookie cleared"));
    };

    // ---- Edit API key flow (value / cookie / label) ----
    const editKeyFlow = async (index: number): Promise<void> => {
        const store = await getApiKeyStore(secrets);
        const entry = store.keys[index];
        if (!entry) {
            return;
        }

        // 1. Key value (editable; conflicts checked on save)
        const newValue = await vscode.window.showInputBox({
            title: l10n("Edit API Key"),
            prompt: l10n("Edit the API key value (leave unchanged to keep)"),
            ignoreFocusOut: true,
            password: true,
            value: entry.value,
        });
        if (newValue === undefined) {
            return;
        }

        // 2. Cookie
        const newCookie = await vscode.window.showInputBox({
            title: l10n("Edit API Key"),
            prompt: l10n("Edit the tr_session cookie (empty to clear)"),
            ignoreFocusOut: true,
            password: true,
            value: entry.cookie ?? "",
        });
        if (newCookie === undefined) {
            return;
        }

        // 3. Label
        const newLabel = await vscode.window.showInputBox({
            title: l10n("Edit API Key"),
            prompt: l10n("Edit the label (empty to clear)"),
            ignoreFocusOut: true,
            value: entry.label ?? "",
        });
        if (newLabel === undefined) {
            return;
        }

        const result = await updateApiKey(secrets, index, {
            value: newValue.trim(),
            cookie: newCookie.trim(),
            label: newLabel.trim(),
        });
        if (result.ok) {
            vscode.window.showInformationMessage(l10n("API key updated"));
        } else if (result.conflict) {
            vscode.window.showWarningMessage(l10n("API key value conflicts with another existing key"));
        } else {
            vscode.window.showWarningMessage(l10n("Failed to update API key"));
        }
    };

    // ---- Main loop ----
    while (true) {
        const items = await render();
        if (!items) {
            return;
        }
        const picked = await vscode.window.showQuickPick(items, {
            title: l10n("Select an API key to manage"),
            placeHolder: l10n("Select an API key to manage"),
            ignoreFocusOut: true,
        });
        if (!picked) {
            return; // canceled
        }
        const pickedAction = (picked as { action?: string }).action;
        if (!pickedAction) {
            return; // selected nothing actionable
        }

        switch (pickedAction) {
            case "add": {
                await addKeyFlow();
                break;
            }
            case "import": {
                await batchImportFlow();
                break;
            }
            case "delete": {
                const keyPick = await pickKey(l10n("Delete API Key"));
                if (!keyPick) {
                    break;
                }
                const confirm = await vscode.window.showWarningMessage(
                    l10nFormat("Confirm delete API key {0}?", maskApiKey(keyPick.entry.value)),
                    { modal: true },
                    l10n("Delete API Key")
                );
                if (confirm === l10n("Delete API Key")) {
                    await removeApiKey(secrets, keyPick.index);
                    vscode.window.showInformationMessage(l10n("API key deleted"));
                }
                break;
            }
            case "setActive": {
                // "Set as Current" only takes effect in single mode; in rotation
                // mode the active index is ignored (round-robin cursor is used).
                if (getApiKeyMode() !== "single") {
                    vscode.window.showInformationMessage(l10n("Set as Current is only valid in single mode (apiKeyMode=single)"));
                    break;
                }
                const keyPick = await pickKey(l10n("Set as Current"));
                if (!keyPick) {
                    break;
                }
                await setActiveKey(secrets, keyPick.index);
                vscode.window.showInformationMessage(l10n("Set as current API key"));
                break;
            }
            case "edit": {
                const keyPick = await pickKey(l10n("Edit API Key"));
                if (!keyPick) {
                    break;
                }
                await editKeyFlow(keyPick.index);
                break;
            }
            case "reset": {
                await resetExhaustedKeys(secrets, true);
                vscode.window.showInformationMessage(l10n("Reset exhausted key states"));
                break;
            }
            case "check": {
                await showCheckMenu();
                break;
            }
            case "bindCookie": {
                const keyPick = await pickKey(l10n("Bind/Update Cookie"));
                if (!keyPick) {
                    break;
                }
                await bindCookieFlow(keyPick.index);
                break;
            }
            case "clearCookie": {
                const keyPick = await pickKey(l10n("Clear Cookie"));
                if (!keyPick) {
                    break;
                }
                await setKeyCookie(secrets, keyPick.index, undefined);
                vscode.window.showInformationMessage(l10n("Cookie cleared"));
                break;
            }
            default:
                return;
        }
    }
}
