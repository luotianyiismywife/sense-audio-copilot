import * as vscode from "vscode";
import { l10n, l10nFormat } from "../core/localize";
import { getPrimaryApiKey } from "../keys/keyManager";
import { getVisionSupportedModelIds } from "../models/visionModels";
import { getApiModelMetadataList } from "../models/apiModelList";

/**
 * 视觉代理模型选择命令（`senseaudio.setVisionProxyModel`）。
 *
 * 从 `/v1/models` 动态加载视觉模型列表（视觉能力经 models.dev 判定，见
 * `models/visionModels.ts`）供 QuickPick 选择，API 不可用时回退到手动输入。
 */
export async function setVisionProxyModelCommand(context: vscode.ExtensionContext): Promise<void> {
    const config = vscode.workspace.getConfiguration();
    const current = config.get<string>("senseaudio.visionProxyModel", "qwen3.6-35b-a3b");
    const primary = await getPrimaryApiKey(context.secrets);
    const visionIds = primary ? await getVisionSupportedModelIds(primary.value) : new Set<string>();
    // /v1/models desc is used as the picker tooltip (platform's own description).
    const metaList = primary ? await getApiModelMetadataList(primary.value) : [];
    const descById = new Map(metaList.map((m) => [m.id, m.desc]));

    interface VisionPick extends vscode.QuickPickItem {
        modelId?: string;
    }
    const items: VisionPick[] = [];
    if (visionIds.size > 0) {
        items.push(
            ...[...visionIds].sort().map((id) => ({
                label: id,
                description: [
                    descById.get(id) ?? undefined,
                    id === current ? `$(check) ${l10n("Current")}` : undefined,
                ].filter(Boolean).join("  ·  "),
                modelId: id,
            }))
        );
        items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
    } else {
        // No vision model detected (API unreachable, or the platform currently
        // exposes none). Tell the user instead of showing a bare custom entry.
        items.push({
            label: `$(warning) ${l10n("No vision-capable model detected")}`,
            description: l10n("Check your API key / network, or enter a model ID manually"),
        });
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
