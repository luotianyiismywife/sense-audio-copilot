/**
 * 工具调用参数拆分/分桶回归测试（`src/core/utils.ts` 的 `splitToolCallArguments`
 * + 间接覆盖 issue #2 的 id/index 分桶分裂场景）。
 *
 * 背景（issue #2）：SenseAudio 的 OpenAI 兼容流式 `tool_calls` 的参数碎片
 * 丢弃 `id`（仅剩 `index`），不符合 OpenAI 标准。修复后 A 类 chunk（带 id+index）
 * 记录 `index→id`，B 类 chunk（仅 index）解析回同一 id 桶。若分桶仍失败（极端
 * 场景），`splitToolCallArguments` 作为兜底把拼接的 `{...}{...}` 串拆成多个
 * 完整 JSON 逐个发射，不再整请求抛 "Invalid JSON for tool call"。
 *
 * 运行前需 `npm run compile`。
 * 用法：node test/test-split-tool-call-args.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ── VS Code 运行时 shim（splitToolCallArguments 内部经 parseToolCallArguments
//    → tryParseJSONObject，不依赖 vscode，但 utils 模块顶层 import 了 vscode）──
const Module = require("node:module");
const originalLoad = Module._load;
const vscodeShim = {};
Module._load = function (request, parent, isMain) {
    if (request === "vscode") {
        return vscodeShim;
    }
    return originalLoad.call(this, request, parent, isMain);
};

const { splitToolCallArguments, parseToolCallArguments } = require("../out/core/utils.js");

let passed = 0;
const pending = [];
function check(name, fn) {
    const r = fn();
    if (r && typeof r.then === "function") {
        pending.push(
            r.then(() => {
                passed++;
                console.log(`  ok  ${name}`);
            })
        );
    } else {
        passed++;
        console.log(`  ok  ${name}`);
    }
}

// ---------------------------------------------------------------------------
// 1. 正常拼接的并行工具调用 JSON 序列（issue #2 撞桶污染的兜底）
// ---------------------------------------------------------------------------
console.log("拼接 JSON 拆解（issue #2 兜底）");

check("两个并行调用拼接 → 拆成两个独立对象", () => {
    const split = splitToolCallArguments('{"tool":"read_file","path":"a.ts"}{"tool":"grep","query":"foo"}');
    assert.equal(split.length, 2);
    assert.equal(split[0].tool, "read_file");
    assert.equal(split[0].path, "a.ts");
    assert.equal(split[1].tool, "grep");
    assert.equal(split[1].query, "foo");
});

check("多个（3 个）并行调用拼接 → 全部拆出", () => {
    const split = splitToolCallArguments('{"a":1}{"b":2}{"c":3}');
    assert.equal(split.length, 3);
    assert.deepEqual(split, [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

check("对象内嵌套花括号不干扰拆解", () => {
    const split = splitToolCallArguments('{"obj":{"inner":{"x":1}}}{"next":"y"}');
    assert.equal(split.length, 2);
    assert.equal(split[0].obj.inner.x, 1);
    assert.equal(split[1].next, "y");
});

// ---------------------------------------------------------------------------
// 2. 字符串内的 { } " \ 转义不触发拆解（引号/转义状态机）
// ---------------------------------------------------------------------------
console.log("字符串内花括号/转义不误拆");

check("值里的 { } 不是 JSON 边界", () => {
    const split = splitToolCallArguments('{"text":"{not a boundary}"}{"n":2}');
    assert.equal(split.length, 2);
    assert.equal(split[0].text, "{not a boundary}");
    assert.equal(split[1].n, 2);
});

check("转义引号不破坏字符串状态，字符串内花括号不误拆", () => {
    // 实际字符串：{"q":"say \"hi\" {not boundary}"}{"n":1}
    // q 内：两个转义引号 + 花括号都在字符串内，不触发拆解
    const split = splitToolCallArguments('{"q":"say \\"hi\\" {not boundary}"}{"n":1}');
    assert.equal(split.length, 2);
    assert.equal(split[0].q, 'say "hi" {not boundary}');
    assert.equal(split[1].n, 1);
});

// ---------------------------------------------------------------------------
// 3. markdown 代码围栏剥离
// ---------------------------------------------------------------------------
console.log("markdown 围栏");

check("```json 围栏包裹的拼接串 → 剥离后拆出", () => {
    const split = splitToolCallArguments('```json\n{"a":1}{"b":2}\n```');
    assert.equal(split.length, 2);
    assert.deepEqual(split, [{ a: 1 }, { b: 2 }]);
});

// ---------------------------------------------------------------------------
// 4. 空输入 / 无法拆解
// ---------------------------------------------------------------------------
console.log("边界与无法拆解");

check("空串 → 空数组", () => {
    assert.deepEqual(splitToolCallArguments(""), []);
});

check("空白 → 空数组", () => {
    assert.deepEqual(splitToolCallArguments("   \n  "), []);
});

check("单个完整 JSON → 拆出 1 个（不因深度归零触发多次）", () => {
    const split = splitToolCallArguments('{"only":true}');
    assert.equal(split.length, 1);
    assert.equal(split[0].only, true);
});

check("单引号/中文智能引号 → repairJsonText 修复后拆出", () => {
    const split = splitToolCallArguments("{'path':'a.ts'}{'n':2}");
    assert.equal(split.length, 2);
    assert.equal(split[0].path, "a.ts");
    assert.equal(split[1].n, 2);
});

check("尾逗号（流截断样）→ 修复后拆出", () => {
    const split = splitToolCallArguments('{"a":1,}{"b":2,}');
    assert.equal(split.length, 2);
    assert.deepEqual(split, [{ a: 1 }, { b: 2 }]);
});

check("完整片段保留，尾部残缺片段被丢弃", () => {
    // 首段完整、尾段未闭合 → 只保留完整的
    const split = splitToolCallArguments('{"good":1}{broken junk');
    assert.deepEqual(split, [{ good: 1 }]);
});

// ---------------------------------------------------------------------------
// 5. 与 parseToolCallArguments 配合（单段）
// ---------------------------------------------------------------------------
console.log("与 parseToolCallArguments 配合");

check("parseToolCallArguments 对拼接串返回 undefined（需 split 兜底）", () => {
    // 这正是 issue #2 中 flush 抛 "Invalid JSON" 的输入形态
    const raw = '{"tool":"read_file","path":"a.ts"}{"tool":"grep","query":"foo"}';
    assert.equal(parseToolCallArguments(raw), undefined);
    // 但 split 能拆开
    assert.equal(splitToolCallArguments(raw).length, 2);
});

// ---------------------------------------------------------------------------
// 6. 真实 A/B 类碎片形态的兜底重组（模拟 issue #2 分桶失败后的拼接串）
// ---------------------------------------------------------------------------
console.log("真实流式碎片形态");

check("带 id 的 name 桶 + 拼接 args（A/B 碎片）经 split 重组", () => {
    // 模拟极端：分桶彻底失败时，两个并行调用的 args 拼接进同一缓冲
    const raw =
        '{"path": "/src/a.ts", "startLine": 1}{"pattern": "export function foo", "path": "/src/b.ts"}';
    const split = splitToolCallArguments(raw);
    assert.equal(split.length, 2);
    assert.equal(split[0].path, "/src/a.ts");
    assert.equal(split[0].startLine, 1);
    assert.equal(split[1].pattern, "export function foo");
    assert.equal(split[1].path, "/src/b.ts");
});

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------
Promise.all(pending).then(() => {
    console.log(`\n${passed} assertions passed`);
    if (passed > 0) {
        process.exit(0);
    }
    process.exit(1);
});