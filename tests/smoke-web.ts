// smoke test: getpass via:"web" → mock API → auto-submit secret → verify env var
import mod from "../extensions/getpass.ts";

const tools: Record<string, any> = {};
const api: any = {
  on: () => {},
  registerTool: (t: any) => { tools[t.name] = t; },
  registerCommand: () => {},
};
mod(api);

const tool = tools.getpass;
if (!tool) { console.error("FAIL: getpass tool not registered"); process.exit(1); }

const ctx = {
  hasUI: true,
  mode: "tui",
  ui: {
    notify: (msg: string) => {
      console.log("[notify]", msg.split("\n").pop()?.trim());
      const url = msg.match(/https?:\/\/[^\s]+/)?.[0];
      if (!url) { console.error("FAIL: no URL in notify"); process.exit(1); }
      setTimeout(async () => {
        const r = await fetch(url, { method: "POST", body: new URLSearchParams({ secret: "smoke-secret-xyz" }) });
        console.log("[submit] http", r.status);
      }, 300);
    },
  },
};

const p = tool.execute("smoke-id", { envVar: "SMOKE_TEST", via: "web", prompt: "smoke test" }, undefined, undefined, ctx);
const result = await p;
const ok = process.env.SMOKE_TEST === "smoke-secret-xyz" && result.details.inputChannel === "web";
console.log("env var:", process.env.SMOKE_TEST);
console.log("details:", JSON.stringify(result.details));
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
