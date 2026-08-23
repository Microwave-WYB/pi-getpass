import { createLocalBashOperations, type AgentToolUpdateCallback, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { Input, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
	createRedactingBashOperations,
	overwriteObjectInPlace,
	redactValue,
	StreamingRedactor,
} from "./redaction.ts";

const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

const getpassSchema = Type.Object({
	envVar: Type.String({
		description:
			"Exact temporary environment variable name to populate, chosen by the agent for this secret, for example OPENAI_API_KEY or GITHUB_TOKEN.",
	}),
	overwrite: Type.Optional(
		Type.Boolean({
			description: "Allow replacing an existing env var of the same name. Defaults to false.",
		}),
	),
	prompt: Type.Optional(
		Type.String({
			description: "Human-readable prompt to show to the user. Do not include the secret value.",
		}),
	),
	allowEmpty: Type.Optional(
		Type.Boolean({
			description: "Allow an empty secret. Defaults to false.",
		}),
	),
	via: Type.Optional(
		Type.Union([
			Type.Literal("tui"),
			Type.Literal("web"),
		], {
			description:
				"Input channel: \"tui\" (default — masked TUI prompt) or \"web\" (tailnet single-shot web page, phone-friendly; the URL is notified and returned so the agent can relay it).",
		}),
	),
});

const unsetSchema = Type.Object({
	envVar: Type.String({ description: "Tracked secret environment variable to unset." }),
});

const listSchema = Type.Object({});

type GetpassParams = Static<typeof getpassSchema>;
type UnsetParams = Static<typeof unsetSchema>;

type SecretStore = Map<string, string>;

export default function (pi: ExtensionAPI) {
	const trackedSecrets: SecretStore = new Map();
	// Keep retired values redacted until this extension runtime ends. A process
	// that was started before /getpass-unset can still emit the old value.
	const redactionSecrets = new Set<string>();
	const streamingRedactor = new StreamingRedactor();

	// Redact streaming tool output as well as finalized results. Updates may be
	// cumulative snapshots (as bash emits) or deltas (as custom tools may emit).
	// Keeping the raw stream per tool lets us catch a secret split across update
	// boundaries instead of checking each partial result in isolation.
	pi.on("tool_execution_update", (event) => {
		const redacted = streamingRedactor.redact(event.toolCallId, event.partialResult, redactionSecrets);
		// Pi emits a shallow copy of this event and does not propagate property
		// reassignment back to the renderer. Mutate the result object in place too.
		overwriteObjectInPlace(event.partialResult, redacted);
		event.partialResult = redacted;
	});

	pi.on("tool_result", (event) => {
		const content = redactValue(event.content, redactionSecrets) as typeof event.content;
		const details = redactValue(event.details, redactionSecrets);
		return { content, details };
	});

	// Commands entered directly with Pi's !/!! shell syntax bypass tool events.
	// Wrap that execution path so both its live chunks and recorded result contain
	// only redacted output.
	const localBashOperations = createLocalBashOperations();
	pi.on("user_bash", () => {
		if (redactionSecrets.size === 0) return;
		return { operations: createRedactingBashOperations(localBashOperations, redactionSecrets) };
	});

	// Keep the completion event safe for renderers that consume it directly.
	pi.on("tool_execution_end", (event) => {
		const redacted = redactValue(event.result, redactionSecrets);
		overwriteObjectInPlace(event.result, redacted);
		event.result = redacted;
		streamingRedactor.clear(event.toolCallId);
	});

	pi.registerTool({
		name: "getpass",
		label: "Get Secret",
		description:
			"Securely ask the user for a secret through the TUI, without putting the secret in chat/session history, and store it in an agent-chosen temporary environment variable for later tool calls.",
		promptSnippet: "Securely prompt the user for a secret and store it in a temporary env var (TUI or web).",
		promptGuidelines: [
			"Use getpass whenever you need a secret/API key/token from the user; never ask the user to paste secrets into chat.",
			"When calling getpass, choose a clear exact env var name such as OPENAI_API_KEY, GITHUB_TOKEN, or DATABASE_URL.",
			"Use via: \"web\" when the user is remote/on phone — a tailnet single-shot page opens; relay the returned URL to the user (Telegram is approved for this URL).",
		],
		parameters: getpassSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const result =
				params.via === "web"
					? await collectSecretWeb(ctx, params, signal, onUpdate)
					: await collectSecret(ctx, params);
			process.env[result.envVar] = result.secret;
			trackedSecrets.set(result.envVar, result.secret);
			redactionSecrets.add(result.secret);

			return {
				content: [
					{
						type: "text" as const,
						text:
							result.inputChannel === "web"
								? `Secret request opened. The user can submit at this URL (single-shot, ~90s TTL): ${result.url}`
								: `Secret captured and stored in temporary environment variable ${result.envVar}. The value was not written to session history.`,
					},
				],
				details: {
					envVar: result.envVar,
					inputChannel: result.inputChannel,
					availableToBash: true,
				},
			};
		},
	});

	pi.registerTool({
		name: "getpass_list",
		label: "List Secret Env Vars",
		description: "List env var names populated by getpass in this pi runtime. Never returns secret values.",
		promptSnippet: "List names of currently tracked getpass env vars, without values.",
		promptGuidelines: ["Use getpass_list to check which getpass env vars are available; it only returns names, never values."],
		parameters: listSchema,
		async execute() {
			const envVars = [...trackedSecrets.keys()].filter((name) => process.env[name] !== undefined).sort();
			return {
				content: [
					{
						type: "text" as const,
						text: envVars.length === 0 ? "No getpass secrets are currently tracked." : `Tracked getpass env vars: ${envVars.join(", ")}`,
					},
				],
				details: { envVars },
			};
		},
	});

	pi.registerTool({
		name: "getpass_unset",
		label: "Unset Secret Env Var",
		description: "Delete a getpass secret from the current pi process environment.",
		promptSnippet: "Unset a getpass-populated secret env var.",
		promptGuidelines: ["Use getpass_unset when a secret is no longer needed; it deletes the env var without revealing the value."],
		parameters: unsetSchema,
		async execute(_toolCallId, params) {
			const envVar = validateEnvVar(params);
			const existed = process.env[envVar] !== undefined;
			delete process.env[envVar];
			const retiredSecret = trackedSecrets.get(envVar);
			if (retiredSecret !== undefined) redactionSecrets.add(retiredSecret);
			trackedSecrets.delete(envVar);
			return {
				content: [{ type: "text" as const, text: existed ? `Unset ${envVar}.` : `${envVar} was not set.` }],
				details: { envVar, existed },
			};
		},
	});

	pi.registerCommand("getpass", {
		description: "Securely prompt for a secret and store it in a temporary environment variable. Usage: /getpass ENV_VAR",
		handler: async (args, ctx) => {
			const envVar = args.trim() || "PI_GETPASS_SECRET";
			const result = await collectSecret(ctx, { envVar, prompt: `Enter secret for ${envVar}`, overwrite: true });
			process.env[result.envVar] = result.secret;
			trackedSecrets.set(result.envVar, result.secret);
			redactionSecrets.add(result.secret);
			ctx.ui.notify(`Stored secret in ${result.envVar} for this pi process.`, "info");
		},
	});

	pi.registerCommand("getpass-list", {
		description: "List getpass env var names currently tracked in this pi runtime.",
		handler: async (_args, ctx) => {
			const envVars = [...trackedSecrets.keys()].filter((name) => process.env[name] !== undefined).sort();
			ctx.ui.notify(envVars.length === 0 ? "No getpass secrets are currently tracked." : `Getpass env vars: ${envVars.join(", ")}`, "info");
		},
	});

	pi.registerCommand("getpass-unset", {
		description: "Unset a getpass env var. Usage: /getpass-unset ENV_VAR",
		handler: async (args, ctx) => {
			const envVar = validateEnvVar({ envVar: args.trim() });
			const existed = process.env[envVar] !== undefined;
			delete process.env[envVar];
			const retiredSecret = trackedSecrets.get(envVar);
			if (retiredSecret !== undefined) redactionSecrets.add(retiredSecret);
			trackedSecrets.delete(envVar);
			ctx.ui.notify(existed ? `Unset ${envVar}.` : `${envVar} was not set.`, "info");
		},
	});
}

async function collectSecret(ctx: ExtensionContext, params: GetpassParams): Promise<{ envVar: string; secret: string; inputChannel: "tui" }> {
	const envVar = validateEnvVar(params);
	if (!params.overwrite && process.env[envVar] !== undefined) {
		throw new Error(`${envVar} is already set. Choose a different env var name or pass overwrite: true.`);
	}
	if (!ctx.hasUI || ctx.mode !== "tui") {
		throw new Error("getpass requires the interactive pi TUI so the secret is not exposed in session history.");
	}

	const prompt = params.prompt?.trim() || `Enter secret for ${envVar}`;
	const secret = await promptSecret(ctx, prompt, envVar);
	if (secret === null) throw new Error("getpass cancelled by user");
	if (!params.allowEmpty && secret.length === 0) throw new Error("getpass received an empty secret");

	return { envVar, secret, inputChannel: "tui" };
}

/**
 * Web mode: spawn the tailnet single-shot server, expose the URL, and wait for
 * the user's submission. The secret is read straight from the server's stdout
 * and stored via the same tracked/redacted mechanism as the TUI path.
 */
async function collectSecretWeb(
	ctx: ExtensionContext,
	params: GetpassParams,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback<unknown>,
): Promise<{ envVar: string; secret: string; inputChannel: "web"; url: string }> {
	const envVar = validateEnvVar(params);
	if (!params.overwrite && process.env[envVar] !== undefined) {
		throw new Error(`${envVar} is already set. Choose a different env var name or pass overwrite: true.`);
	}

	const prompt = params.prompt?.trim() || `Enter secret for ${envVar}`;
	const cmdStr =
		process.env.GETPASS_WEB_CMD ||
		`node --experimental-strip-types ${fileURLToPath(new URL("./getpass-web.ts", import.meta.url))}`;
	const [cmd, ...cmdArgs] = cmdStr.split(/\s+/);
	const child: ChildProcess = spawn(cmd, [...cmdArgs, prompt], {
		stdio: ["ignore", "pipe", "inherit"],
		shell: false,
	});

	let output = "";
	let stderrTail = "";
	child.stdout?.on("data", (d) => (output += d.toString()));
	child.stderr?.on("data", (d) => (stderrTail = (stderrTail + d.toString()).slice(-400)));

	const exited = new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => resolve(code));
	});
	if (signal?.aborted) {
		child.kill();
		throw new Error("getpass web cancelled");
	}

	// First stdout line is the URL.
	const url = await new Promise<string>((resolve, reject) => {
		const deadline = Date.now() + 5000;
		const timer = setInterval(() => {
			const nl = output.indexOf("\n");
			if (nl >= 0) {
				clearInterval(timer);
				resolve(output.slice(0, nl).trim());
			} else if (Date.now() > deadline) {
				clearInterval(timer);
				reject(new Error("getpass web server did not report a URL"));
			}
		}, 50);
	});

	ctx.ui.notify(`🔐 ${prompt}\n请打开链接并在 ${process.env.GETPASS_TTL ?? "90"}s 内提交（单次生效）:\n${url}`, "info");

	// 执行中把 URL 推给 agent（partial result），让 agent 能实时转发（如 Telegram）
	onUpdate?.({
		content: [
			{
				type: "text" as const,
				text: `🔐 ${prompt}\n请用户打开此链接并在 ${process.env.GETPASS_TTL ?? "90"}s 内提交（单次生效）:\n${url}`,
			},
		],
		details: { envVar, url },
	});

	const code = await exited;
	if (code !== 0) {
		throw new Error(code === 2 ? "getpass web timed out" : `getpass web failed (exit ${code})${stderrTail ? `: ${stderrTail}` : ""}`);
	}
	const lines = output.trimEnd().split("\n");
	const secret = lines[lines.length - 1] ?? "";
	if (!params.allowEmpty && secret.length === 0) throw new Error("getpass web received an empty secret");

	return { envVar, secret, inputChannel: "web", url };
}

function validateEnvVar(params: Pick<UnsetParams, "envVar">): string {
	const envVar = params.envVar.trim();
	if (!envNamePattern.test(envVar)) {
		throw new Error(`Invalid environment variable name: ${envVar}`);
	}
	return envVar;
}

async function promptSecret(ctx: ExtensionContext, title: string, envVar: string): Promise<string | null> {
	return await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) =>
		new SecretPrompt(tui, theme, done, title, envVar),
	);
}

class SecretPrompt implements Component, Focusable {
	private readonly input = new Input();
	private _focused = false;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly done: (value: string | null) => void,
		private readonly title: string,
		private readonly envVar: string,
	) {
		this.input.onSubmit = (value) => this.done(value);
		this.input.onEscape = () => this.done(null);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
		this.tui.requestRender();
	}

	invalidate(): void {
		this.input.invalidate();
	}

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

		return [
			border(`╭${"─".repeat(innerW)}╮`),
			line(` ${th.fg("accent", this.title)}`),
			line(` ${dim(`temporary env var: ${this.envVar}`)}`),
			line(""),
			line(` ${maskedInput}`),
			line(` ${dim("Enter to submit · Esc/Ctrl+D to cancel · value is masked")}`),
			border(`╰${"─".repeat(innerW)}╯`),
		];
	}
}

function pad(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}
