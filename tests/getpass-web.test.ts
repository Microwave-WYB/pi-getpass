import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import mod from "../extensions/getpass.ts";
import { startSecureWebServer, WebServerError } from "../extensions/getpass-web.ts";

const disposable = "test-only-getpass-web-value";

type Tool = { execute: (...args: any[]) => Promise<any> };

function extension() {
	const tools: Record<string, Tool> = {};
	const handlers = new Map<string, (...args: any[]) => any>();
	const messages: Array<{ content: unknown; options: unknown; probe: unknown }> = [];
	const api: any = {
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		sendUserMessage(content: unknown, options: unknown) {
			const probe = handlers.get("tool_result")?.({ content: [{ type: "text", text: disposable }], details: {} });
			messages.push({ content, options, probe });
		},
		registerTool(tool: Tool & { name: string }) { tools[tool.name] = tool; },
		registerCommand() {},
	};
	mod(api);
	const ctx: any = {
		hasUI: true,
		mode: "tui",
		ui: { notify() {} },
	};
	return { tools, handlers, messages, ctx };
}

function body(value: string): URLSearchParams {
	return new URLSearchParams({ secret: value });
}

async function nextTurn(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

test("getpass web returns URL and opaque ID before submission, then populates only its env var", async () => {
	const oldHost = process.env.GETPASS_WEB_HOST;
	const oldLoopback = process.env.GETPASS_WEB_ALLOW_LOOPBACK;
	process.env.GETPASS_WEB_HOST = "127.0.0.1";
	process.env.GETPASS_WEB_ALLOW_LOOPBACK = "1";
	delete process.env.GETPASS_WEB_A;
	try {
		const { tools, ctx, messages } = extension();
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
		assert.equal(messages.length, 1);
		assert.equal(messages[0]?.content, `getpass web request ${opened.details.requestId}: ready; invoke getpass_web_consume or getpass_web_status with this request ID.`);
		assert.deepEqual(messages[0]?.options, { deliverAs: "followUp", expandPromptTemplates: false });
		assert.deepEqual(messages[0]?.probe, { content: [{ type: "text", text: "****" }], details: {} });
		assert.equal(JSON.stringify(messages).includes(disposable), false);
		assert.equal(process.env.GETPASS_WEB_B, undefined);
		const status = await tools.getpass_web_status.execute("status", { requestId: opened.details.requestId });
		assert.equal(status.details.status, "ready");
		const consumed = await tools.getpass_web_consume.execute("consume", { requestId: opened.details.requestId });
		assert.equal(consumed.details.status, "consumed");
		assert.equal(JSON.stringify(consumed).includes(disposable), false);
	} finally {
		delete process.env.GETPASS_WEB_A;
		if (oldHost === undefined) delete process.env.GETPASS_WEB_HOST; else process.env.GETPASS_WEB_HOST = oldHost;
		if (oldLoopback === undefined) delete process.env.GETPASS_WEB_ALLOW_LOOPBACK; else process.env.GETPASS_WEB_ALLOW_LOOPBACK = oldLoopback;
	}
});

test("same-env concurrent startup has one atomic reservation and failed startup rolls it back", async () => {
	const oldHost = process.env.GETPASS_WEB_HOST;
	const oldLoopback = process.env.GETPASS_WEB_ALLOW_LOOPBACK;
	process.env.GETPASS_WEB_HOST = "127.0.0.1";
	process.env.GETPASS_WEB_ALLOW_LOOPBACK = "1";
	delete process.env.GETPASS_WEB_D;
	try {
		const { tools, ctx, handlers } = extension();
		const first = tools.getpass.execute("first", { envVar: "GETPASS_WEB_D", via: "web" }, undefined, undefined, ctx);
		const second = tools.getpass.execute("second", { envVar: "GETPASS_WEB_D", via: "web" }, undefined, undefined, ctx);
		await assert.rejects(second, /already has a pending/);
		const opened = await first;
		assert.equal((await fetch(opened.details.url, { method: "POST", body: body("same-env-disposable") })).status, 200);
		await nextTurn();
		assert.equal(process.env.GETPASS_WEB_D, "same-env-disposable");
		await handlers.get("session_shutdown")!();
		delete process.env.GETPASS_WEB_D;

		process.env.GETPASS_WEB_HOST = "0.0.0.0";
		const failed = extension();
		await assert.rejects(failed.tools.getpass.execute("failed", { envVar: "GETPASS_WEB_D", via: "web" }, undefined, undefined, failed.ctx), /allowed tailnet/);
		process.env.GETPASS_WEB_HOST = "127.0.0.1";
		const retried = await failed.tools.getpass.execute("retry", { envVar: "GETPASS_WEB_D", via: "web" }, undefined, undefined, failed.ctx);
		await (await fetch(retried.details.url, { method: "POST", body: body("rollback-disposable") })).arrayBuffer();
		await nextTurn();
		assert.equal(process.env.GETPASS_WEB_D, "rollback-disposable");
		await failed.handlers.get("session_shutdown")!();
	} finally {
		delete process.env.GETPASS_WEB_D;
		if (oldHost === undefined) delete process.env.GETPASS_WEB_HOST; else process.env.GETPASS_WEB_HOST = oldHost;
		if (oldLoopback === undefined) delete process.env.GETPASS_WEB_ALLOW_LOOPBACK; else process.env.GETPASS_WEB_ALLOW_LOOPBACK = oldLoopback;
	}
});

test("immediate session shutdown fences startup before request registration", async () => {
	const oldHost = process.env.GETPASS_WEB_HOST;
	const oldLoopback = process.env.GETPASS_WEB_ALLOW_LOOPBACK;
	process.env.GETPASS_WEB_HOST = "127.0.0.1";
	process.env.GETPASS_WEB_ALLOW_LOOPBACK = "1";
	delete process.env.GETPASS_WEB_E;
	try {
		const { tools, ctx, handlers, messages } = extension();
		const opening = tools.getpass.execute("startup", { envVar: "GETPASS_WEB_E", via: "web" }, undefined, undefined, ctx);
		const shutdown = handlers.get("session_shutdown")!();
		await shutdown;
		await assert.rejects(opening, /session is shutting down/);
		assert.equal(process.env.GETPASS_WEB_E, undefined);
		assert.equal(messages.length, 0);
	} finally {
		delete process.env.GETPASS_WEB_E;
		if (oldHost === undefined) delete process.env.GETPASS_WEB_HOST; else process.env.GETPASS_WEB_HOST = oldHost;
		if (oldLoopback === undefined) delete process.env.GETPASS_WEB_ALLOW_LOOPBACK; else process.env.GETPASS_WEB_ALLOW_LOOPBACK = oldLoopback;
	}
});

test("public web request IDs are strictly validated before lookup", async () => {
	const { tools } = extension();
	for (const requestId of ["", "short", "../../etc/passwd", "A".repeat(36), "a".repeat(35), "a".repeat(37)]) {
		await assert.rejects(tools.getpass_web_status.execute("status", { requestId }), /Invalid getpass web request ID/);
		await assert.rejects(tools.getpass_web_consume.execute("consume", { requestId }), /Invalid getpass web request ID/);
		await assert.rejects(tools.getpass_web_cancel.execute("cancel", { requestId }), /Invalid getpass web request ID/);
	}
	await assert.rejects(tools.getpass_web_status.execute("status", { requestId: "a".repeat(36) }), /Unknown getpass web request ID/);
});

test("server request IDs reject before startup or artifact construction", async () => {
	const directory = mkdtempSync(join("/tmp", "getpass-web-request-id-"));
	const oldRuntime = process.env.XDG_RUNTIME_DIR;
	process.env.XDG_RUNTIME_DIR = directory;
	try {
		for (const requestId of ["", "short", "../artifact", "A".repeat(36), "a".repeat(35), "a".repeat(37)]) {
			await assert.rejects(startSecureWebServer({ host: "127.0.0.1", prompt: "id", ttlMs: 100, requestId }), /strict opaque hex ID/);
		}
		assert.deepEqual(readdirSync(directory), []);
	} finally {
		if (oldRuntime === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = oldRuntime;
		rmSync(directory, { recursive: true, force: true });
	}
});


test("web bind host accepts only explicit loopback or Tailscale ranges", async () => {
	for (const host of ["0.0.0.0", "::", "192.168.1.20", "100.63.0.1", "100.128.0.1", "fd00::1"]) {
		await assert.rejects(startSecureWebServer({ host, prompt: "host", ttlMs: 100 }), /allowed tailnet/);
	}
	const loopback = await startSecureWebServer({ host: "127.0.0.1", prompt: "host", ttlMs: 100 });
	await loopback.close();
});

test("ready requests survive terminal pressure until consume", async () => {
	const oldHost = process.env.GETPASS_WEB_HOST;
	const oldLoopback = process.env.GETPASS_WEB_ALLOW_LOOPBACK;
	process.env.GETPASS_WEB_HOST = "127.0.0.1";
	process.env.GETPASS_WEB_ALLOW_LOOPBACK = "1";
	const opened: Array<{ envVar: string; requestId: string; url: string }> = [];
	try {
		const { tools, ctx, handlers } = extension();
		for (let i = 0; i < 129; i++) {
			const envVar = `GETPASS_WEB_PRESSURE_${i}`;
			delete process.env[envVar];
			const result = await tools.getpass.execute(`pressure-${i}`, { envVar, via: "web" }, undefined, undefined, ctx);
			opened.push({ envVar, requestId: result.details.requestId, url: result.details.url });
			assert.equal((await fetch(result.details.url, { method: "POST", body: body(`pressure-value-${i}`) })).status, 200);
			await nextTurn();
		}
		assert.equal((await tools.getpass_web_status.execute("first-status", { requestId: opened[0]!.requestId })).details.status, "ready");
		assert.equal((await tools.getpass_web_consume.execute("first-consume", { requestId: opened[0]!.requestId })).details.status, "consumed");
		for (const request of opened.slice(1)) {
			assert.equal((await tools.getpass_web_consume.execute("cleanup", { requestId: request.requestId })).details.status, "consumed");
		}
		await handlers.get("session_shutdown")!();
	} finally {
		for (const request of opened) delete process.env[request.envVar];
		if (oldHost === undefined) delete process.env.GETPASS_WEB_HOST; else process.env.GETPASS_WEB_HOST = oldHost;
		if (oldLoopback === undefined) delete process.env.GETPASS_WEB_ALLOW_LOOPBACK; else process.env.GETPASS_WEB_ALLOW_LOOPBACK = oldLoopback;
	}
	assert.equal(process.env.GETPASS_WEB_PRESSURE_0, undefined);
});

test("ready expiry transitions to expired while preserving tracked redaction state", async () => {
	const oldHost = process.env.GETPASS_WEB_HOST;
	const oldLoopback = process.env.GETPASS_WEB_ALLOW_LOOPBACK;
	const oldNow = Date.now;
	process.env.GETPASS_WEB_HOST = "127.0.0.1";
	process.env.GETPASS_WEB_ALLOW_LOOPBACK = "1";
	delete process.env.GETPASS_WEB_EXPIRY;
	try {
		const { tools, ctx, handlers } = extension();
		const opened = await tools.getpass.execute("expiry-ready", { envVar: "GETPASS_WEB_EXPIRY", via: "web" }, undefined, undefined, ctx);
		assert.equal((await fetch(opened.details.url, { method: "POST", body: body("expiry-value") })).status, 200);
		await nextTurn();
		const capturedAt = oldNow();
		Date.now = () => capturedAt + 15 * 60 * 1000 + 1;
		const expired = await tools.getpass_web_status.execute("expiry-status", { requestId: opened.details.requestId });
		assert.equal(expired.details.status, "expired");
		assert.equal(process.env.GETPASS_WEB_EXPIRY, "expiry-value");
		await handlers.get("session_shutdown")!();
	} finally {
		Date.now = oldNow;
		delete process.env.GETPASS_WEB_EXPIRY;
		if (oldHost === undefined) delete process.env.GETPASS_WEB_HOST; else process.env.GETPASS_WEB_HOST = oldHost;
		if (oldLoopback === undefined) delete process.env.GETPASS_WEB_ALLOW_LOOPBACK; else process.env.GETPASS_WEB_ALLOW_LOOPBACK = oldLoopback;
	}
	assert.equal(process.env.GETPASS_WEB_EXPIRY, undefined);
});


test("post-listen server errors atomically close, reject, unlink, and stop serving", async () => {
	const directory = mkdtempSync(join("/tmp", "getpass-web-server-error-"));
	const oldRuntime = process.env.XDG_RUNTIME_DIR;
	process.env.XDG_RUNTIME_DIR = directory;
	let pendingRaw: http.Server | undefined;
	let pending: Awaited<ReturnType<typeof startSecureWebServer>> | undefined;
	let submitted: Awaited<ReturnType<typeof startSecureWebServer>> | undefined;
	try {
		pending = await startSecureWebServer({ host: "127.0.0.1", prompt: "error", ttlMs: 10_000, onListeningForTest: (raw) => { pendingRaw = raw; } });
		pendingRaw!.emit("error", new Error("injected post-listen error"));
		await assert.rejects(pending.waitForSubmission(), (error: unknown) => error instanceof WebServerError && error.reason === "failed");
		assert.equal(pending.state, "closed");
		await pending.close();
		await assert.rejects(fetch(pending.url));

		let submittedRaw: http.Server | undefined;
		submitted = await startSecureWebServer({ host: "127.0.0.1", prompt: "error", ttlMs: 10_000, onListeningForTest: (raw) => { submittedRaw = raw; } });
		assert.equal((await fetch(submitted.url, { method: "POST", body: body("server-error-disposable") })).status, 200);
		submittedRaw!.emit("error", new Error("injected post-listen error after artifact"));
		await submitted.close();
		assert.equal(submitted.state, "closed");
		assert.deepEqual(readdirSync(directory), []);
		await assert.rejects(fetch(submitted.url));
	} finally {
		if (pending) await pending.close();
		if (submitted) await submitted.close();
		if (oldRuntime === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = oldRuntime;
		rmSync(directory, { recursive: true, force: true });
	}


});
test("artifact fault injection unlinks a partially created 0600 artifact", async () => {
	const directory = mkdtempSync(join("/tmp", "getpass-web-fault-"));
	const oldRuntime = process.env.XDG_RUNTIME_DIR;
	process.env.XDG_RUNTIME_DIR = directory;
	const server = await startSecureWebServer({ host: "127.0.0.1", prompt: "fault", ttlMs: 10_000, artifactFailure: "after-write", requestId: "f".repeat(36) });
	try {
		const response = await fetch(server.url, { method: "POST", body: body("fault-disposable") });
		assert.equal(response.status, 500);
		await assert.rejects(server.waitForSubmission());
		assert.deepEqual(readdirSync(directory), []);
	} finally {
		await server.close();
		if (oldRuntime === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = oldRuntime;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("held-open POST is force-destroyed during cancellation", async () => {
	const server = await startSecureWebServer({ host: "127.0.0.1", prompt: "held", ttlMs: 10_000, postTimeoutMs: 10_000 });
	const parsed = new URL(server.url);
	const request = http.request({ hostname: parsed.hostname, port: Number(parsed.port), path: parsed.pathname, method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" } });
	request.on("error", () => undefined);
	const connected = new Promise<void>((resolve) => request.once("socket", (socket) => socket.once("connect", resolve)));
	request.write("secret=held-open-disposable");
	await connected;
	await server.cancel();
	assert.equal(server.state, "cancelled");
	await assert.rejects(fetch(server.url, { method: "POST", body: body("after-cancel") }));
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
	const oldLoopback = process.env.GETPASS_WEB_ALLOW_LOOPBACK;
	process.env.GETPASS_WEB_HOST = "127.0.0.1";
	process.env.GETPASS_WEB_ALLOW_LOOPBACK = "1";
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
		if (oldHost === undefined) delete process.env.GETPASS_WEB_HOST; else process.env.GETPASS_WEB_HOST = oldHost;
		if (oldLoopback === undefined) delete process.env.GETPASS_WEB_ALLOW_LOOPBACK; else process.env.GETPASS_WEB_ALLOW_LOOPBACK = oldLoopback;
	}
});

const piAvailable = spawnSync("pi", ["--version"], { encoding: "utf8" }).status === 0;
test("isolated Pi RPC proves idle and busy followUp delivery without sensitive payloads", { skip: !piAvailable }, () => {
	const directory = mkdtempSync(join("/tmp", "getpass-rpc-probe-"));
	const extensionPath = join(directory, "probe.ts");
	writeFileSync(extensionPath, `export default function (pi) {\n  pi.on("session_start", () => {\n    pi.sendUserMessage("getpass web rpc idle: ready; invoke bounded status or consume.", { deliverAs: "followUp", expandPromptTemplates: false });\n    setTimeout(() => { try { pi.sendUserMessage("getpass web rpc busy: ready; invoke bounded status or consume.", { deliverAs: "followUp", expandPromptTemplates: false }); } catch {} }, 10);\n  });\n}\n`);
	try {
		const result = spawnSync("pi", ["--mode", "rpc", "--no-session", "--no-extensions", "--no-tools", "--offline", "-e", extensionPath], { input: "", encoding: "utf8", timeout: 5_000 });
		assert.equal(result.status, 0);
		const transcript = result.stdout ?? "";
		assert.match(transcript, /getpass web rpc idle: ready; invoke bounded status or consume/);
		assert.match(transcript, /\"followUp\":\[\"getpass web rpc busy: ready; invoke bounded status or consume/);
		for (const forbidden of ["test-only-getpass-web-value", "disposable", "GETPASS_WEB", "http://", "/tmp/", "secret", "fault"]) assert.equal(transcript.includes(forbidden), false, `sensitive RPC evidence: ${forbidden}`);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
