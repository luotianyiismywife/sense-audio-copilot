import * as vscode from "vscode";
import { abortCommitGeneration, generateCommitMsg } from "../gitCommit/commitMessageGenerator";
import { pushToCloud, pullFromCloud } from "../cloud/cloudSync";
import { showApiKeyManager } from "./apiKeyManagerUi";
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

    // Multi-key management command: QuickPick to add/delete keys, set current,
    // bind cookies, reset exhausted states, and manually test availability.
    // Also the provider's managementCommand (gear icon next to the provider).
    context.subscriptions.push(
        vscode.commands.registerCommand("senseaudio.manageApiKeys", async () => {
            await showApiKeyManager(context);
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

    // Plan usage refresh — bound to the status bar item click. Hidden from the
    // command palette (see package.json menus.commandPalette) since it is not a
    // user-facing command; the balance is also reachable from the API key manager.
    context.subscriptions.push(
        vscode.commands.registerCommand("senseaudio.checkUsage", async () => {
            await checkUsageCommand(context);
        })
    );
}
