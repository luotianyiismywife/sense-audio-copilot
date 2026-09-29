/**
 * apiKeyManagerUi.ts — API Key 管理 QuickPick 主入口。
 *
 * 支持：添加 / 批量导入 / 删除 / 设为当前使用 / 编辑 / 重置失效状态 /
 * 绑定或清除 cookie / 检测可用性 / 查询余额。所有 key 与 cookie 均以脱敏形式展示。
 *
 * 本文件只负责**渲染主菜单 + 分发动作**；展示辅助见 `apiKeyDisplay.ts`，
 * 各交互流程见 `apiKeyFlows.ts`。
 */
import * as vscode from "vscode";
import { l10n } from "../core/localize";
import {
    getApiKeyMode,
    getApiKeyStore,
    resetExhaustedKeys,
    setActiveKey,
    setKeyCookie,
} from "../keys/keyManager";
import { buildKeyQuickPickItems } from "./apiKeyDisplay";
import {
    addKeyFlow,
    batchImportFlow,
    bindCookieFlow,
    deleteKeysFlow,
    editKeyFlow,
    pickKey,
    showCheckMenu,
    type KeyManagerContext,
} from "./apiKeyFlows";

/**
 * API Key 管理 QuickPick 主流程（`senseaudio.manageApiKeys` 命令）。
 *
 * 循环渲染 key 列表与动作项，直到用户取消。动作分发到 `apiKeyFlows.ts` 中的
 * 各流程函数。
 */
export async function showApiKeyManager(context: vscode.ExtensionContext): Promise<void> {
    // 登录 PASETO token（60 天有效，查余额/套餐用量用）。
    // 存在 globalState（非 SecretStorage——token 本身是短期凭证，且需跨窗口共享）。
    const ctx: KeyManagerContext = {
        secrets: context.secrets,
        getLoginToken: () => context.globalState.get<string>("senseaudio.loginToken"),
        setLoginToken: async (token) => {
            await context.globalState.update("senseaudio.loginToken", token);
        },
    };

    const render = async (): Promise<vscode.QuickPickItem[] | undefined> => {
        const store = await getApiKeyStore(ctx.secrets);
        // "Set as Current" only makes sense in single mode; in rotation mode it
        // is hidden entirely.
        const isSingleMode = getApiKeyMode() === "single";
        const items: (vscode.QuickPickItem & { action?: string; index?: number })[] = [];

        if (store.keys.length === 0) {
            items.push({ label: l10n("No API keys configured"), kind: vscode.QuickPickItemKind.Separator });
        } else {
            items.push(...(await buildKeyQuickPickItems(store, ctx.getLoginToken, "select")));
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
            // Clicking a key entry itself (action "select") has no dedicated
            // view — stay in the menu instead of silently closing it.
            continue;
        }

        switch (pickedAction) {
            case "add": {
                await addKeyFlow(ctx);
                break;
            }
            case "import": {
                await batchImportFlow(ctx);
                break;
            }
            case "delete": {
                await deleteKeysFlow(ctx);
                break;
            }
            case "setActive": {
                // "Set as Current" only takes effect in single mode; in rotation
                // mode the active index is ignored (round-robin cursor is used).
                if (getApiKeyMode() !== "single") {
                    vscode.window.showInformationMessage(l10n("Set as Current is only valid in single mode (apiKeyMode=single)"));
                    break;
                }
                const keyPick = await pickKey(ctx, l10n("Set as Current"));
                if (!keyPick) {
                    break;
                }
                await setActiveKey(ctx.secrets, keyPick.index);
                vscode.window.showInformationMessage(l10n("Set as current API key"));
                break;
            }
            case "edit": {
                const keyPick = await pickKey(ctx, l10n("Edit API Key"));
                if (!keyPick) {
                    break;
                }
                await editKeyFlow(ctx, keyPick.index);
                break;
            }
            case "reset": {
                await resetExhaustedKeys(ctx.secrets, true);
                vscode.window.showInformationMessage(l10n("Reset exhausted key states"));
                break;
            }
            case "check": {
                await showCheckMenu(ctx);
                break;
            }
            case "bindCookie": {
                const keyPick = await pickKey(ctx, l10n("Bind/Update Cookie"));
                if (!keyPick) {
                    break;
                }
                await bindCookieFlow(ctx, keyPick.index);
                break;
            }
            case "clearCookie": {
                const keyPick = await pickKey(ctx, l10n("Clear Cookie"));
                if (!keyPick) {
                    break;
                }
                await setKeyCookie(ctx.secrets, keyPick.index, undefined);
                vscode.window.showInformationMessage(l10n("Cookie cleared"));
                break;
            }
            default:
                return;
        }
    }
}
