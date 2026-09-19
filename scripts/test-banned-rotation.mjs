// 模拟运行封号 key 的完整轮换链路（不依赖 VS Code API，纯逻辑复刻）：
// 1. 封号 key 发请求 → 400 + code=billing
// 2. isKeyRotationError 命中（patterns 含 billing/计费账户已被冻结）
// 3. getKeyRotationReason → "banned"
// 4. markApiKeyExhausted → 持久化 available=false（banned 非瞬态）
// 5. isApiKeyEligible → false，pickNextApiKey 自动跳过
// 6. 全部 key 不可用报错显示 REASON_TEXT["banned"]

// ── 复刻 keyManager.ts 逻辑 ──
const TRANSIENT_REASONS = new Set(["rate_limited", "server_error"]);
const transientExhausted = new Map();

const ROTATION_STATUS_CODES = [401, 402, 429, 503];
const ROTATION_PATTERNS = [
    "余额不足", "insufficient balance", "INSUFFICIENT_BALANCE", "balance",
    "RATE_LIMITED", "UPSTREAM_RATE_LIMITED",
    "计费账户已被冻结", "billing",
];

const REASON_TEXT = {
    balance: "Balance insufficient",
    invalid: "Key invalid",
    rate_limited: "Rate limited (429)",
    server_error: "Server error (503)",
    api_error: "API error",
    unavailable: "Unavailable",
    banned: "Account banned (billing frozen)",
};

function isKeyRotationError(err) {
    const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
    for (const code of ROTATION_STATUS_CODES) {
        if (message.includes(`[${code}]`) || message.includes(`status ${code}`)) return true;
    }
    for (const pattern of ROTATION_PATTERNS) {
        if (pattern && message.includes(pattern.toLowerCase())) return true;
    }
    return false;
}

function getKeyRotationReason(err) {
    const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
    if (message.includes("[402]") || message.includes("status 402") || message.includes("insufficient_balance") || message.includes("余额不足")) return "balance";
    if (message.includes("[401]") || message.includes("status 401")) return "invalid";
    if (message.includes("[429]") || message.includes("status 429") || message.includes("rate_limited")) return "rate_limited";
    if (message.includes("[503]") || message.includes("status 503")) return "server_error";
    if (message.includes("计费账户已被冻结") || message.includes('"code":"billing"') || message.includes("ref_code:400901") || message.includes('ref_code":400901')) return "banned";
    return "api_error";
}

function markApiKeyExhausted(store, keyValue, reason) {
    if (TRANSIENT_REASONS.has(reason)) {
        transientExhausted.set(keyValue, { exhaustedAt: Date.now(), reason });
        return "cooldown-only (transient)";
    }
    const entry = store.keys.find((k) => k.value === keyValue);
    if (!entry) return "not-found";
    entry.available = false;
    entry.lastCheckedAt = Date.now();
    return "persisted available=false";
}

function isApiKeyEligible(entry) {
    if (entry.available === false) return false;
    return !transientExhausted.has(entry.value);
}

function pickNextApiKey(store) {
    // rotation: 环形扫描第一个 eligible 的 key
    for (const entry of store.keys) {
        if (isApiKeyEligible(entry)) return entry;
    }
    return undefined;
}

function maskApiKey(key) {
    if (key.length <= 8) return `${key.slice(0, 2)}****`;
    return `${key.slice(0, 3)}****${key.slice(-4)}`;
}

// ── 模拟场景 ──
const store = {
    keys: [
        { value: "sk-wKCqmeWIcj3Oizq49evSMkJWGt9VCib618D3B0C2158646D6822dDeD06937Fd62", available: null }, // 封号 key
        { value: "sk-ScLaQOktONddR9e19CuY3AaJ7ttfq8xL57D83d56Dc354f1c8930692e3803EdAc", available: null }, // 正常 key
    ],
};

// 模拟 API 返回（实测抓取的封号响应）
const bannedApiError = new Error(
    'API error: [400] Bad Request\n{"code":"billing","message":"计费账户已被冻结","ref_code":400901,"ref_scope":"common"}\nURL: https://api.senseaudio.cn/v1/chat/completions'
);

console.log("=== 场景 1：封号 key 发请求 ===");
console.log("isKeyRotationError:", isKeyRotationError(bannedApiError));
const reason = getKeyRotationReason(bannedApiError);
console.log("getKeyRotationReason:", reason);
console.log("markApiKeyExhausted:", markApiKeyExhausted(store, store.keys[0].value, reason));
console.log("key[0].available:", store.keys[0].available);

console.log("\n=== 场景 2：轮询自动跳过封号 key ===");
const picked = pickNextApiKey(store);
console.log("pickNextApiKey →", picked ? maskApiKey(picked.value) : "undefined");
console.log("picked 是正常 key:", picked?.value === store.keys[1].value);

console.log("\n=== 场景 3：全部 key 不可用时的报错文案 ===");
store.keys[1].available = false; // 模拟正常 key 也失效
const detail = store.keys
    .map((e) => {
        const r = e.available === false ? (e.value === store.keys[0].value ? "banned" : "unavailable") : "balance";
        return `${maskApiKey(e.value)}: ${REASON_TEXT[r] ?? r}`;
    })
    .join("; ");
console.log("报错详情:", detail);

console.log("\n=== 场景 4：瞬态错误（429）不持久化（对照） ===");
const store2 = { keys: [{ value: "sk-test1234abcd", available: null }] };
const r429 = getKeyRotationReason(new Error("API error: [429] Too Many Requests"));
console.log("reason:", r429, "→", markApiKeyExhausted(store2, store2.keys[0].value, r429));
console.log("key.available（应保持 null）:", store2.keys[0].available);
