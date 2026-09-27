/**
 * 余额 / 账号模块入口（barrel）。
 *
 * 实现按职责拆分：
 * - `config.ts`      — 阈值 / TTL 配置读取与通用工具
 * - `accountInfo.ts` — 平台用户中心账号信息（登录 PASETO token）+ 到期日格式化
 * - `planUsage.ts`   — 套餐用量快照（5h/周/月窗口 + 余额，对标上游 goUsage.ts）
 * - `availability.ts`— key 可用性手动检测（最小真实聊天请求）
 *
 * 历史背景：旧平台 cookie 端点 `senseaudio.cn/api/usage-summary` 与 `/api/api-keys`
 * 已于 2026-09-23 实测 404（平台改版为三域认证体系），相关代码已删除。
 * 余额数据源现为 `platform.senseaudio.cn/api/user/self`（Bearer PASETO token）。
 */

export { getMinBalanceCny, getBalanceCheckIntervalSec } from "./config";
export {
    queryAccountInfo,
    getAccountInfoCached,
    getAccountInfoWithStatus,
    formatExpiryDate,
    POINTS_PER_CNY,
    type AccountInfo,
    type AccountInfoFetchStatus,
    type PlanUsageWindow,
} from "./accountInfo";
export {
    buildSnapshot,
    getPlanUsageCached,
    getPlanUsageSnapshot,
    getPlanUsageFetchStatus,
    classifyWindow,
    getWindowLabel,
    getWindowPercent,
    isWindowExhausted,
    isPlanExhausted,
    getPrimaryWindow,
    formatResetDuration,
    formatUsageSummary,
    formatWindowLine,
    formatBillingModeLine,
    formatBalanceSummary,
    type BalanceSnapshot,
    type PlanUsageSnapshot,
    type PlanUsageFetchStatus,
    type PlanBillingMode,
    type UsageWindowKind,
} from "./planUsage";
export { testKeyAvailability } from "./availability";
