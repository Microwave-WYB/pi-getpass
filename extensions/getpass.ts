import { createLocalBashOperations, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { Input, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
	createRedactingBashOperations,
	overwriteObjectInPlace,
	redactValue,
	StreamingRedactor,
} from "./redaction.ts";
import { startSecureWebServer, type SecureWebServer, WebServerError } from "./getpass-web.ts";

const MAX_TERMINAL_WEB_REQUESTS = 128;
const TERMINAL_WEB_RETENTION_MS = 15 * 60 * 1000;
const READY_WEB_RETENTION_MS = 15 * 60 * 1000;
const MAX_ACTIVE_WEB_REQUESTS = 256;
const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const getpassSchema = Type.Object({
	envVar: Type.String({ description: "Exact temporary environment variable name to populate, for example OPENAI_API_KEY or GITHUB_TOKEN." }),
	overwrite: Type.Optional(Type.Boolean({ description: "Allow replacing an existing env var. Defaults to false." })),
	prompt: Type.Optional(Type.String({ description: "Human-readable prompt. Never include the secret value." })),
	allowEmpty: Type.Optional(Type.Boolean({ description: "Allow an empty secret. Defaults to false." })),
	via: Type.Optional(Type.Union([Type.Literal("tui"), Type.Literal("web")], { description: "Input channel: tui (default) or web." })),
});
const webRequestSchema = Type.Object({ requestId: Type.String({ description: "Opaque getpass web request ID." }) });
const unsetSchema = Type.Object({ envVar: Type.String({ description: "Tracked secret environment variable to unset." }) });
const listSchema = Type.Object({});
type GetpassParams = Static<typeof getpassSchema>;
type UnsetParams = Static<typeof unsetSchema>;
type WebRequestParams = Static<typeof webRequestSchema>;
type WebState = "pending" | "ready" | "expired" | "cancelled" | "failed" | "consumed";
type WebLifecycle = { generation: symbol; shuttingDown: boolean; startingServers: Set<Promise<SecureWebServer>> };

type WebRequest = {
	id: string;
	envVar: string;
	reservation: symbol;
	generation: symbol;
	terminalAt?: number;
	readyTimer?: NodeJS.Timeout;
	captured: boolean;
	server: SecureWebServer;
	state: WebState;
	completion: Promise<void>;
};

export default function (pi: ExtensionAPI) {
	const trackedSecrets = new Map<string, string>();
	// Retired values remain redacted for the lifetime of this extension runtime.
	const redactionSecrets = new Set<string>();
	const streamingRedactor = new StreamingRedactor();
	const webRequests = new Map<string, WebRequest>();
	const reservedEnvVars = new Map<string, symbol>();
	const lifecycle: WebLifecycle = { generation: Symbol("getpass web session"), shuttingDown: false, startingServers: new Set<Promise<SecureWebServer>>() };
	const eventApi = pi as ExtensionAPI & { on: (event: string, handler: (...args: any[]) => any) => unknown };

	pi.on("tool_execution_update", (event) => {
		const redacted = streamingRedactor.redact(event.toolCallId, event.partialResult, redactionSecrets);
		overwriteObjectInPlace(event.partialResult, redacted);
		event.partialResult = redacted;
	});
	pi.on("tool_result", (event) => {
		const content = redactValue(event.content, redactionSecrets) as typeof event.content;
		const details = redactValue(event.details, redactionSecrets);
		return { content, details };
	});
	const localBashOperations = createLocalBashOperations();
	pi.on("user_bash", () => {
		if (redactionSecrets.size === 0) return;
		return { operations: createRedactingBashOperations(localBashOperations, redactionSecrets) };
	});
	pi.on("tool_execution_end", (event) => {
		const redacted = redactValue(event.result, redactionSecrets);
		overwriteObjectInPlace(event.result, redacted);
		event.result = redacted;
		streamingRedactor.clear(event.toolCallId);
	});

	pi.registerTool({
		name: "getpass",
		label: "Get Secret",
		description: "Securely collect a secret into a temporary environment variable. getpass web returns before the user submits.",
		promptSnippet: "Securely collect a secret into a temporary env var (TUI or getpass web).",
		promptGuidelines: ["Use getpass instead of asking for secrets in chat.", "For remote users use via: web; relay only its URL and opaque request ID."],
		parameters: getpassSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (params.via === "web") {
				return await openWebRequest(ctx, params, signal, webRequests, reservedEnvVars, trackedSecrets, redactionSecrets, lifecycle, pi);
			}
			const result = await collectSecret(ctx, params, signal, reservedEnvVars);
			try {
				if (reservedEnvVars.get(result.envVar) !== result.reservation) throw new Error("getpass reservation ownership was lost");
				storeSecret(result.envVar, result.secret, trackedSecrets, redactionSecrets);
			} finally {
				releaseReservation(reservedEnvVars, result.envVar, result.reservation);
			}
			return {
				content: [{ type: "text" as const, text: `Secret captured and stored in temporary environment variable ${result.envVar}. The value was not written to session history.` }],
				details: { envVar: result.envVar, inputChannel: "tui", availableToBash: true },
			};
		},
	});

	pi.registerTool({
		name: "getpass_web_status",
		label: "Getpass Web Status",
		description: "Check a getpass web request without returning a secret.",
		promptSnippet: "Check getpass web request status by opaque request ID.",
		parameters: webRequestSchema,
		async execute(_id, params) {
			const request = requireWebRequest(params, webRequests);
			return safeWebResult(request, "status", trackedSecrets);
		},
	});
	pi.registerTool({
		name: "getpass_web_consume",
		label: "Consume Getpass Web Request",
		description: "Acknowledge a ready getpass web request. Never returns its secret value.",
		promptSnippet: "Acknowledge a ready getpass web request.",
		parameters: webRequestSchema,
		async execute(_id, params) {
			const request = requireWebRequest(params, webRequests);
			if (request.state === "ready") {
				if (request.readyTimer) clearTimeout(request.readyTimer);
				request.state = "consumed";
				request.terminalAt = Date.now();
				pruneWebRequests(webRequests);
			}
			return safeWebResult(request, "consume", trackedSecrets);
		},
	});
	pi.registerTool({
		name: "getpass_web_cancel",
		label: "Cancel Getpass Web Request",
		description: "Cancel a pending getpass web request without revealing a secret.",
		promptSnippet: "Cancel a pending getpass web request by opaque request ID.",
		parameters: webRequestSchema,
		async execute(_id, params) {
			const request = requireWebRequest(params, webRequests);
			if (request.state === "pending") {
				request.state = "cancelled";
				request.terminalAt = Date.now();
				pruneWebRequests(webRequests);
				releaseReservation(reservedEnvVars, request.envVar, request.reservation);
				await request.server.cancel();
			}
			return safeWebResult(request, "cancel", trackedSecrets);
		},
	});

	pi.registerTool({
		name: "getpass_list",
		label: "List Secret Env Vars",
		description: "List env var names populated by getpass. Never returns values.",
		promptSnippet: "List currently tracked getpass env var names.",
		parameters: listSchema,
		async execute() {
			const envVars = [...trackedSecrets.keys()].filter((name) => process.env[name] !== undefined).sort();
			return { content: [{ type: "text" as const, text: envVars.length === 0 ? "No getpass secrets are currently tracked." : `Tracked getpass env vars: ${envVars.join(", ")}` }], details: { envVars } };
		},
	});
	pi.registerTool({
		name: "getpass_unset",
		label: "Unset Secret Env Var",
		description: "Delete a getpass secret from the current process environment.",
		promptSnippet: "Unset a getpass-populated secret env var.",
		parameters: unsetSchema,
		async execute(_id, params) {
			return unsetSecret(params, trackedSecrets, redactionSecrets);
		},
	});

	pi.registerCommand("getpass", {
		description: "Securely prompt for a secret. Usage: /getpass ENV_VAR",
		handler: async (args, ctx) => {
			const envVar = args.trim() || "PI_GETPASS_SECRET";
			const result = await collectSecret(ctx, { envVar, prompt: `Enter secret for ${envVar}`, overwrite: true }, undefined, reservedEnvVars);
			try {
				if (reservedEnvVars.get(result.envVar) !== result.reservation) throw new Error("getpass reservation ownership was lost");
				storeSecret(result.envVar, result.secret, trackedSecrets, redactionSecrets);
			} finally {
				releaseReservation(reservedEnvVars, result.envVar, result.reservation);
			}
			ctx.ui.notify(`Stored secret in ${result.envVar} for this pi process.`, "info");
		},
	});
	pi.registerCommand("getpass-list", {
		description: "List tracked getpass env var names.",
		handler: async (_args, ctx) => {
			const envVars = [...trackedSecrets.keys()].filter((name) => process.env[name] !== undefined).sort();
			ctx.ui.notify(envVars.length === 0 ? "No getpass secrets are currently tracked." : `Getpass env vars: ${envVars.join(", ")}`, "info");
		},
	});
	pi.registerCommand("getpass-unset", {
		description: "Unset a getpass env var. Usage: /getpass-unset ENV_VAR",
		handler: async (args, ctx) => {
			const result = unsetSecret({ envVar: args.trim() }, trackedSecrets, redactionSecrets);
			ctx.ui.notify((await result).content[0]?.text ?? "", "info");
		},
	});

	// The session event is the authoritative extension lifecycle cleanup hook.
	eventApi.on("session_shutdown", async () => {
		lifecycle.shuttingDown = true;
		await Promise.all([...webRequests.values()].map(async (request) => {
			if (request.readyTimer) { clearTimeout(request.readyTimer); request.readyTimer = undefined; }
			if (request.state === "pending") {
				request.state = "cancelled";
				request.terminalAt = Date.now();
				pruneWebRequests(webRequests);
				releaseReservation(reservedEnvVars, request.envVar, request.reservation);
			}
			await request.server.cancel();
		}));
		await Promise.all([...lifecycle.startingServers].map(async (startup) => {
			try { await (await startup).cancel(); } catch { /* startup failure already cleaned itself. */ }
		}));
	});
}

function storeSecret(envVar: string, secret: string, tracked: Map<string, string>, redacted: Set<string>): void {
	process.env[envVar] = secret;
	tracked.set(envVar, secret);
	if (secret.length > 0) redacted.add(secret);
}

function releaseReservation(reserved: Map<string, symbol>, envVar: string, owner: symbol): void {
	if (reserved.get(envVar) === owner) reserved.delete(envVar);
}

function expireReadyRequest(request: WebRequest): void {
	if (request.state !== "ready") return;
	request.state = "expired";
	request.terminalAt = Date.now();
	request.readyTimer = undefined;
	void request.server.cancel();
}

function pruneWebRequests(requests: Map<string, WebRequest>): void {
	const now = Date.now();
	for (const request of requests.values()) {
		if (request.state === "ready" && request.terminalAt !== undefined && now - request.terminalAt > READY_WEB_RETENTION_MS) expireReadyRequest(request);
	}
	// A ready request remains consumable until its explicit 15-minute expiry; only other terminal states are pressure-evictable.
	for (const request of requests.values()) {
		if (request.state !== "pending" && request.state !== "ready" && request.terminalAt !== undefined && now - request.terminalAt > TERMINAL_WEB_RETENTION_MS) requests.delete(request.id);
	}
	const retained = [...requests.values()].filter((request) => request.state !== "pending" && request.state !== "ready" && request.terminalAt !== undefined).sort((a, b) => (a.terminalAt ?? 0) - (b.terminalAt ?? 0));
	for (const request of retained.slice(0, Math.max(0, retained.length - MAX_TERMINAL_WEB_REQUESTS))) requests.delete(request.id);
}

function validateEnvVar(params: Pick<UnsetParams, "envVar">): string {
	const envVar = params.envVar.trim();
	if (!envNamePattern.test(envVar)) throw new Error(`Invalid environment variable name: ${envVar}`);
	return envVar;
}

async function unsetSecret(params: UnsetParams, tracked: Map<string, string>, redacted: Set<string>) {
	const envVar = validateEnvVar(params);
	const existed = process.env[envVar] !== undefined;
	delete process.env[envVar];
	const old = tracked.get(envVar);
	if (old !== undefined && old.length > 0) redacted.add(old);
	tracked.delete(envVar);
	return { content: [{ type: "text" as const, text: existed ? `Unset ${envVar}.` : `${envVar} was not set.` }], details: { envVar, existed } };
}

type CollectedSecret = { envVar: string; secret: string; reservation: symbol };

function reserveEnvVar(envVar: string, overwrite: boolean, reserved: Map<string, symbol>): symbol {
	if (reserved.has(envVar)) throw new Error(`${envVar} already has a pending getpass collection.`);
	if (!overwrite && process.env[envVar] !== undefined) throw new Error(`${envVar} is already set. Choose another env var or pass overwrite: true.`);
	const reservation = Symbol(`getpass ${envVar}`);
	reserved.set(envVar, reservation);
	return reservation;
}

async function collectSecret(ctx: ExtensionContext, params: GetpassParams, signal: AbortSignal | undefined, reserved: Map<string, symbol>): Promise<CollectedSecret> {
	const envVar = validateEnvVar(params);
	if (signal?.aborted) throw new Error("getpass cancelled by user");
	const reservation = reserveEnvVar(envVar, params.overwrite === true, reserved);
	const releaseOnAbort = () => releaseReservation(reserved, envVar, reservation);
	signal?.addEventListener("abort", releaseOnAbort, { once: true });
	try {
		if (!ctx.hasUI || ctx.mode !== "tui") throw new Error("getpass requires the interactive pi TUI so the secret is not exposed in session history.");
		const secret = await promptSecret(ctx, params.prompt?.trim() || `Enter secret for ${envVar}`, envVar);
		if (signal?.aborted) throw new Error("getpass cancelled by user");
		if (secret === null) throw new Error("getpass cancelled by user");
		if (!params.allowEmpty && secret.length === 0) throw new Error("getpass received an empty secret");
		return { envVar, secret, reservation };
	} catch (error) {
		releaseReservation(reserved, envVar, reservation);
		throw error;
	} finally {
		signal?.removeEventListener("abort", releaseOnAbort);
	}
}

async function openWebRequest(
	ctx: ExtensionContext,
	params: GetpassParams,
	signal: AbortSignal | undefined,
	requests: Map<string, WebRequest>,
	reserved: Map<string, symbol>,
	tracked: Map<string, string>,
	redacted: Set<string>,
	lifecycle: WebLifecycle,
	pi: ExtensionAPI,
	) {
	const envVar = validateEnvVar(params);
	if (lifecycle.shuttingDown) throw new Error("getpass web session is shutting down");
	if (signal?.aborted) throw new Error("getpass web cancelled");
	let reservation: symbol | undefined;
	try {
		reservation = reserveEnvVar(envVar, params.overwrite === true, reserved);
		const active = [...requests.values()].filter((request) => request.state === "pending" || request.state === "ready").length + lifecycle.startingServers.size;
		if (active >= MAX_ACTIVE_WEB_REQUESTS) throw new Error(`getpass web active request limit (${MAX_ACTIVE_WEB_REQUESTS}) reached`);
	} catch (error) {
		if (reservation) releaseReservation(reserved, envVar, reservation);
		throw error;
	}
	if (!reservation) throw new Error("getpass web reservation was not acquired");
	const release = () => releaseReservation(reserved, envVar, reservation);
	const ttl = Number.parseInt(process.env.GETPASS_TTL ?? "90", 10);
	const startup = startSecureWebServer({
		prompt: params.prompt?.trim() || `Enter secret for ${envVar}`,
		ttlMs: (Number.isFinite(ttl) ? Math.max(1, ttl) : 90) * 1000,
		allowEmpty: params.allowEmpty,
	});
	lifecycle.startingServers.add(startup);
	let server: SecureWebServer;
	try {
		server = await startup;
	} catch (error) {
		lifecycle.startingServers.delete(startup);
		release();
		throw error;
	}
	if (signal?.aborted || lifecycle.shuttingDown) {
		release();
		await server.cancel();
		lifecycle.startingServers.delete(startup);
		throw new Error(signal?.aborted ? "getpass web cancelled" : "getpass web session is shutting down");
	}
	lifecycle.startingServers.delete(startup);
	const request: WebRequest = { id: server.requestId, envVar, reservation, generation: lifecycle.generation, captured: false, server, state: "pending", completion: Promise.resolve() };
	requests.set(request.id, request);
	const abort = () => {
		if (request.state !== "pending") return;
		request.state = "cancelled";
		request.terminalAt = Date.now();
		pruneWebRequests(requests);
		release();
		void server.cancel();
	};
	signal?.addEventListener("abort", abort, { once: true });
	request.completion = server.waitForSubmission().then(() => {
		if (request.state !== "pending") {
			void server.cancel();
			return;
		}
		const secret = server.consumeSecret();
		if (!params.allowEmpty && secret.length === 0) {
			request.state = "failed";
			request.terminalAt = Date.now();
			pruneWebRequests(requests);
			release();
			return;
		}
		storeSecret(envVar, secret, tracked, redacted);
		request.captured = true;
		release();
		request.state = "ready";
		request.terminalAt = Date.now();
		pruneWebRequests(requests);
		request.readyTimer = setTimeout(() => {
			expireReadyRequest(request);
			pruneWebRequests(requests);
		}, READY_WEB_RETENTION_MS);
		request.readyTimer.unref?.();
		const readyMessage = `getpass web request ${request.id}: ready; invoke getpass_web_consume or getpass_web_status with this request ID.`;
		try { ctx.ui.notify(readyMessage, "info"); } catch { /* UI may be gone during shutdown. */ }
		if (!lifecycle.shuttingDown && request.generation === lifecycle.generation && request.state === "ready") {
			try { pi.sendUserMessage(readyMessage, { deliverAs: "followUp", expandPromptTemplates: false }); } catch { /* Session may have ended. */ }
		}
	}).catch((error: unknown) => {
		release();
		if (request.state === "pending") {
			request.state = error instanceof WebServerError && error.reason === "expired" ? "expired" : "failed";
			request.terminalAt = Date.now();
			pruneWebRequests(requests);
		}
	});
	void request.completion;
	const message = `getpass web opened. Relay this URL and opaque request ID ${request.id}; the secret is never returned in tool output. URL: ${server.url}`;
	try { ctx.ui.notify(`getpass web request ${request.id} opened. Submit within ${Number.isFinite(ttl) ? ttl : 90}s.`, "info"); } catch { /* UI is optional for web capture. */ }
	return { content: [{ type: "text" as const, text: message }], details: { requestId: request.id, envVar, inputChannel: "web", url: server.url, status: "pending", availableToBash: false } };
}

function requireWebRequest(params: WebRequestParams, requests: Map<string, WebRequest>): WebRequest {
	const id = params.requestId.trim();
	if (!/^[a-f0-9]{36}$/.test(id)) throw new Error("Invalid getpass web request ID");
	pruneWebRequests(requests);
	const request = requests.get(id);
	if (!request) throw new Error("Unknown getpass web request ID");
	return request;
}

function safeWebResult(request: WebRequest, operation: string, tracked: Map<string, string>) {
	const availableToBash = request.captured && tracked.has(request.envVar) && process.env[request.envVar] !== undefined;
	return {
		content: [{ type: "text" as const, text: `getpass web ${operation}: ${request.state} (${request.id})` }],
		details: { requestId: request.id, envVar: request.envVar, status: request.state, availableToBash },
	};
}

async function promptSecret(ctx: ExtensionContext, title: string, envVar: string): Promise<string | null> {
	return await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => new SecretPrompt(tui, theme, done, title, envVar));
}

class SecretPrompt implements Component, Focusable {
	private readonly input = new Input();
	private _focused = false;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly done: (value: string | null) => void;
	private readonly title: string;
	private readonly envVar: string;
	constructor(tui: TUI, theme: Theme, done: (value: string | null) => void, title: string, envVar: string) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.title = title;
		this.envVar = envVar;
		this.input.onSubmit = (value) => this.done(value);
		this.input.onEscape = () => this.done(null);
	}
	get focused(): boolean { return this._focused; }
	set focused(value: boolean) { this._focused = value; this.input.focused = value; }
	handleInput(data: string): void { this.input.handleInput(data); this.tui.requestRender(); }
	invalidate(): void { this.input.invalidate(); }
	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const border = (s: string) => th.fg("accent", s);
		const dim = (s: string) => th.fg("dim", s);
		const line = (s = "") => border("│") + pad(truncateToWidth(s, innerW, "...", true), innerW) + border("│");
		const real = this.input.getValue();
		this.input.setValue("•".repeat(real.length));
		this.input.focused = this.focused;
		const [maskedInput = ""] = this.input.render(Math.max(1, innerW - 2));
		this.input.setValue(real);
		return [border(`╭${"─".repeat(innerW)}╮`), line(` ${th.fg("accent", this.title)}`), line(` ${dim(`temporary env var: ${this.envVar}`)}`), line(""), line(` ${maskedInput}`), line(` ${dim("Enter to submit · Esc/Ctrl+D to cancel · value is masked")}`), border(`╰${"─".repeat(innerW)}╯`)];
	}
}
function pad(text: string, width: number): string { return text + " ".repeat(Math.max(0, width - visibleWidth(text))); }
