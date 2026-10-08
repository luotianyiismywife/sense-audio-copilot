/**
 * 瞬态错误分类测试（`src/keys/health.ts` + `src/keys/config.ts`）。
 *
 * 核心断言：**500 是平台问题，不是 key 问题** ——
 * 它应命中「瞬态重试」但**不**命中「key 轮换」，因此不标记 key、不换 key。
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
const vscodeShim = {
    workspace: {
        getConfiguration: () => ({
            get: (key, fallback) => (key in configOverrides ? configOverrides[key] : fallback),
        }),
    },
};
Module._load = function (request, parent, isMain) {
    if (request === "vscode") {
        return vscodeShim;
    }
    return originalLoad.call(this, request, parent, isMain);
};

const { isKeyRotationError, isTransientRetryError, getKeyRotationReason } = require("../out/keys/health.js");
const { getTransientRetryStatusCodes, getRotationStatusCodes } = require("../out/keys/config.js");

let passed = 0;
function check(name, fn) {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
}

/** 构造与真实错误消息同形的 Error（provider 抛出的格式） */
const apiError = (status, body = "") =>
    new Error(`API error: [${status}] Internal Server Error ${body} URL: https://api.senseaudio.cn/v1/chat/completions`);

// ---------------------------------------------------------------------------
// 1. 默认状态码列表
// ---------------------------------------------------------------------------
console.log("默认状态码列表");

check("transientRetryStatusCodes 默认含 500", () => {
    assert.deepEqual(getTransientRetryStatusCodes(), [429, 500, 503]);
});

check("rotationStatusCodes 默认不含 500（500 不该换 key）", () => {
    assert.deepEqual(getRotationStatusCodes(), [401, 402, 429, 503]);
    assert.ok(!getRotationStatusCodes().includes(500));
});

// ---------------------------------------------------------------------------
// 2. 500 的分类（本次需求核心）
// ---------------------------------------------------------------------------
console.log("500 Internal Server Error 分类");

check("500 命中瞬态重试", () => {
    assert.equal(isTransientRetryError(apiError(500)), true);
});

check("500 不命中 key 轮换（不标记 key、不换 key）", () => {
    assert.equal(isKeyRotationError(apiError(500)), false);
});

check("真实 500 响应体（服务繁忙 / ref_code 500000）", () => {
    const err = apiError(500, '{"code":"internal","message":"服务繁忙，请稍后再试","ref_code":500000,"ref_scope":"common"}');
    assert.equal(isTransientRetryError(err), true);
    assert.equal(isKeyRotationError(err), false);
});

// ---------------------------------------------------------------------------
// 3. 429 / 503 仍走轮换（回归：不能因为加 500 而破坏原有行为）
// ---------------------------------------------------------------------------
console.log("429 / 503 仍走轮换（回归）");

check("429 同时命中瞬态重试与轮换", () => {
    assert.equal(isTransientRetryError(apiError(429)), true);
    assert.equal(isKeyRotationError(apiError(429)), true);
});

check("503 同时命中瞬态重试与轮换", () => {
    assert.equal(isTransientRetryError(apiError(503)), true);
    assert.equal(isKeyRotationError(apiError(503)), true);
});

// ---------------------------------------------------------------------------
// 4. 确定性错误：既不重试也不轮换
// ---------------------------------------------------------------------------
console.log("确定性错误");

check("400 既不重试也不轮换", () => {
    assert.equal(isTransientRetryError(apiError(400)), false);
    assert.equal(isKeyRotationError(apiError(400)), false);
});

check("403 既不重试也不轮换", () => {
    assert.equal(isTransientRetryError(apiError(403)), false);
    assert.equal(isKeyRotationError(apiError(403)), false);
});

// ---------------------------------------------------------------------------
// 5. 401 / 402 走轮换但不重试
// ---------------------------------------------------------------------------
console.log("401 / 402");

check("401 轮换但不重试", () => {
    assert.equal(isKeyRotationError(apiError(401)), true);
    assert.equal(isTransientRetryError(apiError(401)), false);
});

check("402 轮换但不重试", () => {
    assert.equal(isKeyRotationError(apiError(402)), true);
    assert.equal(isTransientRetryError(apiError(402)), false);
});

// ---------------------------------------------------------------------------
// 6. 失效原因提取
// ---------------------------------------------------------------------------
console.log("getKeyRotationReason");

check("500 归类为 api_error（非瞬态原因，故不会被持久化）", () => {
    assert.equal(getKeyRotationReason(apiError(500)), "api_error");
});

check("429 / 503 归类为瞬态原因", () => {
    assert.equal(getKeyRotationReason(apiError(429)), "rate_limited");
    assert.equal(getKeyRotationReason(apiError(503)), "server_error");
});

// ---------------------------------------------------------------------------
// 7. 状态码优先：文本不单独触发分类（回归：429/503 响应体偶然含
//    "余额不足"时不得误分类为 balance 并持久化禁用 key）
// ---------------------------------------------------------------------------
console.log("状态码优先（文本不单独触发）");

check("429 + 响应体含'余额不足' → 仍归类为 rate_limited（非 balance）", () => {
    const err = apiError(429, '{"error":{"message":"余额不足或请求过于频繁"}}');
    assert.equal(getKeyRotationReason(err), "rate_limited");
});

check("503 + 响应体含'余额不足' → 仍归类为 server_error（非 balance）", () => {
    const err = apiError(503, "服务端繁忙，账户余额不足");
    assert.equal(getKeyRotationReason(err), "server_error");
});

check("402 + 响应体含'余额不足' → 归类为 balance", () => {
    const err = apiError(402, '{"error":{"message":"余额不足"}}');
    assert.equal(getKeyRotationReason(err), "balance");
});

check("402 状态码边界：status 4020 不误匹配 status 402", () => {
    const err = new Error("API error: status 4020 some error");
    assert.notEqual(getKeyRotationReason(err), "balance");
});

check("401 + 响应体含'余额不足' → 仍归类为 invalid（非 balance）", () => {
    const err = apiError(401, "无效 Key，余额不足");
    assert.equal(getKeyRotationReason(err), "invalid");
});

// ---------------------------------------------------------------------------
// 8. 瞬态上游错误（upstream_stream_error，400）—— 平台侧问题，不是 key 问题
//    （2026-10-09 实测：曾被当作 api_error 持久化禁用 key）
// ---------------------------------------------------------------------------
console.log("瞬态上游错误 upstream_stream_error");

const upstreamErr = () =>
    new Error(
        'API error: [400] Bad Request\n{"is_bifrost_error":false,"error":{"type":"api_error","code":"upstream_stream_error","message":"The upstream model stream ended unexpectedly. Please retry the request."}}\n\nURL: https://api.senseaudio.cn/v1/chat/completions'
    );

check("upstream_stream_error 命中瞬态重试（应退避重试同一个 key）", () => {
    assert.equal(isTransientRetryError(upstreamErr()), true);
});

check("upstream_stream_error 归类为 server_error（仅冷却，不持久化）", () => {
    assert.equal(getKeyRotationReason(upstreamErr()), "server_error");
});

check("upstream_stream_error 不命中轮换（默认配置）", () => {
    assert.equal(isKeyRotationError(upstreamErr()), false);
});

check("即使 400 被配置进轮换状态码，upstream_stream_error 仍不轮换", () => {
    configOverrides["apiKeyRotationStatusCodes"] = [401, 402, 429, 503, 400];
    try {
        assert.equal(isKeyRotationError(upstreamErr()), false);
        assert.equal(isTransientRetryError(upstreamErr()), true);
        assert.equal(getKeyRotationReason(upstreamErr()), "server_error");
    } finally {
        delete configOverrides["apiKeyRotationStatusCodes"];
    }
});

check("普通 400（非 upstream_stream_error）在 400 入轮换配置时仍轮换", () => {
    configOverrides["apiKeyRotationStatusCodes"] = [401, 402, 429, 503, 400];
    try {
        assert.equal(isKeyRotationError(apiError(400)), true);
    } finally {
        delete configOverrides["apiKeyRotationStatusCodes"];
    }
});

Module._load = originalLoad;
console.log(`\ntransient retry: ${passed} checks passed`);
