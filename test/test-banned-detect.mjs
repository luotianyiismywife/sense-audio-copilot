// 模拟验证封号错误匹配逻辑（与 keyManager.ts 的 patterns/reason 提取一致）
const msg = 'API error: [400] Bad Request\n{"code":"billing","message":"计费账户已被冻结","ref_code":400901,"ref_scope":"common"}\nURL: x'.toLowerCase();

const patterns = ["余额不足", "insufficient balance", "balance", "计费账户已被冻结", "billing"];
console.log("rotation match:", patterns.some((p) => msg.includes(p)));

const banned =
    msg.includes("计费账户已被冻结") ||
    msg.includes('"code":"billing"') ||
    msg.includes("ref_code:400901") ||
    msg.includes('ref_code":400901');
console.log("reason banned:", banned);

// 确认 400 不在瞬态/轮换状态码列表（[400] 不匹配 [401]/[402]/[429]/[503]）
const statusMatch = [401, 402, 429, 503].some((c) => msg.includes(`[${c}]`) || msg.includes(`status ${c}`));
console.log("status-code match (should be false):", statusMatch);
