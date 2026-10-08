/**
 * API Key / 平台登录凭据 脱敏显示辅助。
 */

/** 脱敏 API Key：`sk_****abcd`（长度 ≤ 8 时只保留头 2 字符） */
export function maskApiKey(key: string): string {
    if (key.length <= 8) {
        return `${key.slice(0, 2)}****`;
    }
    return `${key.slice(0, 3)}****${key.slice(-4)}`;
}

/** 脱敏平台登录凭据：`v2.pu****abcd` */
export function maskCredential(credential: string): string {
    if (credential.length <= 8) {
        return `${credential.slice(0, 2)}****`;
    }
    const head = credential.slice(0, 5);
    return `${head}****${credential.slice(-4)}`;
}
