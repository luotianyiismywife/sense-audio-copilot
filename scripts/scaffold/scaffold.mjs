#!/usr/bin/env node
/**
 * VS Code 扩展项目脚手架 —— 从本仓库抽取可复用骨架生成新项目。
 *
 * 用法：
 *   node scripts/scaffold/scaffold.mjs --name my-ext --publisher myname --dir D:\path\to\target [--desc "..."]
 *
 * 复制的骨架（与业务无关，通用）：
 *   - tsconfig.json / eslint.config.mjs / .gitignore
 *   - .vscode/launch.json / .vscode/tasks.json（F5 调试 + compile/watch/test 任务）
 *   - scripts/build/clean.mjs（compile 前清空 out/，防陈旧产物进 VSIX）
 *   - scripts/build/build-info.mjs（编译元信息：版本号 + 时区标注）
 *   - scripts/build/package-vsix.mjs（VSIX 打包，输出名 <name>-<version>.vsix）
 *   - scripts/build/copy-tokenizer.js（postinstall 下载 tokenizer 资源）
 *
 * 生成的文件（按参数定制）：
 *   - package.json（通用 scripts + 依赖，业务 contributes 留空由使用者补充）
 *   - src/extension.ts（最小激活入口：日志 + dispose）
 *   - AGENTS.md（骨架：编译铁律 / 目录结构 / 文件索引占位）
 *   - README.md（占位）
 *   - test/README.md（测试说明占位）
 *
 * 不复制的内容：src/ 业务代码、test/ 测试脚本、resources/、docs/、package.nls*.json、
 * assets/（postinstall 会自动下载 tokenizer）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");

// ---------- 参数解析 ----------
function parseArgs(argv) {
	const args = { desc: "" };
	for (let i = 0; i < argv.length; i++) {
		const key = argv[i];
		if (key === "--name") args.name = argv[++i];
		else if (key === "--publisher") args.publisher = argv[++i];
		else if (key === "--dir") args.dir = argv[++i];
		else if (key === "--desc") args.desc = argv[++i];
		else {
			console.error(`[scaffold] 未知参数: ${key}`);
			process.exit(1);
		}
	}
	return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.name || !args.publisher || !args.dir) {
	console.error("用法: node scripts/scaffold/scaffold.mjs --name <ext-name> --publisher <publisher> --dir <target-dir> [--desc \"...\"]");
	process.exit(1);
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(args.name)) {
	console.error(`[scaffold] 非法扩展名 "${args.name}"（需小写字母/数字/连字符）`);
	process.exit(1);
}

const target = resolve(args.dir);
if (existsSync(target) && existsSync(join(target, "package.json"))) {
	console.error(`[scaffold] 目标目录已存在 package.json，拒绝覆盖: ${target}`);
	process.exit(1);
}

// ---------- 骨架复制清单 ----------
const VERBATIM_FILES = [
	"tsconfig.json",
	"eslint.config.mjs",
	".gitignore",
	".vscode/launch.json",
	".vscode/tasks.json",
	"scripts/build/clean.mjs",
	"scripts/build/build-info.mjs",
	"scripts/build/package-vsix.mjs",
	"scripts/build/copy-tokenizer.js",
];

for (const rel of VERBATIM_FILES) {
	const src = join(repoRoot, rel);
	if (!existsSync(src)) {
		console.error(`[scaffold] 骨架文件缺失: ${rel}`);
		process.exit(1);
	}
}

mkdirSync(target, { recursive: true });
for (const rel of VERBATIM_FILES) {
	const dest = join(target, rel);
	mkdirSync(dirname(dest), { recursive: true });
	copyFileSync(join(repoRoot, rel), dest);
}
console.log(`[scaffold] 复制骨架文件 ${VERBATIM_FILES.length} 个`);

// ---------- 生成 package.json ----------
const pkg = {
	name: args.name,
	publisher: args.publisher,
	displayName: args.name,
	description: args.desc || `${args.name} - VS Code extension`,
	version: "0.1.0",
	engines: { vscode: "^1.116.0" },
	categories: ["Other"],
	license: "UNLICENSED",
	activationEvents: ["onStartupFinished"],
	main: "./out/extension.js",
	contributes: {},
	scripts: {
		"vscode:prepublish": "npm run compile",
		clean: "node scripts/build/clean.mjs",
		compile: "node scripts/build/clean.mjs && tsc -p ./ && node scripts/build/build-info.mjs",
		lint: "eslint",
		watch: "tsc -watch -p ./",
		build: "node scripts/build/package-vsix.mjs",
	},
	dependencies: {},
	devDependencies: {
		"@eslint/js": "9.39.4",
		"@types/node": "^22",
		"@types/vscode": "^1.116.0",
		eslint: "9.39.4",
		typescript: "^5.9.2",
		"typescript-eslint": "8.60.1",
	},
};
writeFileSync(join(target, "package.json"), JSON.stringify(pkg, null, "\t") + "\n");

// ---------- 生成 src/extension.ts ----------
const extensionTs = `import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext): void {
	const logger = vscode.window.createOutputChannel("${args.name}", { log: true });
	context.subscriptions.push(logger);
	logger.info("activated");
}

export function deactivate(): void {}
`;
mkdirSync(join(target, "src"), { recursive: true });
writeFileSync(join(target, "src", "extension.ts"), extensionTs);

// ---------- 生成 AGENTS.md 骨架 ----------
const agentsMd = `# ${args.name} — AGENTS.md

> **所有更改必须通过 \`npm run compile\` / \`npx tsc --noEmit\` 编译检查无错误通过。**
> **每次更改后，必须同步更新本文档以反映代码变更。**

---

## 目录

1. [项目详细介绍](#1-项目详细介绍)
2. [程序文件索引](#2-程序文件索引)
3. [编译与构建](#3-编译与构建)
4. [开发规范](#4-开发规范)

---

## 1. 项目详细介绍

<!-- 在此描述项目概述、核心能力（表格形式） -->

## 2. 程序文件索引

\`\`\`
src/
├── extension.ts                          # 扩展入口（初始化 + 注册）
\`\`\`

| 文件 | 职责 |
|------|------|
| \`src/extension.ts\` | 扩展激活/停用 |
| \`scripts/build/clean.mjs\` | compile 前清空 out/（防陈旧产物进 VSIX） |
| \`scripts/build/build-info.mjs\` | 编译元信息（版本号 + 时区标注） |
| \`scripts/build/package-vsix.mjs\` | VSIX 打包（输出名 <name>-<version>.vsix） |

## 3. 编译与构建

\`\`\`bash
npm run compile   # 清理 out/ + tsc + 编译元信息
npm run lint      # ESLint
npm run build     # 打包 VSIX
\`\`\`

| 选项 | 值 |
|------|-----|
| \`module\` | \`Node16\` |
| \`target\` | \`ES2024\` |
| \`strict\` | \`true\` |
| \`outDir\` | \`out\` |
| \`rootDir\` | \`src\` |

## 4. 开发规范

### 4.1 编译检查铁律

> 所有代码更改必须通过 \`npm run compile\`，任何编译错误必须在提交前修复。

### 4.2 AGENTS.md 同步更新铁律

> 每次代码更改后，必须同步更新本文档（新增/修改/删除函数、文件、配置均需反映）。

### 4.3 编译产物清洁铁律

> \`npm run compile\` 必须先清空 \`out/\`（\`tsc\` 不清理 \`outDir\`，删除/移动源文件后旧 \`.js\` 会残留并被打进 VSIX）。

### 4.4 编译产物元信息铁律

> 每次编译产物必须包含版本号和编译时间（标注 IANA 时区 + UTC 偏移）。\`out/build-info.json\` 不存在视为编译未完成，不得打包发布。
`;
writeFileSync(join(target, "AGENTS.md"), agentsMd);

// ---------- 生成 README.md / test/README.md ----------
writeFileSync(join(target, "README.md"), `# ${args.name}\n\n${args.desc || "VS Code extension"}\n`);
mkdirSync(join(target, "test"), { recursive: true });
writeFileSync(join(target, "test", "README.md"), "# 测试\n\n离线测试脚本放这里（\`node test/test-*.mjs\`，运行前需 \`npm run compile\`）。\n");

console.log(`[scaffold] ✅ 项目已生成: ${target}`);
console.log(`[scaffold] 下一步: cd ${target} && npm install && npm run compile`);
