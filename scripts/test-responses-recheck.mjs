// 复测 RESPONSES_API_ISSUES.md 的 P0 结论是否仍然成立
const KEY = 'sk-ScLaQOktONddR9e19CuY3AaJ7ttfq8xL57D83d56Dc354f1c8930692e3803EdAc';
const BASE = 'https://api.senseaudio.cn/v1/responses';

async function post(body) {
    const r = await fetch(BASE, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const t = await r.text();
    return { status: r.status, body: t.slice(0, 400) };
}

// 1. function_call / function_call_output 块（文档 3.1：曾被拒绝）
const fc = await post({
    model: 'glm-5.3-flash',
    input: [
        { role: 'assistant', content: [{ type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"bj"}' }] },
        { role: 'user', content: [{ type: 'function_call_output', call_id: 'call_1', output: 'sunny 25' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
    ],
    stream: false,
});
console.log('1. function_call block:', fc.status);
console.log('  ', fc.body.slice(0, 200));

// 2. tool_choice = required（文档 3.2：仅接受 auto/none）
const tcRequired = await post({
    model: 'glm-5.3-flash',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'what is the weather' }] }],
    tools: [{ type: 'function', name: 'get_weather', description: 'get weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
    tool_choice: 'required',
    stream: false,
});
console.log('2. tool_choice=required:', tcRequired.status);
console.log('  ', tcRequired.body.slice(0, 200));

// 3. tool_choice 指定工具
const tcNamed = await post({
    model: 'glm-5.3-flash',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'what is the weather' }] }],
    tools: [{ type: 'function', name: 'get_weather', description: 'get weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
    tool_choice: { type: 'function', name: 'get_weather' },
    stream: false,
});
console.log('3. tool_choice={type,name}:', tcNamed.status);
console.log('  ', tcNamed.body.slice(0, 200));
