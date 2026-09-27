import * as vscode from "vscode";
import { l10n, l10nFormat } from "../core/localize";
import type { ModelPreset } from "../core/types";

/**
 * 模型温度预设选择命令（`senseaudio.setModelPreset`）。
 * 提供命名预设（🎯 Precise / ⚖️ Balanced / 🔥 Creative 等）与自定义输入
 * （单个数字 = temperature，两个逗号分隔数字 = temperature + top_p）。
 */
export async function setModelPresetCommand(): Promise<void> {
    const config = vscode.workspace.getConfiguration();
    const presets = config.get<ModelPreset[]>("senseaudio.modelPresets", []);
    const currentPresetId = config.get<string>("senseaudio.modelPreset", "custom");
    const currentTemp = config.get<number | null>("senseaudio.temperature", null);
    const currentTopP = config.get<number | null>("senseaudio.top_p", null);

    interface PresetQuickPickItem extends vscode.QuickPickItem {
        presetId?: string;
    }

    // Mark the currently active preset with " (当前)"
    const presetItems: PresetQuickPickItem[] = presets.map((p) => ({
        label: `${l10n(p.label)} (${p.temperature})${p.id === currentPresetId ? l10n(" (current)") : ""}`,
        presetId: p.id,
    }));

    // Mark custom option with current values if active
    const isCustomActive = currentPresetId === "custom";
    const customLabel = "$(pencil) " + l10n("Custom (manual input)")
        + (isCustomActive
            ? ` ${l10nFormat("(current, temperature: {0}, top_p: {1})", String(currentTemp ?? "—"), String(currentTopP ?? "—"))}`
            : "");

    const customItem: PresetQuickPickItem = {
        label: customLabel,
    };

    const items: PresetQuickPickItem[] = [
        ...presetItems,
        { label: "", kind: vscode.QuickPickItemKind.Separator },
        customItem,
    ];

    const title = l10n("Set Model Preset");

    const picked = await vscode.window.showQuickPick(items, {
        title,
        placeHolder: l10n("Select a preset"),
        ignoreFocusOut: true,
    });

    if (!picked) {
        return;
    }

    const presetId = picked.presetId;

    if (presetId) {
        // User selected a named preset
        const matchedPreset = presets.find((p) => p.id === presetId);
        if (matchedPreset) {
            await config.update("senseaudio.modelPreset", matchedPreset.id, vscode.ConfigurationTarget.Global);
            await config.update("senseaudio.temperature", matchedPreset.temperature, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(
                l10nFormat("Set to temperature: {0} ({1})", String(matchedPreset.temperature), l10n(matchedPreset.label))
            );
        }
    } else {
        // User chose "Custom (manual input)"
        const currentVal = currentTemp !== null && currentTopP !== null
            ? `${currentTemp},${currentTopP}`
            : "";
        const inputValue = await vscode.window.showInputBox({
            title: l10n("Enter custom temperature"),
            prompt: l10n("Enter a single number for temperature only (<=2), or two comma-separated numbers for temperature and top_p (temp<=2, top_p<=1), e.g.: 0.7 or 0.7,0.95"),
            value: currentVal,
            validateInput: (val: string) => {
                const trimmed = val.trim();
                if (!trimmed) {
                    return l10n("Please enter at least temperature value");
                }
                const parts = trimmed.split(",");
                if (parts.length > 2) {
                    return l10n("Please enter at most two numbers separated by a comma");
                }
                const temp = parseFloat(parts[0].trim());
                if (isNaN(temp) || temp < 0 || temp > 2) {
                    return l10n("Temperature must be between 0.0 and 2.0");
                }
                if (parts.length === 2) {
                    const topP = parseFloat(parts[1].trim());
                    if (isNaN(topP) || topP < 0 || topP > 1) {
                        return l10n("top_p must be between 0.0 and 1.0");
                    }
                }
                return null;
            },
            ignoreFocusOut: true,
        });
        if (inputValue !== undefined) {
            const trimmed = inputValue.trim();
            const parts = trimmed.split(",");
            const tempNum = parseFloat(parts[0].trim());
            await config.update("senseaudio.modelPreset", "custom", vscode.ConfigurationTarget.Global);
            await config.update("senseaudio.temperature", tempNum, vscode.ConfigurationTarget.Global);
            if (parts.length === 2) {
                const topPNum = parseFloat(parts[1].trim());
                await config.update("senseaudio.top_p", topPNum, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(
                    l10nFormat("Set to temp: {0}, top_p: {1} (custom)", String(tempNum), String(topPNum))
                );
            } else {
                vscode.window.showInformationMessage(
                    l10nFormat("Set to temperature: {0} (custom)", String(tempNum))
                );
            }
        }
    }
}
