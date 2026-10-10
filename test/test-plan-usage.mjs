/**
 * 套餐用量快照模块测试（`src/balance/planUsage.ts`）。
 *
 * 覆盖：
 *  1. 窗口归一化（classifyWindow / getWindowLabel）—— 各平台 key 命名宽容匹配
 *  2. 百分比计算（getWindowPercent）—— 含 pending 计入、超额不截断、total=0 兜底
 *  3. 超额判定（isWindowExhausted / isPlanExhausted）
 *  4. 倒计时格式化（formatResetDuration）—— 含过期/非法值
 *  5. 摘要格式化（formatUsageSummary / formatWindowLine / formatBalanceSummary）
 *  6. 快照构建（buildSnapshot）—— 余额换算（POINTS_PER_CNY）
 *  7. 真实 API 响应夹具回归（2026-09-27 实测样本，含代金券 200 倍换算 bug 回归）
 *
 * 运行前需 `npm run compile`。
 * 用法：node test/test-plan-usage.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ── VS Code 运行时 shim（planUsage 间接依赖 config.ts 的 getConfiguration） ──
const Module = require("node:module");
const originalLoad = Module._load;
const vscodeShim = {
    workspace: {
        getConfiguration: () => ({
            get: (_key, fallback) => fallback,
        }),
    },
};
Module._load = function (request, parent, isMain) {
    if (request === "vscode") {
        return vscodeShim;
    }
    return originalLoad.call(this, request, parent, isMain);
};

const {
    buildSnapshot,
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
} = require("../out/balance/planUsage.js");
const { POINTS_PER_CNY } = require("../out/balance/accountInfo.js");

let passed = 0;
function check(name, fn) {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
}

// ---------------------------------------------------------------------------
// 1. 窗口归一化
// ---------------------------------------------------------------------------
console.log("classifyWindow / getWindowLabel");

check("SenseAudio 原生 key 归类正确", () => {
    assert.equal(classifyWindow("credit_5h_limit", "5小时积分"), "rolling");
    assert.equal(classifyWindow("credit_7d_limit", "每周全部模型积分"), "weekly");
    assert.equal(classifyWindow("credit_30d_limit", "30天积分"), "monthly");
});

check("上游 opencode-go 风格 key 也能归类（移植友好）", () => {
    assert.equal(classifyWindow("rolling"), "rolling");
    assert.equal(classifyWindow("weekly"), "weekly");
    assert.equal(classifyWindow("monthly"), "monthly");
    assert.equal(classifyWindow("5h"), "rolling");
    assert.equal(classifyWindow("7d"), "weekly");
    assert.equal(classifyWindow("30d"), "monthly");
});

check("无法识别时回退 other", () => {
    assert.equal(classifyWindow("credit_1y_limit", "年度积分"), "other");
});

check("getWindowLabel 输出短标签", () => {
    assert.equal(getWindowLabel({ key: "credit_5h_limit", desc: "5小时积分" }), "5H");
    assert.equal(getWindowLabel({ key: "credit_7d_limit", desc: "每周全部模型积分" }), "Week");
    assert.equal(getWindowLabel({ key: "credit_30d_limit", desc: "30天积分" }), "Month");
    // other → 用原始 desc
    assert.equal(getWindowLabel({ key: "credit_1y_limit", desc: "年度积分" }), "年度积分");
});

// ---------------------------------------------------------------------------
// 2. 百分比计算
// ---------------------------------------------------------------------------
console.log("getWindowPercent");

const win = (used, total, pending = 0) => ({
    key: "credit_5h_limit",
    desc: "5小时积分",
    usedCount: used,
    pendingCount: pending,
    totalCount: total,
    resetTime: 0,
});

check("常规百分比", () => {
    assert.equal(getWindowPercent(win(6500, 10000)), 65);
    assert.equal(getWindowPercent(win(0, 10000)), 0);
});

check("pending 计入已用（与平台网页口径一致）", () => {
    assert.equal(getWindowPercent(win(5000, 10000, 1500)), 65);
});

check("超额不截断（便于察觉已进入按量计费）", () => {
    // 实测 Free 版 30 天窗口 10,012 / 10,000 → 平台显示 100%，我们显示 100%
    assert.equal(getWindowPercent(win(10012, 10000)), 100);
    // 超额更多时如实显示
    assert.equal(getWindowPercent(win(15000, 10000)), 150);
});

check("total=0 / 非法值兜底 0", () => {
    assert.equal(getWindowPercent(win(100, 0)), 0);
    assert.equal(getWindowPercent(win(100, NaN)), 0);
    assert.equal(getWindowPercent(win(100, -5)), 0);
});

// ---------------------------------------------------------------------------
// 3. 超额判定与计费模式（两套规则不可混淆）
// ---------------------------------------------------------------------------
console.log("isWindowExhausted / isPlanExhausted / billingMode");

check("isWindowExhausted 边界", () => {
    assert.equal(isWindowExhausted(win(9999, 10000)), false);
    assert.equal(isWindowExhausted(win(10000, 10000)), true);
    assert.equal(isWindowExhausted(win(10001, 10000)), true);
    assert.equal(isWindowExhausted(win(9000, 10000, 1000)), true); // pending 计入
    assert.equal(isWindowExhausted(win(100, 0)), false); // 无套餐不算耗尽
});

const monthly = (used, total) => ({
    key: "credit_30d_limit",
    desc: "30天积分",
    usedCount: used,
    pendingCount: 0,
    totalCount: total,
    resetTime: 0,
});

check("isPlanExhausted 只看月度额度窗口（5h/周耗尽不算）", () => {
    const snap = (windows) => buildSnapshot({
        balance: 0, vouchers: [], voucherAvailablePoints: 0, voucherAvailableCny: 0,
        earliestVoucherExpiry: null, enableExtraUsage: true, status: "NORMAL", usageInfos: windows,
    });
    // 5h 耗尽但月度未耗尽 → 套餐未耗尽（5h 只是限流）
    assert.equal(isPlanExhausted(snap([win(10000, 10000), monthly(0, 10000)])), false);
    // 月度耗尽 → 套餐耗尽
    assert.equal(isPlanExhausted(snap([win(0, 10000), monthly(10000, 10000)])), true);
    // 无月度窗口 → 无法判定，视为未耗尽
    assert.equal(isPlanExhausted(snap([win(10000, 10000)])), false);
    assert.equal(isPlanExhausted(null), false);
});

check("billingMode: 额度内 → plan", () => {
    const snap = buildSnapshot({
        balance: 0, vouchers: [], voucherAvailablePoints: 0, voucherAvailableCny: 0,
        earliestVoucherExpiry: null, enableExtraUsage: true, status: "NORMAL",
        usageInfos: [win(5000, 10000), monthly(1000, 10000)],
    });
    assert.equal(snap.billingMode, "plan");
});

check("billingMode: 额度耗尽 + 开启余额自动支付 → extra（按量计费）", () => {
    const snap = buildSnapshot({
        balance: 0, vouchers: [], voucherAvailablePoints: 0, voucherAvailableCny: 0,
        earliestVoucherExpiry: null, enableExtraUsage: true, status: "NORMAL",
        usageInfos: [win(0, 10000), monthly(10012, 10000)],
    });
    assert.equal(snap.billingMode, "extra");
    assert.equal(snap.extraUsageEnabled, true);
});

check("billingMode: 额度耗尽 + 未开启余额自动支付 → free（降级 Free 版）", () => {
    const snap = buildSnapshot({
        balance: 0, vouchers: [], voucherAvailablePoints: 0, voucherAvailableCny: 0,
        earliestVoucherExpiry: null, enableExtraUsage: false, status: "NORMAL",
        usageInfos: [win(0, 10000), monthly(10012, 10000)],
    });
    assert.equal(snap.billingMode, "free");
    assert.equal(snap.extraUsageEnabled, false);
});

check("quotaWindow / rateLimitWindows 正确分类", () => {
    const snap = buildSnapshot({
        balance: 0, vouchers: [], voucherAvailablePoints: 0, voucherAvailableCny: 0,
        earliestVoucherExpiry: null, enableExtraUsage: true, status: "NORMAL",
        usageInfos: [win(0, 10000), { ...win(0, 10000), key: "credit_7d_limit", desc: "每周" }, monthly(0, 10000)],
    });
    assert.equal(snap.quotaWindow.key, "credit_30d_limit");
    assert.equal(snap.rateLimitWindows.length, 2);
    assert.deepEqual(snap.rateLimitWindows.map((w) => w.key), ["credit_5h_limit", "credit_7d_limit"]);
});

check("getPrimaryWindow 优先 5h 窗口", () => {
    const snap = buildSnapshot({
        balance: 0, vouchers: [], voucherAvailablePoints: 0, voucherAvailableCny: 0,
        earliestVoucherExpiry: null, enableExtraUsage: true, status: "NORMAL",
        usageInfos: [monthly(0, 10000), win(0, 10000)],
    });
    assert.equal(getPrimaryWindow(snap).key, "credit_5h_limit");
    assert.equal(getPrimaryWindow(null), undefined);
});

// ---------------------------------------------------------------------------
// 4. 倒计时格式化
// ---------------------------------------------------------------------------
console.log("formatResetDuration");

check("小时+分钟", () => {
    const now = 1_000_000_000_000;
    const in2h13m = (now + (2 * 60 + 13) * 60_000) / 1000;
    assert.equal(formatResetDuration(in2h13m, now), "2H13M");
});

check("仅分钟", () => {
    const now = 1_000_000_000_000;
    const in45m = (now + 45 * 60_000) / 1000;
    assert.equal(formatResetDuration(in45m, now), "45M");
});

check("不足 1 分钟显示 1M（不显示 0M）", () => {
    const now = 1_000_000_000_000;
    assert.equal(formatResetDuration((now + 10_000) / 1000, now), "1M");
});

check("已过期 / 非法值返回空字符串", () => {
    const now = 1_000_000_000_000;
    assert.equal(formatResetDuration((now - 60_000) / 1000, now), "");
    assert.equal(formatResetDuration(null, now), "");
    assert.equal(formatResetDuration(undefined, now), "");
    assert.equal(formatResetDuration(NaN, now), "");
});

// ---------------------------------------------------------------------------
// 5. 摘要格式化
// ---------------------------------------------------------------------------
console.log("formatUsageSummary / formatWindowLine / formatBalanceSummary");

const sampleSnapshot = {
    info: {},
    windows: [
        win(0, 10000),
        { ...win(0, 10000), key: "credit_7d_limit", desc: "每周全部模型积分" },
        { ...win(10012, 10000), key: "credit_30d_limit", desc: "30天积分" },
    ],
    quotaWindow: { ...win(10012, 10000), key: "credit_30d_limit", desc: "30天积分" },
    rateLimitWindows: [win(0, 10000), { ...win(0, 10000), key: "credit_7d_limit", desc: "每周全部模型积分" }],
    balance: { cashCny: 0, voucherCny: 358.78, totalCny: 358.78, earliestVoucherExpiry: null },
    extraUsageEnabled: true,
    billingMode: "extra",
    fetchedAt: 0,
};

check("formatUsageSummary 一行摘要", () => {
    assert.equal(formatUsageSummary(sampleSnapshot), "5H: 0% \u00b7 Week: 0% \u00b7 Month: 100%");
    assert.equal(formatUsageSummary(null), "");
    assert.equal(formatUsageSummary({ ...sampleSnapshot, windows: [] }), "");
});

check("formatWindowLine 带绝对积分", () => {
    assert.equal(formatWindowLine(win(6500, 10000)), "5H——65% (6,500 / 10,000 积分)");
    // total=0 时省略积分部分
    assert.equal(formatWindowLine(win(0, 0)), "5H——0%");
});

check("formatBillingModeLine 区分三种模式", () => {
    assert.match(formatBillingModeLine(sampleSnapshot), /按量计费/);
    assert.match(formatBillingModeLine({ ...sampleSnapshot, billingMode: "free" }), /降级 Free/);
    assert.match(formatBillingModeLine({ ...sampleSnapshot, billingMode: "plan" }), /不扣余额/);
    assert.equal(formatBillingModeLine(null), "");
});

check("formatBalanceSummary 合计余额（2026-10-10 改版：不再分开显示赠送）", () => {
    assert.equal(formatBalanceSummary(sampleSnapshot), "¥358.78");
    const cashOnly = { ...sampleSnapshot, balance: { cashCny: 12.34, voucherCny: 0, totalCny: 12.34, earliestVoucherExpiry: null } };
    assert.equal(formatBalanceSummary(cashOnly), "¥12.34");
    assert.equal(formatBalanceSummary(null), "");
});

// ---------------------------------------------------------------------------
// 6. 快照构建 + 余额换算
// ---------------------------------------------------------------------------
console.log("buildSnapshot / POINTS_PER_CNY");

check("POINTS_PER_CNY = 1,000,000（2026-09-27 实测校正）", () => {
    assert.equal(POINTS_PER_CNY, 1_000_000);
});

check("buildSnapshot 归一化余额与计费模式", () => {
    const info = {
        balance: 0,
        vouchers: [],
        voucherAvailablePoints: 358_779_431,
        voucherAvailableCny: 358_779_431 / POINTS_PER_CNY,
        earliestVoucherExpiry: 1792168235,
        enableExtraUsage: true,
        status: "NORMAL",
        usageInfos: sampleSnapshot.windows,
    };
    const snap = buildSnapshot(info, 12345);
    assert.equal(snap.fetchedAt, 12345);
    assert.equal(snap.extraUsageEnabled, true);
    assert.equal(snap.billingMode, "extra"); // 月度窗口 10,012/10,000 已耗尽
    assert.equal(snap.windows.length, 3);
    assert.equal(snap.quotaWindow.key, "credit_30d_limit");
    assert.equal(snap.rateLimitWindows.length, 2);
    assert.equal(snap.balance.cashCny, 0);
    assert.equal(snap.balance.voucherCny, 358.779431);
    assert.equal(snap.balance.totalCny, 358.779431);
    assert.equal(snap.balance.earliestVoucherExpiry, 1792168235);
});

// ---------------------------------------------------------------------------
// 7. 真实 API 响应夹具回归（2026-09-27 实测）
// ---------------------------------------------------------------------------
console.log("真实 API 夹具回归（2026-09-27 实测样本）");

// 精简自真实响应：18 张代金券 available 合计 358,779,431 → 网页显示 358.78 元
const REAL_VOUCHER_AVAILABLE_SUM = 358_779_431;
const REAL_USAGE_INFOS = [
    { key: "credit_5h_limit", desc: "5小时积分", used_count: 0, pending_count: 0, total_count: 10000, reset_time: 1790495847 },
    { key: "credit_7d_limit", desc: "每周全部模型积分", used_count: 0, pending_count: 0, total_count: 10000, reset_time: 1790524800 },
    { key: "credit_30d_limit", desc: "30天积分", used_count: 10012, pending_count: 0, total_count: 10000, reset_time: 1792166400 },
];

check("代金券换算与网页一致（358.78 元，非 200 倍误差）", () => {
    const cny = REAL_VOUCHER_AVAILABLE_SUM / POINTS_PER_CNY;
    assert.equal(cny.toFixed(2), "358.78");
    // 回归：旧代码用 /5000 会得到 71,755.89（200 倍）
    assert.notEqual((REAL_VOUCHER_AVAILABLE_SUM / 5000).toFixed(2), "358.78");
});

check("真实 usage_infos 归一化后百分比与平台网页一致", () => {
    const windows = REAL_USAGE_INFOS.map((u) => ({
        key: u.key,
        desc: u.desc,
        usedCount: u.used_count,
        pendingCount: u.pending_count,
        totalCount: u.total_count,
        resetTime: u.reset_time,
    }));
    assert.equal(getWindowPercent(windows[0]), 0);   // 网页 0%
    assert.equal(getWindowPercent(windows[1]), 0);   // 网页 0%
    assert.equal(getWindowPercent(windows[2]), 100); // 网页 100%（10,012 / 10,000）
    assert.equal(formatUsageSummary({ info: {}, windows, balance: {}, extraUsageEnabled: true, billingMode: "extra", quotaWindow: windows[2], rateLimitWindows: windows.slice(0, 2), fetchedAt: 0 }),
        "5H: 0% \u00b7 Week: 0% \u00b7 Month: 100%");
});

check("真实样本：月度额度耗尽 + 余额自动支付开启 → extra 模式", () => {
    const snap = buildSnapshot({
        balance: 0,
        vouchers: [],
        voucherAvailablePoints: REAL_VOUCHER_AVAILABLE_SUM,
        voucherAvailableCny: REAL_VOUCHER_AVAILABLE_SUM / POINTS_PER_CNY,
        earliestVoucherExpiry: 1792168235,
        enableExtraUsage: true,
        status: "NORMAL",
        usageInfos: REAL_USAGE_INFOS.map((u) => ({
            key: u.key, desc: u.desc, usedCount: u.used_count,
            pendingCount: u.pending_count, totalCount: u.total_count, resetTime: u.reset_time,
        })),
    });
    // 5h/周窗口 0% 但月度 100% → 套餐额度耗尽，按量计费
    assert.equal(snap.billingMode, "extra");
    assert.equal(isPlanExhausted(snap), true);
    // 5h 窗口未耗尽（限流窗口独立于额度）
    assert.equal(isWindowExhausted(snap.rateLimitWindows[0]), false);
});

check("真实 reset_time 可格式化为倒计时", () => {
    // 用 reset_time 前 2 小时的时间点作为 now
    const resetSec = REAL_USAGE_INFOS[0].reset_time;
    const now = (resetSec - 2 * 3600 - 13 * 60) * 1000;
    assert.equal(formatResetDuration(resetSec, now), "2H13M");
});

Module._load = originalLoad;
console.log(`\nplan usage: ${passed} checks passed`);
