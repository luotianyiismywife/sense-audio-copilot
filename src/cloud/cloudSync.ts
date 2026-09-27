import * as vscode from "vscode";
import { logger } from "../core/logger";
import { l10n, l10nFormat } from "../core/localize";
import { getApiKeyStore, saveApiKeyStore, invalidateApiKeyStoreCache, type ApiKeyEntry } from "../keys/keyManager";

/**
 * 云同步（GitHub Gist）：
 * 使用 VS Code 内置的 GitHub 登录（vscode.authentication.getSession）获取 token，
 * 将 key/cookie/备注 三元组存储到一个私密 Gist 中，实现跨机器同步。
 *
 * - 推送（senseaudio.syncPush）：本地 store → Gist（手动触发）
 * - 拉取（senseaudio.syncPull）：Gist → 本地 store（手动触发）
 * - 启动自动拉取（senseaudio.cloudSyncAutoPull，默认开启）：静默检查云端
 *   updatedAt 是否比本地上次同步时间新，是则拉取覆盖本地并弹窗提示。
 *
 * Gist 定位：优先使用 globalState 缓存的 gist id；缺失时按 description
 * 标记（GIST_DESCRIPTION）遍历用户 Gist 列表查找；均无则创建新 Gist。
 * Gist 为 secret（public: false），文件名固定 GIST_FILE_NAME。
 */

const GIST_DESCRIPTION = "senseaudio-copilot key sync (do not edit manually)";
const GIST_FILE_NAME = "senseaudio-keys.json";
const GIST_API_BASE = "https://api.github.com/gists";

const GLOBAL_STATE_GIST_ID = "senseaudio.cloudSyncGistId";
const GLOBAL_STATE_LAST_SYNC_AT = "senseaudio.lastCloudSyncAt";

// push/pull 互斥：两者都是"读 store → 网络等待 → 写 store"，并发重叠时
// pull 会用旧 store 快照覆盖 push 的结果（last-writer-wins），push 期间
// 新增的本地 key 可能被 pull 的合并删掉。模块级互斥标志防止重叠。
let syncInFlight = false;

/** Gist 中存储的单个 key 条目（仅同步 value/cookie/label，可用性状态为本地数据不同步）。 */
interface SyncedKeyEntry {
    value: string;
    cookie?: string;
    label?: string;
}

/** Gist 文件负载结构。 */
interface SyncPayload {
    version: 1;
    updatedAt: string;
    keys: SyncedKeyEntry[];
}

/**
 * 获取 VS Code 内置 GitHub 登录会话。
 * @param createIfNone true 时未登录会弹出 GitHub 登录界面；false 时静默返回 undefined。
 */
async function getGitHubSession(createIfNone: boolean): Promise<vscode.AuthenticationSession | undefined> {
    // 会话可能被用户登出而失效，每次都向 VS Code 请求（VS Code 自身有缓存）
    try {
        return await vscode.authentication.getSession("github", ["gist"], { createIfNone });
    } catch (err) {
        logger.warn("cloudSync.auth", { error: String(err) });
        return undefined;
    }
}

/** 带 GitHub 认证的 fetch，非 2xx 抛出含状态码的错误。 */
async function gistFetch(session: vscode.AuthenticationSession, url: string, init?: RequestInit): Promise<Response> {
    const resp = await fetch(url, {
        ...init,
        headers: {
            Authorization: `Bearer ${session.accessToken}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "senseaudio-copilot",
            ...(init?.headers ?? {}),
        },
    });
    if (!resp.ok) {
        throw new Error(`GitHub Gist API ${resp.status}: ${await resp.text().catch(() => resp.statusText)}`);
    }
    return resp;
}

interface GistSummary {
    id: string;
    description: string | null;
    public: boolean;
    files: Record<string, { filename?: string } | null>;
}

/** 按描述标记在用户 Gist 列表中查找同步 Gist（前 3 页）。 */
async function findSyncGist(session: vscode.AuthenticationSession): Promise<GistSummary | undefined> {
    for (let page = 1; page <= 3; page++) {
        const resp = await gistFetch(session, `${GIST_API_BASE}?per_page=100&page=${page}`);
        const gists = (await resp.json()) as GistSummary[];
        if (!Array.isArray(gists) || gists.length === 0) {
            break;
        }
        const found = gists.find(
            (g) => g.description === GIST_DESCRIPTION && Object.keys(g.files ?? {}).includes(GIST_FILE_NAME),
        );
        if (found) {
            return found;
        }
        if (gists.length < 100) {
            break;
        }
    }
    return undefined;
}

/** 读取 Gist 文件内容并解析为负载；损坏时返回 undefined。 */
async function fetchSyncPayload(
    session: vscode.AuthenticationSession,
    gistId: string,
): Promise<SyncPayload | undefined> {
    const resp = await gistFetch(session, `${GIST_API_BASE}/${gistId}`);
    const gist = (await resp.json()) as {
        updated_at?: string;
        files?: Record<string, { content?: string } | null>;
    };
    const content = gist.files?.[GIST_FILE_NAME]?.content;
    if (!content) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(content) as SyncPayload;
        if (parsed && parsed.version === 1 && Array.isArray(parsed.keys)) {
            // 优先使用 GitHub 服务端时间戳（消除客户端时钟偏差导致的漏拉）
            if (gist.updated_at) {
                parsed.updatedAt = gist.updated_at;
            }
            return parsed;
        }
    } catch (err) {
        logger.warn("cloudSync.parse", { error: String(err) });
    }
    return undefined;
}

/** 规范化同步条目：过滤空值，cookie/label 去空白。 */
function normalizeEntries(keys: SyncedKeyEntry[]): SyncedKeyEntry[] {
    return keys
        .map((k) => ({
            value: typeof k.value === "string" ? k.value.trim() : "",
            cookie: typeof k.cookie === "string" && k.cookie.trim() ? k.cookie.trim() : undefined,
            label: typeof k.label === "string" && k.label.trim() ? k.label.trim() : undefined,
        }))
        .filter((k) => k.value);
}

/** 将本地 store 序列化为同步负载。 */
function buildPayload(keys: ApiKeyEntry[]): SyncPayload {
    return {
        version: 1,
        updatedAt: new Date().toISOString(),
        keys: normalizeEntries(keys.map((k) => ({ value: k.value, cookie: k.cookie, label: k.label }))),
    };
}

/**
 * 推送本地 key/cookie/备注 到云端 Gist（senseaudio.syncPush 命令）。
 * 未登录 GitHub 时弹出登录界面。成功后记录 globalState 同步时间。
 */
export async function pushToCloud(context: vscode.ExtensionContext): Promise<void> {
    if (syncInFlight) {
        vscode.window.showWarningMessage(l10n("Cloud sync is already in progress"));
        return;
    }
    const session = await getGitHubSession(true);
    if (!session) {
        return; // 用户取消登录
    }
    syncInFlight = true;
    try {
        await pushToCloudInner(context, session);
    } finally {
        syncInFlight = false;
    }
}

async function pushToCloudInner(context: vscode.ExtensionContext, session: vscode.AuthenticationSession): Promise<void> {
    const store = await getApiKeyStore(context.secrets);
    if (store.keys.length === 0) {
        vscode.window.showWarningMessage(l10n("No API keys configured"));
        return;
    }
    const payload = buildPayload(store.keys);
    const fileBody = { filename: GIST_FILE_NAME, content: JSON.stringify(payload, null, 2) };

    try {
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: l10n("Pushing keys to cloud...") },
            async () => {
                // 优先使用缓存的 gist id，失效（404）时回退查找/创建
                let gistId = context.globalState.get<string>(GLOBAL_STATE_GIST_ID);
                if (gistId) {
                    try {
                        const resp = await gistFetch(session, `${GIST_API_BASE}/${gistId}`, {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ files: { [GIST_FILE_NAME]: fileBody } }),
                        });
                        void resp;
                    } catch {
                        gistId = undefined; // 缓存的 gist 已不存在，回退
                    }
                }
                if (!gistId) {
                    const found = await findSyncGist(session);
                    if (found) {
                        gistId = found.id;
                        await gistFetch(session, `${GIST_API_BASE}/${gistId}`, {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ files: { [GIST_FILE_NAME]: fileBody } }),
                        });
                    } else {
                        const resp = await gistFetch(session, GIST_API_BASE, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                description: GIST_DESCRIPTION,
                                public: false,
                                files: { [GIST_FILE_NAME]: fileBody },
                            }),
                        });
                        const created = (await resp.json()) as { id?: string };
                        gistId = created.id;
                        if (!gistId) {
                            // POST 响应解析不出 id：什么都没推送，抛错走 catch
                            // 分支（不更新时间戳、不报成功），避免"假成功"。
                            throw new Error("Gist creation response missing id");
                        }
                    }
                }
                if (gistId) {
                    await context.globalState.update(GLOBAL_STATE_GIST_ID, gistId);
                }
            },
        );
        await context.globalState.update(GLOBAL_STATE_LAST_SYNC_AT, payload.updatedAt);
        logger.info("cloudSync.push", { count: payload.keys.length });
        vscode.window.showInformationMessage(
            l10nFormat("Pushed {0} keys to cloud Gist", String(payload.keys.length)),
        );
    } catch (err) {
        logger.error("cloudSync.push", { error: String(err) });
        vscode.window.showErrorMessage(l10nFormat("Failed to push to cloud: {0}", String(err)));
    }
}

/**
 * 从云端 Gist 拉取 key/cookie/备注 覆盖本地（senseaudio.syncPull 命令）。
 * 合并策略：云端为源——按 key 值对齐，云端条目覆盖本地 cookie/label，
 * 云端有本地无的条目追加，本地有云端无的条目删除；可用性状态（available/
 * lastCheckedAt）为本地数据，按 key 值保留。
 */
export async function pullFromCloud(context: vscode.ExtensionContext, silent = false): Promise<boolean> {
    if (syncInFlight) {
        if (!silent) {
            vscode.window.showWarningMessage(l10n("Cloud sync is already in progress"));
        }
        return false;
    }
    const session = await getGitHubSession(false);
    if (!session) {
        if (!silent) {
            vscode.window.showWarningMessage(l10n("GitHub sign-in required for cloud sync"));
        }
        return false;
    }
    syncInFlight = true;
    try {
        return await pullFromCloudInner(context, session, silent);
    } finally {
        syncInFlight = false;
    }
}

async function pullFromCloudInner(
    context: vscode.ExtensionContext,
    session: vscode.AuthenticationSession,
    silent: boolean,
): Promise<boolean> {
    try {
        // 定位 Gist：缓存 id → 按描述查找 → 静默模式下无 Gist 视为无更新。
        // 缓存 id 失效（Gist 在其他机器被删除重建）时回退重新查找，避免
        // 自动拉取从此每次启动都静默失败。
        let gistId = context.globalState.get<string>(GLOBAL_STATE_GIST_ID);
        let payload: SyncPayload | undefined;
        if (gistId) {
            try {
                payload = await fetchSyncPayload(session, gistId);
            } catch (err) {
                // 缓存的 gist 已不存在（404 等）→ 清缓存回退查找
                logger.warn("cloudSync.pull.cachedGistFailed", { gistId, error: String(err) });
                gistId = undefined;
            }
        }
        if (!payload) {
            const found = await findSyncGist(session);
            if (!found) {
                if (!silent) {
                    vscode.window.showWarningMessage(l10n("No cloud sync Gist found. Use push first."));
                }
                return false;
            }
            gistId = found.id;
            await context.globalState.update(GLOBAL_STATE_GIST_ID, gistId);
            payload = await fetchSyncPayload(session, gistId);
        }
        if (!payload) {
            if (!silent) {
                vscode.window.showWarningMessage(l10n("Cloud sync data is empty or corrupted"));
            }
            return false;
        }

        // 启动自动拉取：云端 updatedAt 不比本地上次同步新则跳过
        const lastSyncAt = context.globalState.get<string>(GLOBAL_STATE_LAST_SYNC_AT);
        if (silent && lastSyncAt && payload.updatedAt <= lastSyncAt) {
            return false;
        }

        const store = await getApiKeyStore(context.secrets);
        const localByKey = new Map(store.keys.map((k) => [k.value, k]));
        const cloudEntries = normalizeEntries(payload.keys);
        const merged: ApiKeyEntry[] = cloudEntries.map((entry) => {
            const local = localByKey.get(entry.value);
            return {
                value: entry.value,
                cookie: entry.cookie,
                label: entry.label,
                // 可用性状态为本地数据：按 key 值保留本地检测结果
                available: local?.available ?? null,
                lastCheckedAt: local?.lastCheckedAt,
            };
        });
        const changed =
            merged.length !== store.keys.length ||
            merged.some((m, i) => {
                const old = store.keys[i];
                return !old || old.value !== m.value || old.cookie !== m.cookie || old.label !== m.label;
            });
        if (!changed) {
            await context.globalState.update(GLOBAL_STATE_LAST_SYNC_AT, payload.updatedAt);
            return false;
        }

        const activeValue = store.keys[store.activeIndex]?.value;
        const newStore = {
            keys: merged,
            activeIndex: Math.max(
                0,
                merged.findIndex((k) => k.value === activeValue),
            ),
        };
        await saveApiKeyStore(context.secrets, newStore);
        invalidateApiKeyStoreCache();
        await context.globalState.update(GLOBAL_STATE_LAST_SYNC_AT, payload.updatedAt);
        logger.info("cloudSync.pull", { count: merged.length });
        if (!silent) {
            vscode.window.showInformationMessage(
                l10nFormat("Pulled {0} keys from cloud Gist", String(merged.length)),
            );
        } else {
            vscode.window.showInformationMessage(
                l10nFormat("Cloud sync: pulled {0} keys from Gist on startup", String(merged.length)),
            );
        }
        return true;
    } catch (err) {
        logger.error("cloudSync.pull", { error: String(err) });
        if (!silent) {
            vscode.window.showErrorMessage(l10nFormat("Failed to pull from cloud: {0}", String(err)));
        }
        return false;
    }
}

/**
 * 启动自动拉取（fire-and-forget，不阻塞激活）。
 * 读取 senseaudio.cloudSyncAutoPull 配置（默认开启）；未登录 GitHub 时静默跳过，
 * 不弹登录界面；云端无更新时静默跳过。
 */
export function autoPullOnStartup(context: vscode.ExtensionContext): void {
    const enabled = vscode.workspace.getConfiguration().get<boolean>("senseaudio.cloudSyncAutoPull", true);
    if (!enabled) {
        return;
    }
    void pullFromCloud(context, true);
}
