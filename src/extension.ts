import * as vscode from "vscode";
import { SenseAudioChatModelProvider } from "./provider/provider";
import { initStatusBar } from "./ui/statusBar";
import { logger } from "./core/logger";
import { TokenizerManager } from "./tokenizer/tokenizerManager";
import { syncModelsOnStartup } from "./models/modelSync";
import { autoPullOnStartup, flushPendingAutoPush, registerCloudSyncAutoPush } from "./cloud/cloudSync";
import { registerCommands } from "./commands/registerCommands";

/**
 * 扩展激活入口。
 *
 * 职责仅限「编排」：初始化基础设施（日志 / 分词器 / 状态栏）、注册
 * LanguageModelChatProvider、委托 `registerCommands()` 注册全部命令、
 * 触发启动任务（模型同步 / 云同步自动拉取）。
 *
 * 具体命令实现见 `src/commands/`，Provider 实现见 `src/provider/`。
 */
export function activate(context: vscode.ExtensionContext) {
    // Initialize logger
    logger.init();

    // Initialize TokenizerManager with extension path
    TokenizerManager.initialize(context.extensionPath);

    // Login PASETO token (60-day validity) lives in globalState — shared with
    // the API-key manager UI and the plan-usage status bar.
    const getLoginToken = (): string | undefined => context.globalState.get<string>("senseaudio.loginToken");

    const tokenCountStatusBarItem: vscode.StatusBarItem = initStatusBar(context, getLoginToken);
    const provider = new SenseAudioChatModelProvider(context.secrets, tokenCountStatusBarItem);

    // Register the SenseAudio provider under the vendor id used in package.json
    vscode.lm.registerLanguageModelChatProvider("senseaudio", provider);

    // Register all commands and configuration listeners
    registerCommands(context, provider);

    // Startup model sync — checks for new SenseAudio models at most once per
    // day and logs a single line to the "SenseAudio" Output channel.
    // Fire-and-forget: never blocks activation, all errors are handled internally.
    syncModelsOnStartup(context);

    // Startup cloud sync auto-pull — silently pulls key/cookie/label triples
    // from the cloud Gist when the cloud copy is newer than the last sync.
    // Fire-and-forget: never blocks activation, never prompts for sign-in.
    autoPullOnStartup(context);

    // Startup cloud sync auto-push — sends local key changes to the cloud gist
    // after human-driven key-management actions, with debounce and silent failure.
    registerCloudSyncAutoPush(context);

    // Dispose logger on deactivate
    context.subscriptions.push({
        dispose: () => {
            flushPendingAutoPush();
            logger.dispose();
        },
    });
}

export function deactivate() {
    flushPendingAutoPush();
}
