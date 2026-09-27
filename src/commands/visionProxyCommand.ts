import * as vscode from "vscode";
import { l10n, l10nFormat } from "../core/localize";
import { getPrimaryApiKey } from "../keys/keyManager";
import { getVisionSupportedModelIds } from "../models/apiModelList";

/**
 * 视觉代理模型选择命令（`senseaudio.setVisionProxyModel`）。
 * 从 `/v1/models` 动态加载 `supports_vision=true` 的模型列表供 QuickPick 选择，
 * API 不可用时回退到手动输入。
 */
export async function setVisionProxyModelCommand(context: vscode.ExtensionContext): Promise<void> {
    const config = vscode.workspace.getConfiguration();
    const current = config.get<string>("senseaudio.visionProxyModel", "kimi-k2.6");
    const primary = await getPrimaryApiKey(context.secrets);
    const visionIds = primary ? await getVisionSupportedModelIds(primary.value) : new Set<string>();

    // Capability descriptions matching the settings-page enum descriptions.
    const VISION_MODEL_DESC: Record<string, string> = {
        "kimi-k2.6": l10n("Kimi K2.6 — vision-capable (default)"),
        "senseaudio-vl-1.0-260319": l10n("SenseAudio-VL-1.0 — vision-language model"),
        "senseaudio-vl-lite-1.0-260319": l10n("SenseAudio-VL-Lite-1.0 — lightweight vision-language model"),
    };

    interface VisionPick extends vscode.QuickPickItem {
        modelId?: string;
    }
    const items: VisionPick[] = [];
    if (visionIds.size > 0) {
        items.push(
            ...[...visionIds].sort().map((id) => ({
                label: id,
                description: [
                    VISION_MODEL_DESC[id] ?? undefined,
                    id === current ? `$(check) ${l10n("Current")}` : undefined,
                ].filter(Boolean).join("  ·  "),
                modelId: id,
            }))
        );
        items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
    }
    items.push({
        label: `$(pencil) ${l10n("Custom (manual input)")}`,
        description: current,
    });

    const picked = await vscode.window.showQuickPick(items, {
        title: l10n("Select Vision Proxy Model"),
        placeHolder: current,
        ignoreFocusOut: true,
    });
    if (!picked) {
        return;
    }
    let newModel = picked.modelId;
    if (!newModel) {
        // Custom: prompt for manual input
        const entered = await vscode.window.showInputBox({
            title: l10n("Select Vision Proxy Model"),
            prompt: l10n("Enter the vision model ID"),
            value: current,
            ignoreFocusOut: true,
        });
        if (entered === undefined || !entered.trim()) {
            return;
        }
        newModel = entered.trim();
    }
    await config.update("senseaudio.visionProxyModel", newModel, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(
        l10nFormat("Vision proxy model set to {0}", newModel)
    );
}
