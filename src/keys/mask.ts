/**
 * API Key / cookie 脱敏显示辅助。
 */

/** 脱敏 API Key：`sk_****abcd`（长度 ≤ 8 时只保留头 2 字符） */
export function maskApiKey(key: string): string {
    if (key.length <= 8) {
        return `${key.slice(0, 2)}****`;
    }
    return `${key.slice(0, 3)}****${key.slice(-4)}`;
}

/** 脱敏 cookie：`sess_****abcd` */
export function maskCookie(cookie: string): string {
    if (cookie.length <= 8) {
        return `${cookie.slice(0, 2)}****`;
    }
    const head = cookie.slice(0, 5);
    return `${head}****${cookie.slice(-4)}`;
}
