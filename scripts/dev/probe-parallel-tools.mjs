/**
 * Issue #2 回归验证：真实 API 并行工具调用的流式 tool_calls 重组。
 *
 * 复现 issue #2 场景：SenseAudio 的 OpenAI 兼容流式 tool_calls 的 B 类
 * 参数碎片丢弃 `id`（仅剩 index），旧分桶键链（id → index → lastKey → auto）
 * 导致 name（id 桶）与 args（index 桶）永不合并 → "Invalid JSON for tool call"。
 *
 * 本脚本：
 *   1. 用真实 API Key 请求多工具并行调用（流式）
 *   2. 逐 chunk 抓取原始 tool_calls 碎片（含 id/index）
 *   3. 用与生产 `OpenaiApi.processDelta` 完全一致的分桶逻辑重组
 *   4. 断言每个桶都同时有 name 和 args，且 args 是合法 JSON
 *
 * 用法:
 *   node scripts/dev/probe-parallel-tools.mjs <API_KEY> [模型ID]
 *   （默认模型 deepseek-v4.1-flash）
 */
const API_KEY = process.argv[2];
const MODEL = process.argv[3] || "deepseek-v4.1-flash";
if (!API_KEY) {
    console.error("用法: node scripts/dev/probe-parallel-tools.mjs <API_KEY> [模型ID]");
    process.exit(1);
}

const BASE = "https://api.senseaudio.cn/v1";

// 多工具定义：强制模型走并行工具调用（同时读多个文件/查多个城市）
const TOOLS = [
    {
        type: "function",
        function: {
            name: "read_file",
            description: "Read a source file's content",
            parameters: {
                type: "object",
                properties: { path: { type: "string" }, startLine: { type: "integer" } },
                required: ["path"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "grep_search",
            description: "Search for a pattern in files",
            parameters: {
                type: "object",
                properties: { query: { type: "string" }, path: { type: "string" } },
                required: ["query"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "list_dir",
            description: "List a directory's contents",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
    },
    {
        type: "function",
        function: {
            name: "get_weather",
            description: "Get weather of a city",
            parameters: {
                type: "object",
                properties: { city: { type: "string" } },
                required: ["city"],
            },
        },
    },
];

// 提示词：明确要求同时调用多个工具（触发并行）
const PROMPT =
    "请一次性并行调用多个工具：同时 read_file src/index.ts、grep_search 'export function' 于 src/core、" +
    "list_dir src/api，以及 get_weather 北京。全部在同一条回复里并行调用，不要串联等待。";

let okCount = 0;
let failCount = 0;
const failReasons = [];

function check(name, cond, detail = "") {
    if (cond) {
        okCount++;
        console.log(`  ✅ ${name}`);
    } else {
        failCount++;
        failReasons.push(`${name} ${detail}`);
        console.log(`  ❌ ${name} ${detail}`);
    }
}

// ── 生产同款分桶逻辑（镜像 src/api/openai/openaiApi.ts processDelta）──
function reassemble(chunks) {
    const buffers = new Map();      // key -> { id, name, args }
    const completed = new Set();    // 已发射（本脚本不发射，仅用于跳过）
    const indexToId = new Map();    // index → id 映射（issue #2 修复核心）
    let lastToolCallKey;

    for (const tc of chunks) {
        const tcId = typeof tc.id === "string" && tc.id ? tc.id : undefined;
        const tcIndex = typeof tc.index === "number" ? String(tc.index) : undefined;
        const func = tc.function ?? {};
        const tcName = typeof func.name === "string" && func.name ? func.name : undefined;
        let idx;
        if (tcId) {
            idx = tcId;
            if (tcIndex) indexToId.set(tcIndex, tcId);   // A 类：记录 index→id
        } else if (tcIndex) {
            const mappedId = indexToId.get(tcIndex);     // B 类：解析回 id 桶
            idx = mappedId && !completed.has(mappedId) ? mappedId : tcIndex;
        } else if (lastToolCallKey) {
            idx = lastToolCallKey;
        } else {
            let n = buffers.size;
            while (buffers.has(`auto_${n}`) || completed.has(`auto_${n}`)) n++;
            idx = `auto_${n}`;
        }
        lastToolCallKey = idx;
        if (completed.has(idx)) continue;
        const buf = buffers.get(idx) ?? { args: "" };
        if (tcId) buf.id = tcId;
        if (tcName) buf.name = tcName;
        if (typeof func.arguments === "string") buf.args += func.arguments;
        buffers.set(idx, buf);
    }
    return buffers;
}

async function run() {
    console.log(`模型: ${MODEL}`);
    console.log("请求并行工具调用（流式）...\n");

    const res = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({
            model: MODEL,
            messages: [{ role: "user", content: PROMPT }],
            tools: TOOLS,
            tool_choice: "auto",
            stream: true,
            stream_options: { include_usage: true },
        }),
    });

    const text = await res.text();
    if (!res.ok) {
        console.error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
        process.exit(1);
    }

    // 收集原始 tool_calls 碎片（A 类 id+index+name / B 类 index+args）
    const chunks = [];
    for (const line of text.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        let evt;
        try { evt = JSON.parse(payload); } catch { continue; }
        const tcs = evt.choices?.[0]?.delta?.tool_calls ?? [];
        for (const tc of tcs) chunks.push(tc);
    }

    console.log(`抓到 ${chunks.length} 个 tool_calls 碎片\n`);
    check("收到工具调用", chunks.length > 0);
    if (chunks.length === 0) {
        console.error("模型未调用任何工具，无法验证分桶。请换模型/提示词重试。");
        process.exit(0);
    }

    // 展示每个碎片的形态
    for (const [i, tc] of chunks.entries()) {
        const func = tc.function ?? {};
        console.log(
            `  chunk[${i}] index=${tc.index} id=${tc.id ?? "-"} name=${func.name ?? "-"} args=${func.arguments ? func.arguments.slice(0, 40) : "-"}`
        );
    }

    // ── 重组：生产同款分桶逻辑 ──
    const buffers = reassemble(chunks);
    console.log(`\n重组后得到 ${buffers.size} 个桶：\n`);

    for (const [key, buf] of buffers.entries()) {
        const argsValid = (() => {
            try { JSON.parse(buf.args); return true; } catch { return false; }
        })();
        console.log(
            `  桶 ${key}: name=${buf.name ?? "MISSING"} args=${buf.args.slice(0, 60)}${buf.args.length > 60 ? "..." : ""} valid=${argsValid}`
        );
    }

    // ── 核心断言：每个桶必须同时有 name 和 args，且 args 合法 JSON ──
    console.log("\n核心断言（issue #2）：");
    let allBucketsOk = true;
    let parsedArgs = [];
    for (const [key, buf] of buffers.entries()) {
        const hasName = !!buf.name;
        const hasArgs = typeof buf.args === "string" && buf.args.trim().length > 0;
        const argsValid = (() => {
            try { parsedArgs.push(JSON.parse(buf.args)); return true; } catch { return false; }
        })();
        const ok = hasName && hasArgs && argsValid;
        if (!ok) allBucketsOk = false;
        check(
            `桶 name+args 齐全且合法 JSON（name=${hasName} args=${hasArgs} valid=${argsValid}）`,
            ok,
            `key=${key} name=${buf.name ?? "MISSING"} args=${buf.args.slice(0, 60)}`
        );
    }
    check("所有桶均完整（无 name/args 分裂）", allBucketsOk);
    check("至少解析出 2 个并行工具调用", parsedArgs.length >= 2, `n=${parsedArgs.length}`);

    console.log(`\n结果: ${okCount} passed, ${failCount} failed`);
    process.exit(failCount === 0 ? 0 : 1);
}

run().catch((e) => {
    console.error("脚本异常:", e);
    process.exit(1);
});