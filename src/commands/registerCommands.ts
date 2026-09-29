import * as vscode from "vscode";
import { l10n } from "../core/localize";
import { addApiKey, getApiKeyStore, setActiveKey } from "../keys/keyManager";
import { abortCommitGeneration, generateCommitMsg } from "../gitCommit/commitMessageGenerator";
import { pushToCloud, pullFromCloud } from "../cloud/cloudSync";
import { showApiKeyManager } from "./apiKeyManagerUi";
import { setVisionProxyModelCommand } from "./visionProxyCommand";
import { setModelPresetCommand } from "./modelPresetCommand";
import { checkUsageCommand } from "./checkUsageCommand";
import type { SenseAudioChatModelProvider } from "../provider/provider";

/**
 * 注册扩展的全部命令与配置变更监听。
 * 由 `activate()` 调用，所有 disposable 推入 `context.subscriptions`。
 */
export function registerCommands(
    context: vscode.ExtensionContext,
    provider: SenseAudioChatModelProvider,
): void {
    // Refresh the model list dynamically when the API mode (or auto model
    // discovery) setting changes — the provider fires
    // onDidChangeLanguageModelChatInformation so VS Code re-invokes
    // provideLanguageModelChatInformation and updates the picker without reload.
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("senseaudio.apiMode") || e.affectsConfiguration("senseaudio.enableAutoModelDiscovery")) {
                provider.notifyModelListChanged();
            }
        })
    );

    // Management command to configure API key (legacy single-key flow,
    // writes into the new multi-key store as a single-element list)
    context.subscriptions.push(
        vscode.commands.registerCommand("senseaudio.setApiKey", async () => {
            const store = await getApiKeyStore(context.secrets);
            const existing = store.keys.length > 0 ? store.keys[store.activeIndex]?.value : undefined;
            const apiKey = await vscode.window.showInputBox({
                title: l10n("SenseAudio Provider API Key"),
                prompt: existing ? l10n("Update your SenseAudio API key") : l10n("Enter your SenseAudio API key"),
                ignoreFocusOut: true,
                password: true,
                value: existing ?? "",
            });
            if (apiKey === undefined) {
                return; // user canceled
            }
            if (!apiKey.trim()) {
                // Clear all keys
                await context.secrets.store("senseaudio.apiKeys", JSON.stringify({ keys: [], activeIndex: 0 }));
                await context.secrets.delete("senseaudio.apiKey");
                vscode.window.showInformationMessage(l10n("SenseAudio API key cleared."));
                return;
            }
            const trimmed = apiKey.trim();
            if (existing && existing === trimmed) {
                vscode.window.showInformationMessage(l10n("SenseAudio API key saved."));
                return;
            }
            const added = await addApiKey(context.secrets, { value: trimmed, available: null });
            if (!added && store.keys.length > 0) {
                // Same value already exists — treat as "set active" to it
                const idx = store.keys.findIndex((k) => k.value === trimmed);
                if (idx >= 0) {
                    await setActiveKey(context.secrets, idx);
                }
            }
            vscode.window.showInformationMessage(l10n("SenseAudio API key saved."));
        })
    );

    // Multi-key management command: QuickPick to add/delete keys, set current,
    // bind cookies, reset exhausted states, and manually test availability.
    context.subscriptions.push(
        vscode.commands.registerCommand("senseaudio.manageApiKeys", async () => {
            await showApiKeyManager(context);
        })
    );

    // Vision proxy model picker: dynamically loads vision-capable models from
    // /v1/models + models.dev (visionModels.ts) so the user can pick instead of typing
    // the model ID by hand. Falls back to manual input when the API is unavailable.
    context.subscriptions.push(
        vscode.commands.registerCommand("senseaudio.setVisionProxyModel", async () => {
            await setVisionProxyModelCommand(context);
        })
    );

    // Command to open the SenseAudio website to get an API key
    context.subscriptions.push(
        vscode.commands.registerCommand("senseaudio.getApiKey", () => {
            vscode.env.openExternal(vscode.Uri.parse("https://senseaudio.cn/api-platform/api-key"));
        })
    );

    // Command to open extension settings
    context.subscriptions.push(
        vscode.commands.registerCommand("senseaudio.openSettings", () => {
            vscode.commands.executeCommand("workbench.action.openSettings", "@ext:luotianyiismywife.senseaudio-copilot-provider");
        })
    );

    // Register the generateGitCommitMessage command handler
    context.subscriptions.push(
        vscode.commands.registerCommand("senseaudio.generateGitCommitMessage", async (scm) => {
            generateCommitMsg(context.secrets, scm);
        }),
        vscode.commands.registerCommand("senseaudio.abortGitCommitMessage", () => {
            abortCommitGeneration();
        })
    );

    // Register the setModelPreset command: user can select a preset via QuickPick
    context.subscriptions.push(
        vscode.commands.registerCommand("senseaudio.setModelPreset", async () => {
            await setModelPresetCommand();
        })
    );

    // Cloud sync commands: push/pull key/cookie/label triples to a private
    // GitHub Gist via VS Code's built-in GitHub sign-in.
    context.subscriptions.push(
        vscode.commands.registerCommand("senseaudio.syncPush", async () => {
            await pushToCloud(context);
        }),
        vscode.commands.registerCommand("senseaudio.syncPull", async () => {
            await pullFromCloud(context);
        })
    );

    // Plan usage command: refresh and show the 5h/weekly/monthly windows plus
    // the balance. Also bound to clicking the status bar item.
    context.subscriptions.push(
        vscode.commands.registerCommand("senseaudio.checkUsage", async () => {
            await checkUsageCommand(context);
        })
    );
}
