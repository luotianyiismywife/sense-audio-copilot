// 测试：用 API Key 的 public_key 换发短期 token（auth.senseaudio.cn）
// 用法：node scripts/test-apply-token.mjs <public_key>
const publicKey = process.argv[2] || 'pub-UKppCPeSX2ZYawykfiFGML';

const res = await fetch('https://auth.senseaudio.cn/v1/apikey/apply_token_via_public_key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ public_key: publicKey }),
});
console.log('status:', res.status);
const body = await res.json();
console.log('expireAt:', body.expireAt);

// 解析 PASETO v2.public payload（parts = ["v2","public","<payload>","<sig>"]）
const parts = body.token.split('.');
const bin = Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('binary');
const s = bin.indexOf('{"');
const e = bin.lastIndexOf('}');
const payload = JSON.parse(bin.slice(s, e + 1));
console.log('subject:', payload.subject);
console.log('issued_at:', payload.issued_at);
console.log('expiration:', payload.expiration);
console.log('payload.paths:', payload.payload?.paths);
