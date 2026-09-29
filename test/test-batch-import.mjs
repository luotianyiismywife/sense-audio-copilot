/**
 * 批量导入解析器测试（`src/commands/apiKeyFlows.ts` 的 `parseBatchImport`）。
 *
 * 格式：`key---cookie---备注;key---cookie---备注;`
 *
 * 运行前需 `npm run compile`。
 * 用法：node test/test-batch-import.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ── VS Code 运行时 shim ──
const Module = require("node:module");
const originalLoad = Module._load;
const vscodeShim = {
    workspace: {
        getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    },
    window: {},
    QuickPickItemKind: { Separator: -1 },
};
Module._load = function (request, parent, isMain) {
    if (request === "vscode") {
        return vscodeShim;
    }
    return originalLoad.call(this, request, parent, isMain);
};

const { parseBatchImport } = require("../out/commands/apiKeyFlows.js");

let passed = 0;
function check(name, fn) {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
}

// ── 基本三元组 ──
check("单个完整三元组", () => {
    assert.deepEqual(parseBatchImport("sk_a---sess_b---work"), [
        { value: "sk_a", cookie: "sess_b", label: "work" },
    ]);
});

check("多个三元组（分号分隔）", () => {
    assert.deepEqual(parseBatchImport("sk_a---sess_b---work;sk_c---sess_d---backup"), [
        { value: "sk_a", cookie: "sess_b", label: "work" },
        { value: "sk_c", cookie: "sess_d", label: "backup" },
    ]);
});

check("末尾分号被忽略", () => {
    assert.deepEqual(parseBatchImport("sk_a---sess_b---work;"), [
        { value: "sk_a", cookie: "sess_b", label: "work" },
    ]);
});

// ── 空字段 ──
check("无 cookie（两个连续分隔符）", () => {
    assert.deepEqual(parseBatchImport("sk_a------work"), [
        { value: "sk_a", cookie: undefined, label: "work" },
    ]);
});

check("无备注", () => {
    assert.deepEqual(parseBatchImport("sk_a---sess_b"), [
        { value: "sk_a", cookie: "sess_b", label: undefined },
    ]);
});

check("只有 key", () => {
    assert.deepEqual(parseBatchImport("sk_a"), [{ value: "sk_a", cookie: undefined, label: undefined }]);
});

check("无 cookie 无备注（尾随分隔符）", () => {
    assert.deepEqual(parseBatchImport("sk_a---"), [{ value: "sk_a", cookie: undefined, label: undefined }]);
});

// ── 空白与容错 ──
check("前后空白被裁剪", () => {
    assert.deepEqual(parseBatchImport("  sk_a --- sess_b --- work  "), [
        { value: "sk_a", cookie: "sess_b", label: "work" },
    ]);
});

check("空条目被跳过", () => {
    assert.deepEqual(parseBatchImport(";;sk_a---sess_b---work;;"), [
        { value: "sk_a", cookie: "sess_b", label: "work" },
    ]);
});

check("缺 key 的条目被跳过", () => {
    assert.deepEqual(parseBatchImport("---sess_b---work;sk_c---sess_d---ok"), [
        { value: "sk_c", cookie: "sess_d", label: "ok" },
    ]);
});

check("空字符串返回空数组", () => {
    assert.deepEqual(parseBatchImport(""), []);
});

check("只有分隔符返回空数组", () => {
    assert.deepEqual(parseBatchImport(";;;"), []);
});

// ── 备注含分隔符 ──
check("备注中的 --- 被完整保留", () => {
    assert.deepEqual(parseBatchImport("sk_a---sess_b---my---label"), [
        { value: "sk_a", cookie: "sess_b", label: "my---label" },
    ]);
});

// ── 混合场景 ──
check("混合：完整 / 无 cookie / 只有 key", () => {
    assert.deepEqual(parseBatchImport("sk_a---sess_b---work;sk_c------backup;sk_d"), [
        { value: "sk_a", cookie: "sess_b", label: "work" },
        { value: "sk_c", cookie: undefined, label: "backup" },
        { value: "sk_d", cookie: undefined, label: undefined },
    ]);
});

console.log(`\nbatch import parser: ${passed} checks passed`);
