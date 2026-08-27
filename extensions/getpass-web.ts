/**
 * Secure, single-use web capture for the getpass web lifecycle.
 *
 * This module has no import-time side effects. The extension starts one server
 * per request and consumes the 0600 hand-off file in the same process without
 * ever printing its contents.
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { isIP, type Socket } from "node:net";

export type WebServerState = "pending" | "submitted" | "cancelled" | "expired" | "closed";

export class WebServerError extends Error {
	readonly reason: "cancelled" | "expired" | "closed" | "failed";

	constructor(reason: "cancelled" | "expired" | "closed" | "failed", message = `getpass web ${reason}`) {
		super(message);
		this.name = "WebServerError";
		this.reason = reason;
	}
}

export interface SecureWebServerOptions {
	prompt: string;
	ttlMs: number;
	allowEmpty?: boolean;
	host?: string;
	requestId?: string;
	postTimeoutMs?: number;
	/** Test-only fault injection; never carries secret data. */
	artifactFailure?: "after-write" | "after-chmod";
	/** Test-only hook for deterministic post-listen server-error coverage. */
	onListeningForTest?: (server: http.Server) => void;
}

export interface SecureWebSubmission {
	readonly artifactPath: string;
}

export interface SecureWebServer {
	readonly requestId: string;
	readonly url: string;
	readonly state: WebServerState;
	waitForSubmission(): Promise<SecureWebSubmission>;
	/** Reads and immediately removes the 0600 hand-off file. */
	consumeSecret(): string;
	cancel(): Promise<void>;
	close(): Promise<void>;
}

const DEFAULT_TTL_MS = 90_000;
const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_POST_TIMEOUT_MS = 5_000;
const CLOSE_FALLBACK_MS = 1_000;

export function isAllowedBindHost(host: string, allowLoopback: boolean): boolean {
	if (isIP(host) === 6) {
		if (host === "::1") return allowLoopback;
		return host.toLowerCase().startsWith("fd7a:115c:a1e0:");
	}
	if (isIP(host) !== 4) return false;
	const octets = host.split(".").map(Number);
	if (octets[0] === 127) return allowLoopback;
	return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

function validateBindHost(host: string, allowLoopback: boolean): string {
	if (!isAllowedBindHost(host, allowLoopback)) throw new WebServerError("failed", "getpass web bind host is not an allowed tailnet address");
	return host;
}

function configuredHost(): string {
	const override = process.env.GETPASS_WEB_HOST?.trim();
	if (override) return validateBindHost(override, process.env.GETPASS_WEB_ALLOW_LOOPBACK === "1");
	try {
		const output = execFileSync("tailscale", ["ip", "-4"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		for (const line of output.split("\n")) {
			const ip = line.trim();
			if (ip) {
				try { return validateBindHost(ip, false); } catch { /* inspect the next address. */ }
			}
		}
	} catch {
		// The caller receives a generic startup failure; no command output is logged.
	}
	throw new WebServerError("failed", "getpass web requires a tailnet address");

}

function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/\n/g, "<br>");
}

const CSS = `:root{--bg:#f6f7f9;--fg:#1d232a;--muted:#6b7280;--accent:#2563eb;--danger:#dc2626;--ok:#16a34a;--card:#fff;--border:#e5e7eb}@media(prefers-color-scheme:dark){:root{--bg:#111418;--fg:#e5e7eb;--muted:#9ca3af;--card:#1b2027;--border:#2a3038}}*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg);min-height:100vh;display:flex;align-items:center;justify-content:center}main{width:min(26em,calc(100vw - 2rem));background:var(--card);border:1px solid var(--border);border-radius:14px;padding:1.5rem 1.25rem;box-shadow:0 2px 10px rgba(0,0,0,.06)}h1{font-size:1.25rem;margin:0 0 .4rem}.prompt{color:var(--muted);margin:0 0 1rem;font-size:.95rem;line-height:1.45}input{width:100%;font-size:1.05rem;padding:.7em .8em;border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--fg)}input:focus{outline:2px solid var(--accent);border-color:transparent}button{width:100%;margin-top:.8rem;font-size:1.05rem;padding:.7em;border:0;border-radius:10px;background:var(--accent);color:#fff;cursor:pointer}button:disabled{opacity:.6;cursor:default}.hint{color:var(--muted);font-size:.82rem;margin:1rem 0 0}.hint.ok{color:var(--ok)}.hint.err{color:var(--danger)}`;
const JS = `(function(){"use strict";var f=document.getElementById("secret-form"),i=document.getElementById("secret"),b=document.getElementById("submit-btn"),s=document.getElementById("status"),h=document.getElementById("ttl-hint"),T=parseInt(document.body.dataset.ttl||"90",10),allowEmpty=document.body.dataset.allowEmpty==="true",l=T;h.textContent="⏱ Link expires in "+l+"s (single use)";var t=setInterval(function(){l-=1;h.textContent="⏱ Link expires in "+l+"s (single use)";if(l<=0){clearInterval(t);h.textContent="⌛ Expired — this page no longer accepts submissions.";f.hidden=true}},1000);f.addEventListener("submit",function(e){e.preventDefault();var v=i.value;if(!v&&!allowEmpty)return;b.disabled=true;b.textContent="Submitting…";s.hidden=false;s.textContent="Submitting…";fetch(window.location.pathname,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({secret:v})}).then(function(r){if(r.ok){s.textContent="✅ Received — you can close this page.";s.className="hint ok";f.hidden=true;clearInterval(t)}else{s.textContent="⚠️ Submission failed (HTTP "+r.status+"), please retry.";s.className="hint err";b.disabled=false;b.textContent="Submit"}}).catch(function(){s.textContent="⚠️ Network error, please retry.";s.className="hint err";b.disabled=false;b.textContent="Submit"});i.value=""})})();`;

function page(options: SecureWebServerOptions, ttlSeconds: number): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>🔐 Secret Entry</title><style>${CSS}</style></head><body data-ttl="${ttlSeconds}" data-allow-empty="${options.allowEmpty === true}"><main><h1>🔐 Secret Entry</h1><p class="prompt">${escapeHtml(options.prompt)}</p><form id="secret-form" autocomplete="off"><input type="password" id="secret" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Paste or type the secret…"><button type="submit" id="submit-btn">Submit</button></form><p id="status" class="hint" hidden></p><p class="hint" id="ttl-hint"></p></main><script>${JS}<\/script></body></html>`;
}

function writeResponse(res: http.ServerResponse, code: number, type: string, body = ""): void {
	res.writeHead(code, {
		"Content-Type": type,
		"Cache-Control": "no-store, no-cache, must-revalidate",
		Pragma: "no-cache",
		"X-Content-Type-Options": "nosniff",
		"Content-Length": Buffer.byteLength(body),
	});
	res.end(body);
}

function samePath(actual: string, expected: string): boolean {
	const a = Buffer.from(actual);
	const b = Buffer.from(expected);
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function unlinkQuietly(file: string | undefined): void {
	if (!file) return;
	try {
		fs.unlinkSync(file);
	} catch {
		// It was already removed, or the runtime directory disappeared.
	}
}

export async function startSecureWebServer(options: SecureWebServerOptions): Promise<SecureWebServer> {
	const requestedRequestId = options.requestId;
	const requestId = requestedRequestId ?? crypto.randomBytes(18).toString("hex");
	if (!/^[a-f0-9]{36}$/.test(requestId)) throw new WebServerError("failed", "getpass web request ID is not a strict opaque hex ID");
	const requestedHost = options.host?.trim();
	const host = requestedHost ? validateBindHost(requestedHost, true) : configuredHost();
	const token = crypto.randomBytes(24).toString("hex");
	const ttlMs = Math.max(1, options.ttlMs);
	const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
	let currentState: WebServerState = "pending";
	let artifactPath: string | undefined;
	let resolveSubmission!: (submission: SecureWebSubmission) => void;
	let rejectSubmission!: (error: Error) => void;
	let submissionSettled = false;
	let closePromise: Promise<void> | undefined;
	let timer: NodeJS.Timeout | undefined;
	let serverFailureHandled = false;

	const submission = new Promise<SecureWebSubmission>((resolve, reject) => {
		resolveSubmission = resolve;
		rejectSubmission = reject;
	});
	// A cancelled/expired request is normally observed by the extension. This
	// handler also prevents an unhandled rejection during host shutdown.
	submission.catch(() => undefined);

	let closeServer: (force?: boolean) => Promise<void> = async () => {};
	const server = http.createServer((req, res) => {
		const requestUrl = req.url ?? "/";
		if (req.method === "GET") {
			if (samePath(requestUrl, `/${token}`)) return writeResponse(res, 200, "text/html; charset=utf-8", page(options, ttlSeconds));
			if (samePath(requestUrl, `/${token}/app.js`)) return writeResponse(res, 200, "application/javascript; charset=utf-8", JS);
			if (samePath(requestUrl, `/${token}/style.css`)) return writeResponse(res, 200, "text/css; charset=utf-8", CSS);
			return writeResponse(res, 404, "text/plain");
		}
		if (req.method !== "POST" || !samePath(requestUrl, `/${token}`)) return writeResponse(res, 404, "text/plain");
		if (currentState !== "pending") return writeResponse(res, currentState === "submitted" ? 409 : 410, "text/plain");
		const postTimeoutMs = Math.max(1, options.postTimeoutMs ?? DEFAULT_POST_TIMEOUT_MS);
		const postTimer = setTimeout(() => req.destroy(), postTimeoutMs);
		req.once("close", () => clearTimeout(postTimer));

		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size <= MAX_BODY_BYTES) chunks.push(chunk);
			else req.destroy();
		});
		req.on("end", () => {
			if (size > MAX_BODY_BYTES || currentState !== "pending") return writeResponse(res, 413, "text/plain");
			const value = new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("secret");
			if (value === null || (value.length === 0 && options.allowEmpty !== true)) return writeResponse(res, 400, "text/plain");
			// Mark before writing so two simultaneous POSTs cannot both win.
			currentState = "submitted";
			const directory = process.env.XDG_RUNTIME_DIR || os.tmpdir();
			artifactPath = path.join(directory, `getpass-${requestId}-${token}.secret`);
			try {
				fs.writeFileSync(artifactPath, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
				fs.chmodSync(artifactPath, 0o600);
				if (options.artifactFailure === "after-write") throw new Error("injected artifact write failure");
				if (options.artifactFailure === "after-chmod") throw new Error("injected artifact chmod failure");
			} catch {
				unlinkQuietly(artifactPath);
				currentState = "closed";
				artifactPath = undefined;
				if (!submissionSettled) {
					submissionSettled = true;
					rejectSubmission(new WebServerError("failed"));
				}
				const failureResponse = writeResponse(res, 500, "text/plain");
				void closeServer();
				return failureResponse;
			}
			if (!submissionSettled) {
				submissionSettled = true;
				resolveSubmission({ artifactPath });
			}
			writeResponse(res, 200, "text/html; charset=utf-8", "<!doctype html><meta charset=utf-8><title>ok</title><body><p>✅ Received — you can close this page.</p></body>");
			void closeServer(false);
		});
	});

	const sockets = new Set<Socket>();
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	server.on("error", () => {
		if (serverFailureHandled) return;
		serverFailureHandled = true;
		currentState = "closed";
		unlinkQuietly(artifactPath);
		artifactPath = undefined;
		if (!submissionSettled) {
			submissionSettled = true;
			rejectSubmission(new WebServerError("failed"));
		}
		void closeServer(true).catch(() => undefined);
	});

	closeServer = (force = true): Promise<void> => {
		if (closePromise) {
			if (force) {
				for (const socket of sockets) socket.destroy();
				(server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
			}
			return closePromise;
		}
		if (timer) clearTimeout(timer);
		closePromise = new Promise((resolve) => {
			let finished = false;
			const finish = () => {
				if (finished) return;
				finished = true;
				clearTimeout(fallback);
				resolve();
			};
			const fallback = setTimeout(finish, CLOSE_FALLBACK_MS);
			if (!server.listening) return finish();
			server.close(finish);
			if (force) {
				for (const socket of sockets) socket.destroy();
				(server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
			}
		});
		return closePromise;
	};

	try {
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => reject(error);
			server.once("error", onError);
			server.listen(0, host, () => {
				server.off("error", onError);
				resolve();
			});
		});
	} catch {
		currentState = "closed";
		await closeServer();
		throw new WebServerError("failed", "getpass web server could not start");
	}

	timer = setTimeout(() => {
		if (currentState !== "pending") return;
		currentState = "expired";
		if (!submissionSettled) {
			submissionSettled = true;
			rejectSubmission(new WebServerError("expired"));
		}
		unlinkQuietly(artifactPath);
		void closeServer();
	}, ttlMs);
	if (options.onListeningForTest) options.onListeningForTest(server);

	const port = (server.address() as { port: number }).port;
	const displayHost = host.includes(":") ? `[${host}]` : host;
	const url = `http://${displayHost}:${port}/${token}`;
	return {
		requestId,
		url,
		get state() {
			return currentState;
		},
		waitForSubmission: () => submission,
		consumeSecret: () => {
			if (currentState !== "submitted" || !artifactPath) throw new WebServerError("closed", "getpass web submission is unavailable");
			try {
				const secret = fs.readFileSync(artifactPath, "utf8");
				unlinkQuietly(artifactPath);
				artifactPath = undefined;
				return secret;
			} catch {
				unlinkQuietly(artifactPath);
				artifactPath = undefined;
				throw new WebServerError("failed", "getpass web submission could not be consumed");
			}
		},
		cancel: async () => {
			if (currentState === "pending") {
				currentState = "cancelled";
				if (!submissionSettled) {
					submissionSettled = true;
					rejectSubmission(new WebServerError("cancelled"));
				}
			}
			unlinkQuietly(artifactPath);
			artifactPath = undefined;
			await closeServer();
		},
		close: async () => {
			if (currentState === "pending") {
				currentState = "closed";
				if (!submissionSettled) {
					submissionSettled = true;
					rejectSubmission(new WebServerError("closed"));
				}
			}
			unlinkQuietly(artifactPath);
			artifactPath = undefined;
			await closeServer();
		},
	};
}

/** Small standalone adapter retained for manual smoke testing. */
async function main(): Promise<void> {
	const prompt = process.argv[2] ?? "Enter secret";
	const ttl = Number.parseInt(process.env.GETPASS_TTL ?? "90", 10);
	const web = await startSecureWebServer({ prompt, ttlMs: Number.isFinite(ttl) ? ttl * 1000 : DEFAULT_TTL_MS });
	process.stdout.write(`${web.url}\n`);
	try {
		await web.waitForSubmission();
		// The extension consumes this file. Standalone users should use the extension;
		// never print a secret from this adapter.
		process.stdout.write("submitted\n");
		await web.close();
	} catch (error) {
		await web.close();
		process.exitCode = error instanceof WebServerError && error.reason === "expired" ? 2 : 1;
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) void main();
