// Smoke test: getpass via:"web" returns immediately, then a local POST captures a disposable value.
import mod from "../extensions/getpass.ts";

process.env.GETPASS_WEB_HOST = "127.0.0.1";
process.env.GETPASS_WEB_ALLOW_LOOPBACK = "1";
const tools: Record<string, any> = {};
const api: any = {
	on: () => {},
	registerTool: (tool: any) => { tools[tool.name] = tool; },
	registerCommand: () => {},
};
mod(api);
const tool = tools.getpass;
if (!tool) { console.error("FAIL: getpass tool not registered"); process.exit(1); }
const ctx = { hasUI: true, mode: "tui", ui: { notify: () => {} } };
const opened = await tool.execute("smoke-id", { envVar: "SMOKE_TEST", via: "web", prompt: "smoke test" }, undefined, undefined, ctx);
const response = await fetch(opened.details.url, { method: "POST", body: new URLSearchParams({ secret: "smoke-test-disposable" }) });
await new Promise<void>((resolve) => setImmediate(resolve));
const ok = response.status === 200 && process.env.SMOKE_TEST === "smoke-test-disposable" && opened.details.inputChannel === "web" && opened.details.status === "pending";
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
