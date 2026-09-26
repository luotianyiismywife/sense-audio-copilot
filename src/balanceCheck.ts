/**
 * SenseAudio 余额查询模块（主动预检）。
 *
 * 通过 tr_session cookie 调用用户中心 `GET /api/usage-summary` 查询余额，
 * 独立实现（不依赖 scripts/cookieApi，该目录为独立 tsconfig）。
 *
 * ⚠️ **平台已改版（2026-09-23 实测）**：旧端点 `senseaudio.cn/api/usage-summary` 与
 * `/api/api-keys` **均已 404**（2026-08-24 实测还是 200）。用户中心已迁移为三域认证体系，
 * 套餐用量数据源变更为 `platform.senseaudio.cn/api/user/self`（Bearer PASETO token 认证，
 * 插件只有 tr_session cookie 拿不到 token）。本模块的查询会全部失败并静默降级
 * （返回 undefined，不阻塞请求，回退被动检测——余额不足时 API 返回 402 触发轮换）。
 *
 * 历史实测确认（2026-08-09，端点尚存时）：
 * - 余额为负时 usage-summary 仍返回 code:0 + availableBalanceCny
 * - 余额不足时 `POST /v1/chat/completions` 返回 HTTP 402 + INSUFFICIENT_BALANCE（不消耗 token）
 * - `GET /v1/models` 不校验余额（余额 < 0 也 200），不能作为可用性判据
 */
import * as vscode from "vscode";
import { logger } from "./logger";
import type { ApiKeyEntry } from "./keyManager";

const USAGE_SUMMARY_URL = "https://senseaudio.cn/api/usage-summary";
const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_BASE_URL = "https://api.senseaudio.cn/v1/";
/** 手动检测用的最小聊天请求模型（deepseek-v4-flash 已下线，400 "模型未找到"，2026-09-19 实测） */
const TEST_MODEL_ID = "deepseek-v4.1-flash";
/** 平台用户中心新端点（2026-09-23 实测，Bearer PASETO token 认证） */
const PLATFORM_USER_SELF_URL = "https://platform.senseaudio.cn/api/user/self";
/** platform 域必需的固定头（2026-09-23 实测：缺 x-platform/x-product 会 403 forbidden） */
const PLATFORM_HEADERS: Record<string, string> = {
    "x-platform": "WEB",
    "x-product": "SenseAudio",
    "x-version": "1.0.2",
    "Accept": "application/json",
};

/**
 * 余额详情（GET /api/usage-summary 的 data 子集）。
 *
 * 平台余额分为「充值余额」与「赠送（限时）额度」：
 * - `balanceCny` 账户余额 = 充值 + 赠送（总额）
 * - `availableBalanceCny` 可用余额 = 可立即使用部分（充值余额 + 未到期的赠送额度）
 * - `expiringBalanceCny` 限时额度 = 赠送余额（到期后未使用部分失效）
 * - `nextExpiryAt` 最近到期时间（ISO 8601 UTC，无则 null）
 *
 * 充值余额 = availableBalanceCny - expiringBalanceCny。
 * 实测（2026-08-15）：字段真实存在，`signupReward` 等字段不在本类型内。
 */
export interface BalanceDetail {
    balanceCny: number;
    availableBalanceCny: number;
    expiringBalanceCny: number;
    nextExpiryAt: string | null;
}

/**
 * 套餐用量详情（GET platform.senseaudio.cn/api/user/self 的 usage_infos 子集，2026-09-23 实测）。
 *
 * 平台套餐分三个窗口：5小时积分 / 每周全部模型积分 / 30天积分。
 * `reset_time` 为 epoch 秒（5小时=上次消耗后+5h；每周=周一 00:00；30天=套餐生效日+30天）。
 */
export interface PlanUsageWindow {
    /** 窗口标识：credit_5h_limit / credit_7d_limit / credit_30d_limit */
    key: string;
    /** 窗口描述（如 "5小时积分"） */
    desc: string;
    /** 已用积分 */
    usedCount: number;
    /** 排队中积分 */
    pendingCount: number;
    /** 窗口上限 */
    totalCount: number;
    /** 重置时间（epoch 秒） */
    resetTime: number;
}

/**
 * 账号余额/套餐详情（GET platform.senseaudio.cn/api/user/self，2026-09-23 实测）。
 *
 * - `vouchers` 单位是积分（1 元 = 5000 积分），网页显示的「代金券余额」 = Σ可用代金券积分 / 5000
 * - 扣减顺序：套餐积分 → 代金券（按到期时间先后）→ 现金余额
 */
export interface AccountInfo {
    /** 现金余额（元，备用扣减） */
    balance: number;
    /** 代金券列表（available/total/used 单位均为积分） */
    vouchers: Array<{ voucherId: number; name: string; available: number; total: number; used: number; expireAt: number | null }>;
    /** 代金券可用总额（积分） */
    voucherAvailablePoints: number;
    /** 代金券可用总额（元 = 积分 / 5000） */
    voucherAvailableCny: number;
    /** 最早到期时间（epoch 秒，无则 null） */
    earliestVoucherExpiry: number | null;
    /** 额外用量开关 */
    enableExtraUsage: boolean;
    /** 套餐用量窗口（5小时/每周/30天） */
    usageInfos: PlanUsageWindow[];
}

/** 余额查询 TTL 缓存（按 cookie 粒度，缓存完整详情） */
interface BalanceCacheEntry {
    detail: BalanceDetail;
    checkedAt: number;
}
const balanceCache = new Map<string, BalanceCacheEntry>();

// ---------------------------------------------------------------------------
// 配置读取
// ---------------------------------------------------------------------------

function getConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("senseaudio");
}

/** 是否启用主动余额预检（默认 true） */
export function getBalanceCheckEnabled(): boolean {
    return getConfig().get<boolean>("balanceCheckEnabled", true);
}

/** 余额阈值：availableBalanceCny ≤ 该值视为耗尽（默认 0，夹取 ≥ 0） */
export function getMinBalanceCny(): number {
    const v = getConfig().get<number>("minBalanceCny", 0);
    return Number.isFinite(v) && v >= 0 ? v : 0;
}

/** 余额查询缓存 TTL（秒，默认 60；0 = 每次查询） */
export function getBalanceCheckIntervalSec(): number {
    const v = getConfig().get<number>("balanceCheckIntervalSec", 60);
    return Number.isFinite(v) && v >= 0 ? v : 60;
}

// ---------------------------------------------------------------------------
// 平台用户中心查询（登录 PASETO token，2026-09-23 新端点）
// ---------------------------------------------------------------------------

/**
 * 查询账号余额/套餐详情（GET platform.senseaudio.cn/api/user/self）。
 *
 * **认证方式（2026-09-23 实测）**：`Authorization: Bearer <登录 PASETO token>`，
 * token 来自浏览器 localStorage `user.state.token`（60 天有效，subject: "SenseAudio.AI Login"）。
 * 用户需手动从浏览器复制（F12 → Application → Local Storage → senseaudio.cn → user）。
 * 缺 x-platform/x-product 头会 403 forbidden（ref_code:403002）。
 *
 * @param loginToken 登录 PASETO token（浏览器 localStorage user.state.token）
 * @throws 网络错误 / 401（token 失效）/ 403（缺必需头）
 */
export async function queryAccountInfo(loginToken: string): Promise<AccountInfo> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(PLATFORM_USER_SELF_URL, {
            headers: {
                ...PLATFORM_HEADERS,
                Authorization: `Bearer ${loginToken}`,
            },
            signal: controller.signal,
        });
        if (response.status === 401) {
            throw new Error("401 未认证：登录 token 失效，请从浏览器重新复制");
        }
        if (response.status === 403) {
            throw new Error("403 禁止访问：token 格式错误或非登录 token");
        }
        if (!response.ok) {
            throw new Error(`账号信息查询失败：[${response.status}] ${response.statusText}`);
        }
        const body = (await response.json()) as {
            id?: string;
            username?: string;
            points?: number;
            balance?: number;
            account_info?: {
                balance?: number;
                vouchers?: Array<{ voucher_id: number; name: string; available: number; total: number; used: number; expire_at: number | null }>;
                enable_extra_usage?: boolean;
            };
            usage_infos?: Array<{ key: string; desc: string; used_count: number; pending_count: number; total_count: number; reset_time: number }>;
        };
        const ai = body.account_info ?? {};
        const vouchers = (ai.vouchers ?? []).map((v) => ({
            voucherId: v.voucher_id,
            name: v.name,
            available: toNumber(v.available),
            total: toNumber(v.total),
            used: toNumber(v.used),
            expireAt: typeof v.expire_at === "number" ? v.expire_at : null,
        }));
        const now = Date.now() / 1000;
        const validVouchers = vouchers.filter((v) => v.available > 0 && (v.expireAt === null || v.expireAt > now));
        const voucherAvailablePoints = validVouchers.reduce((s, v) => s + v.available, 0);
        return {
            balance: toNumber(ai.balance ?? body.balance),
            vouchers,
            voucherAvailablePoints,
            voucherAvailableCny: voucherAvailablePoints / 5000,
            earliestVoucherExpiry: validVouchers.length ? Math.min(...validVouchers.map((v) => v.expireAt ?? Infinity)) : null,
            enableExtraUsage: ai.enable_extra_usage ?? true,
            usageInfos: (body.usage_infos ?? []).map((u) => ({
                key: u.key,
                desc: u.desc,
                usedCount: toNumber(u.used_count),
                pendingCount: toNumber(u.pending_count),
                totalCount: toNumber(u.total_count),
                resetTime: toNumber(u.reset_time),
            })),
        };
    } finally {
        clearTimeout(timer);
    }
}

/** 带 TTL 缓存的账号信息查询（按 token 粒度）；查询失败返回 undefined（不抛错） */
export async function getAccountInfoCached(loginToken: string, ttlSec: number): Promise<AccountInfo | undefined> {
    if (ttlSec > 0) {
        const cached = accountInfoCache.get(loginToken);
        if (cached && Date.now() - cached.checkedAt < ttlSec * 1000) {
            return cached.info;
        }
    }
    try {
        const info = await queryAccountInfo(loginToken);
        accountInfoCache.set(loginToken, { info, checkedAt: Date.now() });
        return info;
    } catch (err) {
        logger.warn("key.accountInfo", {
            error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
    }
}

/** 账号信息 TTL 缓存（按 token 粒度） */
interface AccountInfoCacheEntry {
    info: AccountInfo;
    checkedAt: number;
}
const accountInfoCache = new Map<string, AccountInfoCacheEntry>();

// ---------------------------------------------------------------------------
// 余额查询
// ---------------------------------------------------------------------------

/**
 * 查询账号余额详情（GET /api/usage-summary）。
 *
 * ⚠️ 2026-09-23 实测：该端点已 404（平台改版，数据源迁移至
 * `platform.senseaudio.cn/api/user/self`，Bearer PASETO token 认证）。
 * 本函数会稳定失败，调用方（getBalanceDetailCached）静默降级返回 undefined。
 *
 * @throws 网络错误 / 非 2xx / code!==0 / 401（cookie 失效）
 */
export async function queryBalanceDetail(cookie: string): Promise<BalanceDetail> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(USAGE_SUMMARY_URL, {
            headers: {
                Cookie: `tr_session=${cookie}`,
                Accept: "application/json",
            },
            signal: controller.signal,
        });
        if (response.status === 401) {
            throw new Error("401 未认证：tr_session Cookie 失效或格式错误");
        }
        if (!response.ok) {
            throw new Error(`余额查询失败：[${response.status}] ${response.statusText}`);
        }
        const body = (await response.json()) as {
            code: number;
            message?: string;
            data?: {
                balanceCny?: number | string;
                availableBalanceCny?: number | string;
                expiringBalanceCny?: number | string;
                nextExpiryAt?: string | null;
            };
        };
        if (body.code !== 0 || !body.data) {
            throw new Error(`余额查询返回错误：code=${body.code} message=${body.message ?? ""}`);
        }
        // 防御：API 可能以字符串返回金额（避免浮点精度问题），
        // 统一强制转为 number，否则调用方 balance.toFixed() 会抛 "toFixed is not a function"。
        return {
            balanceCny: toNumber(body.data.balanceCny),
            availableBalanceCny: toNumber(body.data.availableBalanceCny),
            expiringBalanceCny: toNumber(body.data.expiringBalanceCny),
            nextExpiryAt: typeof body.data.nextExpiryAt === "string" && body.data.nextExpiryAt ? body.data.nextExpiryAt : null,
        };
    } finally {
        clearTimeout(timer);
    }
}

/** 防御：API 金额字段可能以字符串返回，统一转 number，非法值兜底 0 */
function toNumber(v: number | string | undefined): number {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
}

/**
 * 查询账号可用余额（GET /api/usage-summary）。
 * @throws 网络错误 / 非 2xx / code!==0 / 401（cookie 失效）
 * @returns availableBalanceCny
 */
export async function queryAccountBalance(cookie: string): Promise<number> {
    return (await queryBalanceDetail(cookie)).availableBalanceCny;
}

// ---------------------------------------------------------------------------
// API Key 列表查询（GET /api/api-keys）
// ---------------------------------------------------------------------------

/** API Key 列表条目（GET /api/api-keys 的 data 数组元素） */
export interface ApiKeyListItem {
    /** Key ID（UUID） */
    id: string;
    /** Key 名称 */
    name: string;
    /** 脱敏 Key（如 sk_tr_68****7R0gHo） */
    maskedKey: string;
    /** Key 前缀（如 sk_tr_68Hxko） */
    keyPrefix: string;
    /** 状态：enabled / disabled */
    status: string;
    /** 最近使用时间（ISO 8601 UTC），可能为 null */
    lastUsedAt: string | null;
    /** 创建时间（ISO 8601 UTC） */
    createdAt: string;
}

const API_KEYS_URL = "https://senseaudio.cn/api/api-keys";

/**
 * 查询 cookie 对应账号下的全部 API Key 列表（GET /api/api-keys）。
 *
 * ⚠️ 2026-09-23 实测：该端点已 404（平台改版，数据源迁移至
 * `platform.senseaudio.cn/api/apikey/default`，Bearer PASETO token 认证）。
 * 本函数会稳定失败，调用方（getApiKeysByCookieCached）静默降级返回 undefined。
 *
 * 历史实测（2026-08-24，端点尚存时）：仅需 `tr_session` cookie 即可调用。
 *
 * @throws 网络错误 / 非 2xx / code!==0 / 401（cookie 失效）
 */
export async function queryApiKeysByCookie(cookie: string): Promise<ApiKeyListItem[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(API_KEYS_URL, {
            headers: {
                Cookie: `tr_session=${cookie}`,
                Accept: "application/json",
            },
            signal: controller.signal,
        });
        if (response.status === 401) {
            throw new Error("401 未认证：tr_session Cookie 失效或格式错误");
        }
        if (!response.ok) {
            throw new Error(`API Key 列表查询失败：[${response.status}] ${response.statusText}`);
        }
        const body = (await response.json()) as {
            code: number;
            message?: string;
            data?: ApiKeyListItem[];
        };
        if (body.code !== 0 || !Array.isArray(body.data)) {
            throw new Error(`API Key 列表查询返回错误：code=${body.code} message=${body.message ?? ""}`);
        }
        return body.data;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 带 TTL 缓存的 API Key 列表查询（按 cookie 粒度）。
 * @returns key 列表；查询失败返回 undefined（不抛错）
 */
export async function getApiKeysByCookieCached(
    cookie: string,
    ttlSec: number,
): Promise<ApiKeyListItem[] | undefined> {
    if (ttlSec > 0) {
        const cached = apiKeyListCache.get(cookie);
        if (cached && Date.now() - cached.checkedAt < ttlSec * 1000) {
            return cached.list;
        }
    }
    try {
        const list = await queryApiKeysByCookie(cookie);
        apiKeyListCache.set(cookie, { list, checkedAt: Date.now() });
        return list;
    } catch (err) {
        logger.warn("key.apiKeysList", {
            cookie: maskCookieForLog(cookie),
            error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
    }
}

/** API Key 列表 TTL 缓存（按 cookie 粒度） */
interface ApiKeyListCacheEntry {
    list: ApiKeyListItem[];
    checkedAt: number;
}
const apiKeyListCache = new Map<string, ApiKeyListCacheEntry>();

/**
 * 带 TTL 缓存的余额详情查询（按 cookie 粒度）。
 * @returns 余额详情；查询失败返回 undefined（不抛错，调用方回退被动检测）
 */
export async function getBalanceDetailCached(cookie: string, ttlSec: number): Promise<BalanceDetail | undefined> {
    if (ttlSec > 0) {
        const cached = balanceCache.get(cookie);
        if (cached && Date.now() - cached.checkedAt < ttlSec * 1000) {
            return cached.detail;
        }
    }
    try {
        const detail = await queryBalanceDetail(cookie);
        balanceCache.set(cookie, { detail, checkedAt: Date.now() });
        return detail;
    } catch (err) {
        logger.warn("key.balanceCheck", {
            cookie: maskCookieForLog(cookie),
            error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
    }
}

/**
 * 带 TTL 缓存的余额查询（按 cookie 粒度，返回可用余额）。
 * @returns 可用余额数值；查询失败返回 undefined（不抛错，调用方回退被动检测）
 */
export async function getBalanceCached(cookie: string, ttlSec: number): Promise<number | undefined> {
    const detail = await getBalanceDetailCached(cookie, ttlSec);
    return detail?.availableBalanceCny;
}

/**
 * 格式化到期时间为 "YYYY-MM-DD"（本地时区）；无到期或非法日期返回空字符串。
 * 供管理界面展示赠送余额的有效期。
 */
export function formatExpiryDate(iso: string | null | undefined): string {
    if (!iso) {
        return "";
    }
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
        return "";
    }
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

/**
 * 检查 key 余额是否充足，并返回查询到的余额值（供日志 / 管理界面展示）。
 *
 * 判定：余额 > minBalanceCny → sufficient=true；查询失败（cookie 失效/网络）→ sufficient=true
 * （不阻塞请求，回退被动检测——余额 ≤ 0 时 API 会返回 402 触发轮换）。
 * @returns `{ sufficient, balance? }` —— balance 仅在查询成功时存在
 */
export async function checkKeyBalance(cookie: string): Promise<{ sufficient: boolean; balance?: number }> {
    const minBalance = getMinBalanceCny();
    const ttlSec = getBalanceCheckIntervalSec();
    const balance = await getBalanceCached(cookie, ttlSec);
    if (balance === undefined) {
        return { sufficient: true }; // 查询失败不阻塞
    }
    return { sufficient: balance > minBalance, balance };
}

/**
 * 判断 key 余额是否充足。
 * 余额 > minBalanceCny → true；查询失败（cookie 失效/网络）→ 返回 true（不阻塞请求，回退被动检测）。
 * 注意：默认 minBalanceCny=0 时，余额 ≤ 0（含 0 与负数）即视为不足 → 轮询时跳过该 key。
 */
export async function isKeyBalanceSufficient(cookie: string): Promise<boolean> {
    return (await checkKeyBalance(cookie)).sufficient;
}

// ---------------------------------------------------------------------------
// 手动检测
// ---------------------------------------------------------------------------

/**
 * 手动检测 key 可用性：可选查 cookie 余额 + 最小真实聊天请求。
 *
 * **不绑定 cookie 也可检测**：cookie 仅用于余额预检（可选），核心判据是
 * 最小真实聊天请求（`say ok` + `max_tokens=8`）——返回不报错即模型可用。
 *
 * 判定：
 * - 余额 ≤ minBalanceCny → { ok: false, reason: "balance" }
 * - 聊天请求 200 → { ok: true }
 * - 聊天请求 402 / INSUFFICIENT_BALANCE → { ok: false, reason: "balance" }
 * - 聊天请求 401 → { ok: false, reason: "invalid" }
 * - 网络错误 / 超时 / 其他 → { ok: null }（无法确定，保留原状态）
 *
 * @returns reason: "balance" | "invalid" | "network" | undefined
 */
export async function testKeyAvailability(
    entry: ApiKeyEntry,
    baseUrl?: string
): Promise<{ ok: boolean | null; reason?: "balance" | "invalid" | "network" }> {
    // 1. 余额检查（有 cookie 时）
    if (entry.cookie) {
        try {
            const balance = await queryAccountBalance(entry.cookie);
            if (balance <= getMinBalanceCny()) {
                return { ok: false, reason: "balance" };
            }
        } catch {
            // cookie 失效/网络失败：不阻断，继续请求校验
        }
    }

    // 2. 最小真实聊天请求
    try {
        const normalized = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
        const url = normalized.endsWith("/v1")
            ? `${normalized}/chat/completions`
            : `${normalized}/v1/chat/completions`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${entry.value}`,
                },
                body: JSON.stringify({
                    model: TEST_MODEL_ID,
                    messages: [{ role: "user", content: "say ok" }],
                    stream: false,
                    max_tokens: 8,
                }),
                signal: controller.signal,
            });

            if (response.ok) {
                return { ok: true };
            }
            const text = await response.text();
            if (response.status === 402 || text.includes("INSUFFICIENT_BALANCE") || text.includes("余额不足")) {
                return { ok: false, reason: "balance" };
            }
            if (response.status === 401) {
                return { ok: false, reason: "invalid" };
            }
            return { ok: null, reason: "network" };
        } finally {
            clearTimeout(timer);
        }
    } catch {
        return { ok: null, reason: "network" };
    }
}

/** 日志用 cookie 脱敏 */
function maskCookieForLog(cookie: string): string {
    if (cookie.length <= 8) {
        return `${cookie.slice(0, 2)}****`;
    }
    return `${cookie.slice(0, 5)}****${cookie.slice(-4)}`;
}
