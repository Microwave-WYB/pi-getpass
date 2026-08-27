import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, statSync } from "node:fs";
import mod from "../extensions/getpass.ts";
import { startSecureWebServer, WebServerError } from "../extensions/getpass-web.ts";

const disposable = "test-only-getpass-web-value";

type Tool = { execute: (...args: any[]) => Promise<any> };

function extension() {
	const tools: Record<string, Tool> = {};
	const handlers = new Map<string, (...args: any[]) => any>();
	const api: any = {
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		registerTool(tool: Tool & { name: string }) { tools[tool.name] = tool; },
		registerCommand() {},
	};
	mod(api);
	const ctx: any = {
		hasUI: true,
		mode: "tui",
		ui: { notify() {} },
	};
	return { tools, handlers, ctx };
}

function body(value: string): URLSearchParams {
	return new URLSearchParams({ secret: value });
}

async function nextTurn(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

test("getpass web returns URL and opaque ID before submission, then populates only its env var", async () => {
	const oldHost = process.env.GETPASS_WEB_HOST;
	process.env.GETPASS_WEB_HOST = "127.0.0.1";
	delete process.env.GETPASS_WEB_A;
	try {
		const { tools, ctx } = extension();
		const opened = await tools.getpass.execute("id", { envVar: "GETPASS_WEB_A", via: "web", prompt: "test prompt" }, undefined, undefined, ctx);
		assert.equal(process.env.GETPASS_WEB_A, undefined);
		assert.match(opened.details.requestId, /^[a-f0-9]{36}$/);
		assert.match(opened.details.url, /^http:\/\/127\.0\.0\.1:/);
		assert.equal(opened.details.status, "pending");
		assert.equal(opened.content[0].text.includes(disposable), false);
		const response = await fetch(opened.details.url, { method: "POST", body: body(disposable) });
		assert.equal(response.status, 200);
		await nextTurn();
		assert.equal(process.env.GETPASS_WEB_A, disposable);
		assert.equal(process.env.GETPASS_WEB_B, undefined);
		const status = await tools.getpass_web_status.execute("status", { requestId: opened.details.requestId });
		assert.equal(status.details.status, "ready");
		const consumed = await tools.getpass_web_consume.execute("consume", { requestId: opened.details.requestId });
		assert.equal(consumed.details.status, "consumed");
		assert.equal(JSON.stringify(consumed).includes(disposable), false);
	} finally {
		delete process.env.GETPASS_WEB_A;
		if (oldHost === undefined) delete process.env.GETPASS_WEB_HOST;
		else process.env.GETPASS_WEB_HOST = oldHost;
	}
});

test("web server expires deterministically and cancellation closes it", async () => {
	const expired = await startSecureWebServer({ host: "127.0.0.1", prompt: "expiry", ttlMs: 15 });
	await assert.rejects(expired.waitForSubmission(), (error: unknown) => error instanceof WebServerError && error.reason === "expired");
	assert.equal(expired.state, "expired");
	await expired.close();
	await assert.rejects(fetch(expired.url, { method: "POST", body: body(disposable) }));

	const cancelled = await startSecureWebServer({ host: "127.0.0.1", prompt: "cancel", ttlMs: 10_000 });
	await cancelled.cancel();
	assert.equal(cancelled.state, "cancelled");
	await assert.rejects(cancelled.waitForSubmission(), (error: unknown) => error instanceof WebServerError && error.reason === "cancelled");
});

test("duplicate submission and concurrent requests are isolated", async () => {
	const first = await startSecureWebServer({ host: "127.0.0.1", prompt: "one", ttlMs: 10_000 });
	const second = await startSecureWebServer({ host: "127.0.0.1", prompt: "two", ttlMs: 10_000 });
	try {
		const attempt = (value: string) => fetch(first.url, { method: "POST", body: body(value) }).then((response) => response.status).catch(() => 0);
		const [a, b] = await Promise.all([attempt("first-disposable"), attempt("second-disposable")]);
		assert.equal([a, b].filter((status) => status === 200).length, 1);
		const secondResponse = await fetch(second.url, { method: "POST", body: body("isolated-disposable") });
		assert.equal(secondResponse.status, 200);
		const [oneSubmission, twoSubmission] = await Promise.all([first.waitForSubmission(), second.waitForSubmission()]);
		assert.equal(statSync(oneSubmission.artifactPath).mode & 0o777, 0o600);
		assert.equal(statSync(twoSubmission.artifactPath).mode & 0o777, 0o600);
		const one = first.consumeSecret();
		const two = second.consumeSecret();
		assert.equal(existsSync(oneSubmission.artifactPath), false);
		assert.equal(existsSync(twoSubmission.artifactPath), false);
		assert.notEqual(one, two);
		assert.ok(["first-disposable", "second-disposable"].includes(one));
		assert.equal(two, "isolated-disposable");
	} finally {
		await Promise.all([first.close(), second.close()]);
	}
});

test("session shutdown cancels pending web requests and redaction starts on capture", async () => {
	const oldHost = process.env.GETPASS_WEB_HOST;
	process.env.GETPASS_WEB_HOST = "127.0.0.1";
	delete process.env.GETPASS_WEB_C;
	try {
		const { tools, handlers, ctx } = extension();
		const opened = await tools.getpass.execute("id", { envVar: "GETPASS_WEB_C", via: "web" }, undefined, undefined, ctx);
		await handlers.get("session_shutdown")!();
		assert.equal((await tools.getpass_web_status.execute("status", { requestId: opened.details.requestId })).details.status, "cancelled");
		assert.equal(process.env.GETPASS_WEB_C, undefined);

		const next = extension();
		const openedAgain = await next.tools.getpass.execute("id", { envVar: "GETPASS_WEB_C", via: "web" }, undefined, undefined, next.ctx);
		await fetch(openedAgain.details.url, { method: "POST", body: body(disposable) });
		await nextTurn();
		const result = next.handlers.get("tool_result")!({ content: [{ type: "text", text: `output ${disposable}` }], details: {} });
		assert.equal(JSON.stringify(result).includes(disposable), false);
	} finally {
		delete process.env.GETPASS_WEB_C;
		if (oldHost === undefined) delete process.env.GETPASS_WEB_HOST;
		else process.env.GETPASS_WEB_HOST = oldHost;
	}
});
