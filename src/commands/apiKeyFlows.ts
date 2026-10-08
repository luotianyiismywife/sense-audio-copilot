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
    maskCredential,
    removeApiKey,
    setKeyCredential,
    updateApiKey,
    updateKeyAvailability,
    type ApiKeyEntry,
} from "../keys/keyManager";
import {
    testKeyAvailability,
    getMinBalanceCny,
} from "../balance/balanceCheck";
import { buildKeyQuickPickItems } from "./apiKeyDisplay";

/**
 * 流程上下文：SecretStorage。
 *
 * 平台登录凭据（PASETO token）随 key 一起存在 SecretStorage 的 store 中
 * （`ApiKeyEntry.credential`），不再单独存 globalState。
 */
export interface KeyManagerContext {
    secrets: vscode.SecretStorage;
}

/**
 * 添加单个 key 流程（依次输入 key → 凭据 → label 三元组）。
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
    // Unified triple order: key → credential → label (matches batch import & edit).
    const credential = await vscode.window.showInputBox({
        title: l10n("Add API Key"),
        prompt: l10n("Enter the platform login credential for this key (optional)"),
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
        credential: credential?.trim() || undefined,
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
 * 格式：`key---credential---备注;key---credential---备注;`
 * - 条目之间用 `;` 分隔（末尾分号可省略）
 * - 每条内三个字段用 `---` 分隔，顺序固定为 key / credential / 备注
 * - 字段可留空（如 `sk_xxx------备用` 表示无凭据）
 * - 备注中若含 `---`，会被完整保留（只按前两个分隔符切分）
 * - 空条目、缺 key 的条目会被跳过
 *
 * @returns 解析出的三元组数组（可能为空）。
 */
export function parseBatchImport(text: string): { value: string; credential?: string; label?: string }[] {
    const out: { value: string; credential?: string; label?: string }[] = [];
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
        const credential = (parts[1] ?? "").trim() || undefined;
        // Re-join the remainder so a label containing "---" survives intact.
        const label = parts.slice(2).join("---").trim() || undefined;
        out.push({ value, credential, label });
    }
    return out;
}

/**
 * 批量导入流程：单行文本输入，格式 `key---credential---备注;key---credential---备注;`。
 *
 * 解析后先弹确认框（列出脱敏条目），确认后 `addApiKeys` 一次性写入；
 * 已存在的 key 自动更新凭据（不重复添加）。
 */
export async function batchImportFlow(ctx: KeyManagerContext): Promise<void> {
    const input = await vscode.window.showInputBox({
        title: l10n("Import API Keys (batch)"),
        prompt: l10n("Format: key---credential---label;key---credential---label; (leave a field empty if unused)"),
        placeHolder: "sk_xxx---v2.public.xxx---work;sk_zzz------backup;",
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
        .map((e) => `${maskApiKey(e.value)}${e.label ? ` (${e.label})` : ""}${e.credential ? `  $(key) ${maskCredential(e.credential)}` : ""}`)
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
            l10nFormat("Imported {0} API keys ({1} credentials updated)", String(added), String(updated))
        );
    } else {
        vscode.window.showInformationMessage(l10n("No changes (keys already exist with same credentials)"));
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
            ...(await buildKeyQuickPickItems(store, "delete")),
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
 * 选择一个 key（删除/设为当前/编辑/绑定/清除凭据共用）。
 *
 * 复用主界面同款 QuickPick 项（可用性状态 + 余额 + 当前/固定标记 + 凭据绑定），
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
        await buildKeyQuickPickItems(store, "select"),
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
 * 检测可用性二级界面：列出全部 key 状态 + "检测所有" + "返回"。
 */
export async function showCheckMenu(ctx: KeyManagerContext): Promise<void> {
    while (true) {
        const store = await getApiKeyStore(ctx.secrets);
        const items: (vscode.QuickPickItem & { action?: string; index?: number })[] = [];

        // List all keys with their current status (same detail line as the
        // main interface: availability + cooldown countdown + balance + credential).
        items.push(...(await buildKeyQuickPickItems(store, "checkOne")));

        items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
        items.push({ label: `$(beaker) ${l10n("Check All Availability")}`, action: "checkAll" });
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
        } else {
            return; // back or cancel
        }
    }
}

/**
 * 绑定/更新平台登录凭据流程（空输入 = 清除）。
 */
export async function bindCredentialFlow(ctx: KeyManagerContext, index: number): Promise<void> {
    const store = await getApiKeyStore(ctx.secrets);
    const entry = store.keys[index];
    if (!entry) {
        return;
    }
    const credential = await vscode.window.showInputBox({
        title: l10n("Bind/Update Credential"),
        prompt: l10n("Enter the platform login credential (PASETO token) for this key"),
        ignoreFocusOut: true,
        password: true,
        value: entry.credential ?? "",
    });
    if (credential === undefined) {
        return;
    }
    await setKeyCredential(ctx.secrets, index, credential.trim() || undefined);
    vscode.window.showInformationMessage(credential.trim() ? l10n("Credential updated") : l10n("Credential cleared"));
}

/**
 * 编辑 key 流程（value / credential / label 三字段，冲突校验）。
 * 平台登录凭据为账号级（查余额/套餐用量用），随 key 一并编辑。
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

    // 2. Platform login credential
    const newCredential = await vscode.window.showInputBox({
        title: l10n("Edit API Key"),
        prompt: l10n("Edit the platform login credential (PASETO token; empty to clear)"),
        ignoreFocusOut: true,
        password: true,
        value: entry.credential ?? "",
    });
    if (newCredential === undefined) {
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
        credential: newCredential.trim(),
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
