// 对比上游内置模型列表与实际 API 模型（排查上游遗留未处理项）
const KEY = 'sk-ScLaQOktONddR9e19CuY3AaJ7ttfq8xL57D83d56Dc354f1c8930692e3803EdAc';

const upstreamBuiltIn = [
    'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-0731',
    'glm-5.2', 'glm-5.1', 'glm-5', 'glm-5.3', 'glm-5.3-flash',
    'kimi-k2.7-code', 'kimi-k2.6', 'kimi-k2.5',
    'mimo-v2.5-pro', 'minimax-m2.7', 'minimax-m2.5',
    'qwen3.7-max', 'qwen3.8-max',
];

const r = await fetch('https://api.senseaudio.cn/v1/models', {
    headers: { Authorization: `Bearer ${KEY}` },
});
const d = await r.json();
const llm = d.data.filter((m) => m.mode === 'llm');
const apiIds = llm.map((m) => m.id);

console.log('=== 上游内置但 API 不存在（死代码，会被自动发现过滤隐藏）===');
console.log(upstreamBuiltIn.filter((u) => !apiIds.includes(u)).join('\n') || '(none)');

console.log('\n=== API 有但无内置定义（回退时用 128K/4096 兜底）===');
console.log(apiIds.filter((i) => !upstreamBuiltIn.includes(i)).join('\n') || '(none)');

console.log('\n=== 两者交集（内置定义仍有效）===');
console.log(apiIds.filter((i) => upstreamBuiltIn.includes(i)).join('\n') || '(none)');

// 检查协议能力
console.log('\n=== API 模型协议能力 ===');
for (const m of llm) {
    console.log(`${m.id}: ${(m.protocols || []).join(',')}`);
}
