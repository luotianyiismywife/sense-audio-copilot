/**
 * 错误分类规则测试（`src/keys/health.ts` 的 `matchErrorRule` + `src/keys/config.ts`）。
 *
 * 核心断言：**四元组（code + message + statusCode + action），只配置一处**：
 * - code（错误体 error.code 精确匹配）是主要匹配字段
 * - message 仅作可读性说明，不参与匹配
 * - statusCode 兜底（HTTP 400 被封号和上游中断复用，不能单独作为判据）
 * - action 与 key 状态一一对应：retrySameKey 状态不变 / rotateCooldown 冷却中 / rotatePersist 不可用
 *
 * 运行前需 `npm run compile`。
 * 用法：node test/test-transient-retry.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ── VS Code 运行时 shim ──
const Module = require("node:module");
const originalLoad = Module._load;
// 可覆盖的配置（测试用）：键为 senseaudio 配置项名（不含前缀）
const configOverrides = {};
// 默认 errorRules（镜像 package.json 的 default——shim 不经过 package.json）
const DEFAULT_ERROR_RULES = [
    { code: "billing", message: "计费账户已被冻结（封号）", action: "rotatePersist" },
    { code: "upstream_stream_error", message: "上游模型流意外中断", action: "retrySameKey" },
    { code: "INSUFFICIENT_BALANCE", message: "余额不足", action: "rotatePersist" },
    { statusCode: 401, message: "无效 key", action: "rotatePersist" },
    { statusCode: 402, message: "余额不足", action: "rotatePersist" },
    { statusCode: 429, message: "限流", action: "rotateCooldown" },
    { statusCode: 503, message: "服务端繁忙", action: "rotateCooldown" },
    { statusCode: 400, message: "上游中断复用 400", action: "retrySameKey" },
    { statusCode: 500, message: "内部错误", action: "retrySameKey" },
];
const vscodeShim = {
    workspace: {
        getConfiguration: () => ({
            get: (key, fallback) => (key in configOverrides ? configOverrides[key] : (fallback ?? (key === "errorRules" ? DEFAULT_ERROR_RULES : undefined))),
        }),
    },
};
Module._load = function (request, parent, isMain) {
    if (request === "vscode") {
        return vscodeShim;
    }
    return originalLoad.call(this, request, parent, isMain);
};

const { matchErrorRule, isKeyRotationError, isTransientRetryError } = require("../out/keys/health.js");
const { getErrorRules } = require("../out/keys/config.js");

let passed = 0;
function check(name, fn) {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
}

/** 构造与真实错误消息同形的 Error（provider 抛出的格式） */
const apiError = (status, body = "") =>
    new Error(`API error: [${status}] Bad Request ${body} URL: https://api.senseaudio.cn/v1/chat/completions`);

// ---------------------------------------------------------------------------
// 1. 默认规则（镜像 package.json 的 default）
// ---------------------------------------------------------------------------
console.log("默认规则");

check("默认规则 9 条（与 package.json default 一致）", () => {
    assert.equal(getErrorRules().length, DEFAULT_ERROR_RULES.length);
});

// ---------------------------------------------------------------------------
// 2. code 精确匹配（主要匹配字段）
// ---------------------------------------------------------------------------
console.log("code 精确匹配");

check("code=billing（封号，400）→ rotatePersist", () => {
    const err = apiError(400, '{"code":"billing","message":"计费账户已被冻结","ref_code":400901}');
    const rule = matchErrorRule(err);
    assert.equal(rule?.action, "rotatePersist");
    assert.equal(isKeyRotationError(err), true);
});

check("code=upstream_stream_error（上游中断，400）→ retrySameKey", () => {
    const err = apiError(400, '{"error":{"code":"upstream_stream_error","message":"Please retry the request."}}');
    const rule = matchErrorRule(err);
    assert.equal(rule?.action, "retrySameKey");
    assert.equal(isKeyRotationError(err), false);
    assert.equal(isTransientRetryError(err), true);
});

check("code=INSUFFICIENT_BALANCE（余额不足，402）→ rotatePersist", () => {
    const err = apiError(402, '{"code":"INSUFFICIENT_BALANCE","message":"余额不足"}');
    const rule = matchErrorRule(err);
    assert.equal(rule?.action, "rotatePersist");
    assert.equal(isKeyRotationError(err), true);
});

// ---------------------------------------------------------------------------
// 3. statusCode 兜底（签名未命中时）
// ---------------------------------------------------------------------------
console.log("statusCode 兑底");

check("401（无效 key）→ rotatePersist", () => {
    const err = apiError(401);
    assert.equal(matchErrorRule(err)?.action, "rotatePersist");
});

check("429/503（限流）→ rotateCooldown", () => {
    assert.equal(matchErrorRule(apiError(429))?.action, "rotateCooldown");
    assert.equal(matchErrorRule(apiError(503))?.action, "rotateCooldown");
    assert.equal(isKeyRotationError(apiError(429)), true);
    assert.equal(isTransientRetryError(apiError(429)), true);
});

check("400/500（无 code 字段）→ retrySameKey", () => {
    assert.equal(matchErrorRule(apiError(400))?.action, "retrySameKey");
    assert.equal(matchErrorRule(apiError(500))?.action, "retrySameKey");
    assert.equal(isKeyRotationError(apiError(400)), false);
    assert.equal(isTransientRetryError(apiError(400)), true);
});

check("403（不在任何规则中）→ undefined，不轮换不重试", () => {
    assert.equal(matchErrorRule(apiError(403)), undefined);
    assert.equal(isKeyRotationError(apiError(403)), false);
    assert.equal(isTransientRetryError(apiError(403)), false);
});

// ---------------------------------------------------------------------------
// 4. code 优先于 statusCode（400 复用场景）
// ---------------------------------------------------------------------------
console.log("code 优先于 statusCode");

check("400 + code=billing → rotatePersist（code 优先，非 retrySameKey）", () => {
    const err = apiError(400, '{"code":"billing","message":"计费账户已被冻结"}');
    assert.equal(matchErrorRule(err)?.action, "rotatePersist");
});

check("400 + code=upstream_stream_error → retrySameKey", () => {
    const err = apiError(400, '{"error":{"code":"upstream_stream_error"}}');
    assert.equal(matchErrorRule(err)?.action, "retrySameKey");
});

// ---------------------------------------------------------------------------
// 5. 规则可配置
// ---------------------------------------------------------------------------
console.log("规则可配置");

check("自定义规则生效（新增 code）", () => {
    configOverrides["errorRules"] = [
        { code: "my_custom_code", message: "自定义瞬态错误", action: "retrySameKey" },
    ];
    try {
        const err = apiError(400, '{"error":{"code":"my_custom_code"}}');
        assert.equal(matchErrorRule(err)?.action, "retrySameKey");
        assert.equal(isKeyRotationError(err), false);
    } finally {
        delete configOverrides["errorRules"];
    }
});

check("自定义规则生效（改 action）", () => {
    configOverrides["errorRules"] = [
        { code: "billing", message: "封号改冷却", action: "rotateCooldown" },
    ];
    try {
        const err = apiError(400, '{"code":"billing"}');
        assert.equal(matchErrorRule(err)?.action, "rotateCooldown");
        assert.equal(isTransientRetryError(err), true);
    } finally {
        delete configOverrides["errorRules"];
    }
});

check("message 不参与匹配（仅说明）", () => {
    configOverrides["errorRules"] = [
        { code: "billing", message: "这条 message 不会被匹配" },
    ].map((r) => ({ ...r, action: "rotatePersist" }));
    try {
        // message 内容不同但 code 相同 → 仍命中
        const err = apiError(400, '{"code":"billing","message":"完全不同的消息"}');
        assert.equal(matchErrorRule(err)?.action, "rotatePersist");
    } finally {
        delete configOverrides["errorRules"];
    }
});

Module._load = originalLoad;
console.log(`\nerror rules: ${passed} checks passed`);