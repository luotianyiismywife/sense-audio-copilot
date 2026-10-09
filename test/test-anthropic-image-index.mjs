import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Verifies AnthropicApi.convertMessages() assigns image indices in PART ORDER,
// matching collectLocalImages() storage order. Regression: the image DataPart
// index used to be assigned AFTER the part loop (deferred), so a message that
// mixed an image DataPart with a text data-URI image produced mismatched
// indices — the model would ask about "image N" and get a different image.

const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalLoad = Module._load;

class DataPart {
	constructor(data, mimeType) {
		this.data = data;
		this.mimeType = mimeType;
	}
}
class TextPart {
	constructor(value) {
		this.value = value;
	}
}
class ToolCallPart {
	constructor(callId, name, input) {
		this.callId = callId;
		this.name = name;
		this.input = input;
	}
}
class ToolResultPart {
	constructor(callId, content) {
		this.callId = callId;
		this.content = content;
	}
}
class ThinkingPart {
	constructor(value) {
		this.value = value;
	}
}
const vscodeShim = {
	LanguageModelDataPart: DataPart,
	LanguageModelTextPart: TextPart,
	LanguageModelToolCallPart: ToolCallPart,
	LanguageModelToolResultPart: ToolResultPart,
	LanguageModelThinkingPart: ThinkingPart,
	LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
	window: {
		createOutputChannel: () => ({
			debug() {},
			info() {},
			warn() {},
			error() {},
			dispose() {},
		}),
	},
	workspace: {
		getConfiguration: () => ({ get: (_key, fallback) => fallback }),
	},
};
Module._load = function (request, parent, isMain) {
	if (request === "vscode") {
		return vscodeShim;
	}
	return originalLoad.call(this, request, parent, isMain);
};

let passed = 0;
function check(name, fn) {
	fn();
	passed++;
	console.log(`  ok  ${name}`);
}

try {
	const { logger } = require("../out/core/logger.js");
	logger.init();
	const { AnthropicApi } = require("../out/api/anthropic/anthropicApi.js");

	// A single user message mixing an image DataPart (A) and a text data-URI
	// image (B). collectLocalImages stores them in part order: [A, B].
	const imageA = new Uint8Array([1, 2, 3]);
	const messages = [
		{
			role: 1, // user
			content: [
				new DataPart(imageA, "image/png"),
				new TextPart("see data:image/png;base64,iVBORw0KGgo= here"),
			],
		},
	];

	const api = new AnthropicApi("test-model");
	const out = api.convertMessages(messages, { includeReasoningInRequest: false, vision: false });

	check("localImages 按 part 顺序存储：[A(DataPart), B(dataURI)]", () => {
		assert.equal(api.localImages.length, 2);
		assert.deepEqual([...api.localImages[0].data], [1, 2, 3], "localImages[0] 应为 DataPart 图片 A");
	});

	check("图片引用索引与 localImages 顺序一致（A→0, B→1）", () => {
		const blocks = out[0].content;
		// blocks[0] = joinedText（含文本 data-URI 图片 B 的引用，索引 1）
		// blocks[1] = image DataPart 图片 A 的引用（索引 0）
		assert.ok(blocks[0].text.includes("imageIndex=1"), "文本 data-URI 图片 B 应为 imageIndex=1");
		assert.ok(blocks[1].text.includes("imageIndex=0"), "image DataPart 图片 A 应为 imageIndex=0");
	});

	check("视觉模型不受影响（图片直接内联，无索引引用）", () => {
		const visionApi = new AnthropicApi("test-model");
		const visionOut = visionApi.convertMessages(messages, { includeReasoningInRequest: false, vision: true });
		const blocks = visionOut[0].content;
		assert.ok(blocks.some((b) => b.type === "image"), "视觉模型应收到 image 块");
		assert.ok(!JSON.stringify(visionOut).includes("imageIndex="), "视觉模型不应有索引引用");
	});
} finally {
	Module._load = originalLoad;
}

console.log(`\nanthropic image index: ${passed} checks passed`);
