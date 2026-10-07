/** Gist 中存储的单个 key 条目（仅同步 value/cookie/label，可用性状态为本地数据不同步）。 */
export interface SyncedKeyEntry {
    value: string;
    cookie?: string;
    label?: string;
}

/** Gist 文件负载结构。 */
export interface SyncPayload {
    version: 1;
    updatedAt: string;
    keys: SyncedKeyEntry[];
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
        return !other || entry.value !== other.value || (entry.cookie ?? "") !== (other.cookie ?? "") || (entry.label ?? "") !== (other.label ?? "");
    });
}
