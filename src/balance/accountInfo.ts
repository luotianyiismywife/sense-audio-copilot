import { logger } from "../core/logger";
import { toNumber } from "./config";

/**
 * 平台用户中心账号信息查询（登录 PASETO token，2026-09-23 新端点）。
 *
 * `GET https://platform.senseaudio.cn/api/user/self`，Bearer PASETO token 认证。
 * token 来自浏览器 localStorage `user.state.token`（60 天有效）。
 */

const REQUEST_TIMEOUT_MS = 20_000;
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
 * 积分 → 元 的换算比例（**2026-09-27 实测校正**）。
 *
 * 平台网页「代金券余额」= Σ代金券 `available` / 1,000,000。
 * 实测样本（2026-09-27，Free 版账号）：18 张代金券 `available` 合计
 * 358,779,431 → 网页显示 **358.78 元**（358779431 / 1e6 = 358.779431）。
 *
 * ⚠️ **历史 bug**：本模块曾用 `5000` 作除数（注释称"1 元 = 5000 积分"），
 * 导致代金券余额显示为实际值的 **200 倍**（358.78 → 71,755.89）。已修正。
 *
 * 注意：套餐 `usage_infos` 的「积分」与代金券「积分」**不是同一单位**
 * （Free 版 30 天套餐额度 10,000 积分，而单张 ¥20 代金券即 20,000,000 积分），
 * 因此本常量**仅用于代金券换算**，不可用于套餐额度。
 */
export const POINTS_PER_CNY = 1_000_000;

/**
 * 账号余额/套餐详情（GET platform.senseaudio.cn/api/user/self，2026-09-23 实测）。
 *
 * - `vouchers` 单位是积分（1 元 = 1,000,000 积分，见 `POINTS_PER_CNY`），
 *   网页显示的「代金券余额」 = Σ可用代金券积分 / 1,000,000
 * - 扣减顺序：套餐积分 → 代金券（按到期时间先后）→ 现金余额
 */
export interface AccountInfo {
    /** 现金余额（元，备用扣减） */
    balance: number;
    /** 代金券列表（available/total/used 单位均为积分） */
    vouchers: Array<{ voucherId: number; name: string; available: number; total: number; used: number; expireAt: number | null }>;
    /** 代金券可用总额（积分） */
    voucherAvailablePoints: number;
    /** 代金券可用总额（元 = 积分 / POINTS_PER_CNY） */
    voucherAvailableCny: number;
    /** 最早到期时间（epoch 秒，无则 null） */
    earliestVoucherExpiry: number | null;
    /** 额外用量开关（套餐额度耗尽后是否回退到余额计费） */
    enableExtraUsage: boolean;
    /** 账号状态（平台原样返回，实测正常值为 `"NORMAL"`；异常值可用于识别封禁/冻结） */
    status: string;
    /** 套餐用量窗口（5小时/每周/30天） */
    usageInfos: PlanUsageWindow[];
}

/** 账号信息 TTL 缓存（按 token 粒度） */
interface AccountInfoCacheEntry {
    info: AccountInfo;
    checkedAt: number;
}
const accountInfoCache = new Map<string, AccountInfoCacheEntry>();

/**
 * 账号信息拉取结果状态。
 * - `ok`：成功
 * - `unauthorized`：401，登录 token 失效（需重新从浏览器复制）
 * - `error`：网络错误 / 403 / 其他非 2xx
 */
export type AccountInfoFetchStatus = "ok" | "unauthorized" | "error";

/** 从错误消息中判定是否为 401（`queryAccountInfo` 的 401 分支以 "401" 开头） */
function isUnauthorizedError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return message.startsWith("401") || message.includes("[401]");
}

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
                status?: string;
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
            voucherAvailableCny: voucherAvailablePoints / POINTS_PER_CNY,
            earliestVoucherExpiry: validVouchers.length ? Math.min(...validVouchers.map((v) => v.expireAt ?? Infinity)) : null,
            enableExtraUsage: ai.enable_extra_usage ?? true,
            status: typeof ai.status === "string" ? ai.status : "UNKNOWN",
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

/**
 * 带 TTL 缓存 + 状态返回的账号信息查询。
 *
 * 与 `getAccountInfoCached` 的区别：**不吞掉错误类型**，返回 `status` 供调用方
 * 区分「401 token 失效」与「一般网络失败」（状态栏与 `checkUsage` 命令需要）。
 *
 * @param force 为 true 时绕过 TTL 强制刷新（用户显式刷新）
 */
export async function getAccountInfoWithStatus(
    loginToken: string,
    ttlSec: number,
    force = false,
): Promise<{ info: AccountInfo | undefined; status: AccountInfoFetchStatus }> {
    if (!force && ttlSec > 0) {
        const cached = accountInfoCache.get(loginToken);
        if (cached && Date.now() - cached.checkedAt < ttlSec * 1000) {
            return { info: cached.info, status: "ok" };
        }
    }
    try {
        const info = await queryAccountInfo(loginToken);
        accountInfoCache.set(loginToken, { info, checkedAt: Date.now() });
        return { info, status: "ok" };
    } catch (err) {
        const status: AccountInfoFetchStatus = isUnauthorizedError(err) ? "unauthorized" : "error";
        logger.warn("key.accountInfo", {
            status,
            error: err instanceof Error ? err.message : String(err),
        });
        return { info: undefined, status };
    }
}

/** 带 TTL 缓存的账号信息查询（按 token 粒度）；查询失败返回 undefined（不抛错） */
export async function getAccountInfoCached(loginToken: string, ttlSec: number): Promise<AccountInfo | undefined> {
    return (await getAccountInfoWithStatus(loginToken, ttlSec)).info;
}

/**
 * 格式化代金券到期时间为 "YYYY-MM-DD"（本地时区）。
 * @param epochSec 到期时间（epoch 秒）；null / 非法值返回空字符串
 */
export function formatExpiryDate(epochSec: number | null | undefined): string {
    if (epochSec === null || epochSec === undefined || !Number.isFinite(epochSec)) {
        return "";
    }
    const d = new Date(epochSec * 1000);
    if (Number.isNaN(d.getTime())) {
        return "";
    }
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}
