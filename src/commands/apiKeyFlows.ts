/**
 * apiKeyFlows.ts — API Key 管理的各个**交互流程**（从 `apiKeyManagerUi.ts` 拆出）。
 *
 * 每个流程都是模块级函数，通过 `KeyManagerContext` 访问 SecretStorage 与登录 token，
 * 避免闭包耦合。主界面 `showApiKeyManager` 只负责渲染菜单与分发动作。
 */
import * as vscode from "vscode";
import { l10n, l10nFormat } from "../core/localize";
import {
    addApiKey,
    addApiKeys,
    getApiKeyStore,
    maskApiKey,
    maskCookie,
    removeApiKey,
    setKeyCookie,
    updateApiKey,
    updateKeyAvailability,
    type ApiKeyEntry,
} from "../keys/keyManager";
import {
    testKeyAvailability,
    getBalanceCheckIntervalSec,
    getMinBalanceCny,
    getAccountInfoCached,
} from "../balance/balanceCheck";
import { buildKeyQuickPickItems } from "./apiKeyDisplay";

/**
 * 流程上下文：SecretStorage + 登录 PASETO token 读写。
 *
 * 登录 token 存在 `globalState`（非 SecretStorage——token 本身是短期凭证，
 * 且需跨窗口共享），键名 `senseaudio.loginToken`。
 */
export interface KeyManagerContext {
    secrets: vscode.SecretStorage;
    getLoginToken: () => string | undefined;
    setLoginToken: (token: string | undefined) => Promise<void>;
}

/**
 * 查询余额/套餐用量流程（登录 token）。
 *
 * 无 token 时提示输入（F12 → Local Storage → user.state.token）；查询失败
 * （token 失效/网络）时提示重新输入并清空已存 token。
 */
export async function queryBalanceFlow(ctx: KeyManagerContext): Promise<void> {
    let token = ctx.getLoginToken();
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
        await ctx.setLoginToken(token);
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
            await ctx.setLoginToken(undefined);
            await queryBalanceFlow(ctx);
        }
        return;
    }
    // 展示余额（与上游一致：只显示余额，不做套餐重置）
    const lines: string[] = [];
    lines.push(l10nFormat("Voucher balance: ¥{0} ({1} vouchers)", info.voucherAvailableCny.toFixed(2), String(info.vouchers.filter((v) => v.available > 0).length)));
    lines.push(l10nFormat("Cash balance: ¥{0}", info.balance.toFixed(2)));
    vscode.window.showInformationMessage(lines.join("\n"), { modal: true });
}

/**
 * 添加单个 key 流程（依次输入 key → cookie → label 三元组）。
 * @returns 是否成功添加。
 */
export async function addKeyFlow(ctx: KeyManagerContext): Promise<boolean> {
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
    const added = await addApiKey(ctx.secrets, {
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
}

/**
 * 解析批量导入文本。
 *
 * 格式：`key---cookie---备注;key---cookie---备注;`
 * - 条目之间用 `;` 分隔（末尾分号可省略）
 * - 每条内三个字段用 `---` 分隔，顺序固定为 key / cookie / 备注
 * - 字段可留空（如 `sk_xxx------备用` 表示无 cookie）
 * - 备注中若含 `---`，会被完整保留（只按前两个分隔符切分）
 * - 空条目、缺 key 的条目会被跳过
 *
 * @returns 解析出的三元组数组（可能为空）。
 */
export function parseBatchImport(text: string): { value: string; cookie?: string; label?: string }[] {
    const out: { value: string; cookie?: string; label?: string }[] = [];
    for (const raw of text.split(";")) {
        const seg = raw.trim();
        if (!seg) {
            continue;
        }
        const parts = seg.split("---");
        const value = (parts[0] ?? "").trim();
        if (!value) {
            continue;
        }
        const cookie = (parts[1] ?? "").trim() || undefined;
        // Re-join the remainder so a label containing "---" survives intact.
        const label = parts.slice(2).join("---").trim() || undefined;
        out.push({ value, cookie, label });
    }
    return out;
}

/**
 * 批量导入流程：单行文本输入，格式 `key---cookie---备注;key---cookie---备注;`。
 *
 * 解析后先弹确认框（列出脱敏条目），确认后 `addApiKeys` 一次性写入；
 * 已存在的 key 自动更新 cookie（不重复添加）。
 */
export async function batchImportFlow(ctx: KeyManagerContext): Promise<void> {
    const input = await vscode.window.showInputBox({
        title: l10n("Import API Keys (batch)"),
        prompt: l10n("Format: key---cookie---label;key---cookie---label; (leave a field empty if unused)"),
        placeHolder: "sk_xxx---sess_yyy---work;sk_zzz------backup;",
        ignoreFocusOut: true,
    });
    if (input === undefined || !input.trim()) {
        return;
    }

    const entries = parseBatchImport(input);
    if (entries.length === 0) {
        vscode.window.showWarningMessage(l10n("No valid entries found"));
        return;
    }

    // Confirmation preview (masked) so a malformed paste is caught before writing.
    const preview = entries
        .map((e) => `${maskApiKey(e.value)}${e.label ? ` (${e.label})` : ""}${e.cookie ? `  $(key) ${maskCookie(e.cookie)}` : ""}`)
        .join("\n");
    const confirm = await vscode.window.showWarningMessage(
        l10nFormat("Import {0} API key(s)?", String(entries.length)),
        { modal: true, detail: preview },
        l10n("Import API Keys (batch)")
    );
    if (confirm !== l10n("Import API Keys (batch)")) {
        return;
    }

    const { added, updated } = await addApiKeys(ctx.secrets, entries);
    if (added > 0 || updated > 0) {
        vscode.window.showInformationMessage(
            l10nFormat("Imported {0} API keys ({1} cookies updated)", String(added), String(updated))
        );
    } else {
        vscode.window.showInformationMessage(l10n("No changes (keys already exist with same cookies)"));
    }
}

/**
 * 删除 key 流程：多选 + 循环，直到用户返回。
 *
 * - 支持一次勾选多个 key（`canPickMany`）
 * - 删除后**停留在本界面**并刷新列表，可继续删除
 * - 提供「返回」项；按 ESC 或选中「返回」即回到主菜单
 */
export async function deleteKeysFlow(ctx: KeyManagerContext): Promise<void> {
    while (true) {
        const store = await getApiKeyStore(ctx.secrets);
        if (store.keys.length === 0) {
            vscode.window.showInformationMessage(l10n("No API keys configured"));
            return;
        }
        const items: (vscode.QuickPickItem & { action?: string; index?: number })[] = [
            ...(await buildKeyQuickPickItems(store, ctx.getLoginToken, "delete")),
            { label: "", kind: vscode.QuickPickItemKind.Separator },
            { label: `$(arrow-left) ${l10n("Back")}`, action: "back" },
        ];

        const picked = await vscode.window.showQuickPick(items, {
            title: l10n("Delete API Key"),
            placeHolder: l10n("Select one or more keys to delete (Esc to go back)"),
            canPickMany: true,
            ignoreFocusOut: true,
        });
        // Esc / nothing selected → back to the main menu.
        if (!picked || picked.length === 0) {
            return;
        }
        // "Back" selected → back to the main menu.
        if (picked.some((p) => (p as { action?: string }).action === "back")) {
            return;
        }

        const indices = picked
            .map((p) => (p as { index?: number }).index)
            .filter((i): i is number => typeof i === "number")
            // Descending order so earlier removals don't shift later indices.
            .sort((a, b) => b - a);
        if (indices.length === 0) {
            return;
        }

        const names = indices.map((i) => maskApiKey(store.keys[i].value)).join(", ");
        const confirm = await vscode.window.showWarningMessage(
            l10nFormat("Confirm delete {0} API key(s)?", String(indices.length)),
            { modal: true, detail: names },
            l10n("Delete API Key")
        );
        if (confirm !== l10n("Delete API Key")) {
            continue; // stay in the delete screen
        }
        for (const idx of indices) {
            await removeApiKey(ctx.secrets, idx);
        }
        vscode.window.showInformationMessage(l10nFormat("Deleted {0} API key(s)", String(indices.length)));
        // Loop again to show the refreshed list.
    }
}

/**
 * 选择一个 key（删除/设为当前/编辑/绑定/清除 cookie 共用）。
 *
 * 复用主界面同款 QuickPick 项（可用性状态 + 余额 + 当前/固定标记 + cookie 绑定），
 * 让用户在删除/编辑前能区分各个 key。
 */
export async function pickKey(
    ctx: KeyManagerContext,
    title: string,
): Promise<{ index: number; entry: ApiKeyEntry } | undefined> {
    const store = await getApiKeyStore(ctx.secrets);
    if (store.keys.length === 0) {
        vscode.window.showInformationMessage(l10n("No API keys configured"));
        return undefined;
    }
    const picked = await vscode.window.showQuickPick(
        await buildKeyQuickPickItems(store, ctx.getLoginToken, "select"),
        { title, ignoreFocusOut: true }
    );
    if (!picked) {
        return undefined;
    }
    return { index: picked.index as number, entry: picked.entry as ApiKeyEntry };
}

/**
 * 检测单个 key 的可用性（最小真实聊天请求），并更新其可用状态。
 */
export async function checkAvailabilityFlow(ctx: KeyManagerContext, index: number): Promise<void> {
    const store = await getApiKeyStore(ctx.secrets);
    const entry = store.keys[index];
    if (!entry) {
        return;
    }
    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: l10n("Checking availability...") },
        async () => {
            const result = await testKeyAvailability(entry);
            if (result.ok === true) {
                await updateKeyAvailability(ctx.secrets, entry.value, true);
                vscode.window.showInformationMessage(l10n("Key is available"));
            } else if (result.ok === false) {
                await updateKeyAvailability(ctx.secrets, entry.value, false);
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
}

/**
 * 检测全部 key 的可用性（带进度条），并汇总结果。
 */
export async function checkAllAvailabilityFlow(ctx: KeyManagerContext): Promise<void> {
    const store = await getApiKeyStore(ctx.secrets);
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
                    await updateKeyAvailability(ctx.secrets, entry.value, true);
                    available++;
                } else if (result.ok === false) {
                    await updateKeyAvailability(ctx.secrets, entry.value, false);
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
}

/**
 * 检测可用性二级界面：列出全部 key 状态 + "检测所有" + "查询余额" + "返回"。
 */
export async function showCheckMenu(ctx: KeyManagerContext): Promise<void> {
    while (true) {
        const store = await getApiKeyStore(ctx.secrets);
        const items: (vscode.QuickPickItem & { action?: string; index?: number })[] = [];

        // List all keys with their current status (same detail line as the
        // main interface: availability + cooldown countdown + balance + cookie).
        items.push(...(await buildKeyQuickPickItems(store, ctx.getLoginToken, "checkOne")));

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
            await checkAvailabilityFlow(ctx, index);
            // Refresh the menu after checking
            continue;
        } else if (action === "checkAll") {
            await checkAllAvailabilityFlow(ctx);
            continue;
        } else if (action === "queryBalance") {
            await queryBalanceFlow(ctx);
            continue;
        } else {
            return; // back or cancel
        }
    }
}

/**
 * 绑定/更新 cookie 流程（空输入 = 清除）。
 */
export async function bindCookieFlow(ctx: KeyManagerContext, index: number): Promise<void> {
    const store = await getApiKeyStore(ctx.secrets);
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
    await setKeyCookie(ctx.secrets, index, cookie.trim() || undefined);
    vscode.window.showInformationMessage(cookie.trim() ? l10n("Cookie updated") : l10n("Cookie cleared"));
}

/**
 * 编辑 key 流程（value / cookie / label 三字段，冲突校验）。
 */
export async function editKeyFlow(ctx: KeyManagerContext, index: number): Promise<void> {
    const store = await getApiKeyStore(ctx.secrets);
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

    const result = await updateApiKey(ctx.secrets, index, {
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
}
