import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";

const REDACTION = "****";

export interface BashOperationsLike {
	exec(
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	): Promise<{ exitCode: number | null }>;
}

export class StreamingRedactor {
	private readonly streams = new Map<string, Map<string, string>>();

	redact(toolCallId: string, value: unknown, secrets: Iterable<string>): unknown {
		const stream = this.streams.get(toolCallId) ?? new Map<string, string>();
		this.streams.set(toolCallId, stream);
		return this.redactValue(value, [...secrets], stream, "");
	}

	clear(toolCallId: string): void {
		this.streams.delete(toolCallId);
	}

	private redactValue(value: unknown, secrets: string[], stream: Map<string, string>, path: string): unknown {
		if (typeof value === "string") {
			if (path !== "" && !path.endsWith(".text") && path !== "text") return redactText(value, secrets);
			const previous = stream.get(path);
			let raw = value;
			if (previous !== undefined && value !== previous) {
				if (value.startsWith(previous)) raw = value;
				else if (previous.startsWith(value)) raw = value;
				else raw = previous + value;
			}
			stream.set(path, raw);
			return redactStreamingText(raw, secrets);
		}
		if (Array.isArray(value)) return value.map((item, index) => this.redactValue(item, secrets, stream, `${path}[${index}]`));
		if (value === null || typeof value !== "object") return value;
		const redacted: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			redacted[key] = this.redactValue(item, secrets, stream, path ? `${path}.${key}` : key);
		}
		return redacted;
	}
}

/** Redacts a delta stream while withholding suffixes that may begin a secret. */
export class IncrementalTextRedactor {
	private pending = "";
	private readonly secrets: string[];

	constructor(secrets: Iterable<string>) {
		this.secrets = normalizedSecrets(secrets);
	}

	push(chunk: string): string {
		const text = this.pending + chunk;
		const heldLength = longestSecretPrefixSuffix(text, this.secrets);
		const safeLength = text.length - heldLength;
		this.pending = text.slice(safeLength);
		return redactText(text.slice(0, safeLength), this.secrets);
	}

	finish(): string {
		const output = redactStreamingText(this.pending, this.secrets);
		this.pending = "";
		return output;
	}
}

export function createRedactingBashOperations(base: BashOperationsLike, secrets: Iterable<string>): BashOperationsLike {
	const secretSnapshot = normalizedSecrets(secrets);
	return {
		async exec(command, cwd, options) {
			const redactor = new IncrementalTextRedactor(secretSnapshot);
			const normalizer = new VisibleOutputNormalizer();
			const decoder = new StringDecoder("utf8");
			let finished = false;
			const emit = (output: string) => {
				if (output.length > 0) options.onData(Buffer.from(output));
			};
			const accept = (text: string) => emit(redactor.push(normalizer.push(text)));
			const flush = () => {
				if (finished) return;
				finished = true;
				accept(decoder.end());
				emit(redactor.push(normalizer.finish()));
				emit(redactor.finish());
			};
			try {
				return await base.exec(command, cwd, {
					...options,
					onData(data) {
						accept(decoder.write(data));
					},
				});
			} finally {
				flush();
			}
		},
	};
}

class VisibleOutputNormalizer {
	private pendingControlSequence = "";

	push(chunk: string): string {
		let text = this.pendingControlSequence + chunk;
		this.pendingControlSequence = "";
		const incompleteStart = findIncompleteAnsiStart(text);
		if (incompleteStart >= 0) {
			this.pendingControlSequence = text.slice(incompleteStart);
			text = text.slice(0, incompleteStart);
		}
		return sanitizeVisibleText(stripVTControlCharacters(text));
	}

	finish(): string {
		// An unterminated terminal control sequence is not visible text. Dropping it
		// also prevents a later renderer from completing and interpreting it.
		this.pendingControlSequence = "";
		return "";
	}
}

function findIncompleteAnsiStart(text: string): number {
	let earliest = -1;
	const remember = (index: number) => {
		if (index >= 0 && (earliest < 0 || index < earliest)) earliest = index;
	};

	const oscStart = text.lastIndexOf("\u001b]");
	if (oscStart >= 0) {
		const after = text.slice(oscStart + 2);
		if (!after.includes("\u0007") && !after.includes("\u009c") && !after.includes("\u001b\\")) remember(oscStart);
	}

	for (const introducer of ["\u001b[", "\u009b"]) {
		const start = text.lastIndexOf(introducer);
		if (start < 0) continue;
		const parameters = text.slice(start + introducer.length);
		if (![...parameters].some((character) => {
			const code = character.charCodeAt(0);
			return code >= 0x40 && code <= 0x7e;
		})) remember(start);
	}

	if (text.endsWith("\u001b")) remember(text.length - 1);
	return earliest;
}

function sanitizeVisibleText(text: string): string {
	return Array.from(text)
		.filter((character) => {
			const code = character.codePointAt(0);
			if (code === undefined || code === 0x0d) return false;
			if (code === 0x09 || code === 0x0a) return true;
			if (code <= 0x1f) return false;
			return code < 0xfff9 || code > 0xfffb;
		})
		.join("");
}

export function overwriteObjectInPlace(target: unknown, replacement: unknown): void {
	if (Array.isArray(target) && Array.isArray(replacement)) {
		target.splice(0, target.length, ...replacement);
		return;
	}
	if (target === null || replacement === null || typeof target !== "object" || typeof replacement !== "object") return;
	const targetRecord = target as Record<string, unknown>;
	for (const key of Object.keys(targetRecord)) delete targetRecord[key];
	Object.assign(targetRecord, replacement);
}

export function redactValue(value: unknown, secrets: Iterable<string>): unknown {
	if (typeof value === "string") return redactText(value, secrets);
	if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
	if (value === null || typeof value !== "object") return value;
	const redacted: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) redacted[key] = redactValue(item, secrets);
	return redacted;
}

export function redactText(text: string, secrets: Iterable<string>): string {
	for (const value of normalizedSecrets(secrets)) {
		if (text.includes(value)) text = text.split(value).join(REDACTION);
	}
	return text;
}

function redactStreamingText(text: string, secrets: Iterable<string>): string {
	const values = normalizedSecrets(secrets);
	const redacted = redactText(text, values);
	const heldLength = longestSecretPrefixSuffix(text, values);
	return heldLength > 0 ? redacted.slice(0, -heldLength) + REDACTION : redacted;
}

function normalizedSecrets(secrets: Iterable<string>): string[] {
	return [...secrets].filter((value) => value.length > 0).sort((a, b) => b.length - a.length);
}

function longestSecretPrefixSuffix(text: string, secrets: Iterable<string>): number {
	let longest = 0;
	for (const secret of secrets) {
		for (let length = Math.min(secret.length - 1, text.length); length > longest; length--) {
			if (text.endsWith(secret.slice(0, length))) {
				longest = length;
				break;
			}
		}
	}
	return longest;
}
