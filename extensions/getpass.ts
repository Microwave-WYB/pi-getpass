import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { Input, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

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
});

const unsetSchema = Type.Object({
	envVar: Type.String({ description: "Tracked secret environment variable to unset." }),
});

const listSchema = Type.Object({});

type GetpassParams = Static<typeof getpassSchema>;
type UnsetParams = Static<typeof unsetSchema>;

export default function (pi: ExtensionAPI) {
	const trackedSecrets = new Set<string>();

	pi.registerTool({
		name: "getpass",
		label: "Get Secret",
		description:
			"Securely ask the user for a secret through the TUI, without putting the secret in chat/session history, and store it in an agent-chosen temporary environment variable for later tool calls.",
		promptSnippet: "Securely prompt the user for a secret and store it in a temporary env var.",
		promptGuidelines: [
			"Use getpass whenever you need a secret/API key/token from the user; never ask the user to paste secrets into chat.",
			"When calling getpass, choose a clear exact env var name such as OPENAI_API_KEY, GITHUB_TOKEN, or DATABASE_URL.",
			"After getpass succeeds, use shell expansion with that exact env var name; do not echo, print, or read back the secret.",
		],
		parameters: getpassSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await collectSecret(ctx, params);
			process.env[result.envVar] = result.secret;
			trackedSecrets.add(result.envVar);

			return {
				content: [
					{
						type: "text" as const,
						text: `Secret captured and stored in temporary environment variable ${result.envVar}. The value was not written to session history.`,
					},
				],
				details: {
					envVar: result.envVar,
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
			const envVars = [...trackedSecrets].filter((name) => process.env[name] !== undefined).sort();
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
			trackedSecrets.add(result.envVar);
			ctx.ui.notify(`Stored secret in ${result.envVar} for this pi process.`, "info");
		},
	});

	pi.registerCommand("getpass-list", {
		description: "List getpass env var names currently tracked in this pi runtime.",
		handler: async (_args, ctx) => {
			const envVars = [...trackedSecrets].filter((name) => process.env[name] !== undefined).sort();
			ctx.ui.notify(envVars.length === 0 ? "No getpass secrets are currently tracked." : `Getpass env vars: ${envVars.join(", ")}`, "info");
		},
	});

	pi.registerCommand("getpass-unset", {
		description: "Unset a getpass env var. Usage: /getpass-unset ENV_VAR",
		handler: async (args, ctx) => {
			const envVar = validateEnvVar({ envVar: args.trim() });
			const existed = process.env[envVar] !== undefined;
			delete process.env[envVar];
			trackedSecrets.delete(envVar);
			ctx.ui.notify(existed ? `Unset ${envVar}.` : `${envVar} was not set.`, "info");
		},
	});
}

async function collectSecret(ctx: ExtensionContext, params: GetpassParams): Promise<{ envVar: string; secret: string }> {
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

	return { envVar, secret };
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
