import assert from "node:assert/strict";
import test from "node:test";
import {
	createRedactingBashOperations,
	IncrementalTextRedactor,
	overwriteObjectInPlace,
	redactText,
	redactValue,
	StreamingRedactor,
	type BashOperationsLike,
} from "../extensions/redaction.ts";

const secrets = new Set(["hello"]);

test("redacts exact, repeated, and nested plaintext values", () => {
	assert.equal(redactText("hello / hello", secrets), "**** / ****");
	assert.deepEqual(redactValue({ content: [{ type: "text", text: "before hello after" }] }, secrets), {
		content: [{ type: "text", text: "before **** after" }],
	});
});

test("mutates execution result objects in place", () => {
	const original = { content: [{ type: "text", text: "hello" }], stale: true };
	const replacement = redactValue(original, secrets);
	overwriteObjectInPlace(original, replacement);
	assert.deepEqual(original, { content: [{ type: "text", text: "****" }], stale: true });
});

test("redacts cumulative and split delta tool updates", () => {
	const cumulative = new StreamingRedactor();
	assert.deepEqual(cumulative.redact("a", { content: [{ type: "text", text: "hel" }] }, secrets), {
		content: [{ type: "text", text: "****" }],
	});
	assert.deepEqual(cumulative.redact("a", { content: [{ type: "text", text: "hello\n" }] }, secrets), {
		content: [{ type: "text", text: "****\n" }],
	});

	const delta = new StreamingRedactor();
	assert.equal(delta.redact("b", "hel", secrets), "****");
	assert.equal(delta.redact("b", "lo\n", secrets), "****\n");
});

test("incremental stream withholds prefixes and never emits plaintext", () => {
	const redactor = new IncrementalTextRedactor(secrets);
	assert.equal(redactor.push("before hel"), "before ");
	assert.equal(redactor.push("lo after\n"), "**** after\n");
	assert.equal(redactor.finish(), "");
});

test("incremental stream masks an unfinished secret prefix at EOF", () => {
	const redactor = new IncrementalTextRedactor(secrets);
	assert.equal(redactor.push("hel"), "");
	assert.equal(redactor.finish(), "****");
});

test("redacting bash operations sanitize split chunks before forwarding", async () => {
	const base: BashOperationsLike = {
		async exec(_command, _cwd, options) {
			options.onData(Buffer.from("before hel"));
			options.onData(Buffer.from("lo after\n"));
			return { exitCode: 0 };
		},
	};
	let visible = "";
	const operations = createRedactingBashOperations(base, secrets);
	const result = await operations.exec("ignored", ".", {
		onData(data) {
			visible += data.toString("utf8");
		},
	});
	assert.deepEqual(result, { exitCode: 0 });
	assert.equal(visible, "before **** after\n");
	assert.equal(visible.includes("hello"), false);
});

test("redacting bash operations preserve UTF-8 decoding across Buffer chunks", async () => {
	const unicodeSecret = "héllo";
	const bytes = Buffer.from(unicodeSecret);
	const base: BashOperationsLike = {
		async exec(_command, _cwd, options) {
			options.onData(bytes.subarray(0, 2));
			options.onData(bytes.subarray(2));
			return { exitCode: 0 };
		},
	};
	let visible = "";
	await createRedactingBashOperations(base, [unicodeSecret]).exec("ignored", ".", {
		onData(data) {
			visible += data.toString("utf8");
		},
	});
	assert.equal(visible, "****");
});

test("normalizes split ANSI sequences before redaction", async () => {
	const base: BashOperationsLike = {
		async exec(_command, _cwd, options) {
			options.onData(Buffer.from("he\u001b[3"));
			options.onData(Buffer.from("1mllo\u001b[0m"));
			return { exitCode: 0 };
		},
	};
	let visible = "";
	await createRedactingBashOperations(base, secrets).exec("ignored", ".", {
		onData(data) {
			visible += data.toString("utf8");
		},
	});
	assert.equal(visible, "****");
});

test("normalizes removed control characters before redaction", async () => {
	const base: BashOperationsLike = {
		async exec(_command, _cwd, options) {
			options.onData(Buffer.from("he\r\u0000llo"));
			return { exitCode: 0 };
		},
	};
	let visible = "";
	await createRedactingBashOperations(base, secrets).exec("ignored", ".", {
		onData(data) {
			visible += data.toString("utf8");
		},
	});
	assert.equal(visible, "****");
});
