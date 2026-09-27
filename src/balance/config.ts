import * as vscode from "vscode";

/**
 * 余额 / 账号模块的配置读取与通用工具。
 */

export function getConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("senseaudio");
}

/**
 * 余额阈值：可用余额 ≤ 该值视为耗尽（默认 0，夹取 ≥ 0）。
 * 仅用于管理界面把「充值余额」标记为 `$(error)`（余额不足提示）。
 * 注意：主动余额预检已移除（旧 cookie 端点 404），余额不足由 API 返回 402 触发被动轮换。
 */
export function getMinBalanceCny(): number {
    const v = getConfig().get<number>("minBalanceCny", 0);
    return Number.isFinite(v) && v >= 0 ? v : 0;
}

/** 账号信息查询缓存 TTL（秒，默认 60；0 = 每次查询） */
export function getBalanceCheckIntervalSec(): number {
    const v = getConfig().get<number>("balanceCheckIntervalSec", 60);
    return Number.isFinite(v) && v >= 0 ? v : 60;
}

/** 防御：API 金额字段可能以字符串返回，统一转 number，非法值兜底 0 */
export function toNumber(v: number | string | undefined): number {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
}
