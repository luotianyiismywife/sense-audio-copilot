/** Gist 中存储的单个 key 条目（仅同步 value/credential/label，可用性状态为本地数据不同步）。 */
export interface SyncedKeyEntry {
    value: string;
    credential?: string;
    label?: string;
}

/** Gist 文件负载结构。 */
export interface SyncPayload {
    version: 1;
    updatedAt: string;
    keys: SyncedKeyEntry[];
}

/**
 * 读取条目的平台登录凭据，兼容旧字段名 `cookie`。
 * 旧版 Gist 用 `cookie` 存储凭据，新版用 `credential`。
 */
export function readEntryCredential(entry: SyncedKeyEntry): string | undefined {
    return entry.credential ?? (entry as { cookie?: string }).cookie;
}

export function syncPayloadHasChanged(local: SyncPayload | undefined, remote: SyncPayload | undefined): boolean {
    if (!remote) {
        return true;
    }
    if (!local) {
        return true;
    }
    if (local.version !== remote.version) {
        return true;
    }
    if (local.keys.length !== remote.keys.length) {
        return true;
    }
    return local.keys.some((entry, index) => {
        const other = remote.keys[index];
        return !other || entry.value !== other.value || (readEntryCredential(entry) ?? "") !== (readEntryCredential(other) ?? "") || (entry.label ?? "") !== (other.label ?? "");
    });
}
