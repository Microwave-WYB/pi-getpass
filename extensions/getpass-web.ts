/**
 * getpass-web.ts — 临时网页秘密输入（tailnet 单次提交，用完即关）
 *
 * 用法:
 *   node --experimental-strip-types extensions/getpass-web.ts "<prompt>"
 *   # stdout 第一行: http://<tailnet-ip>:<port>/<token>
 *   # 用户提交后: 把秘密输出到 stdout 并退出 0；超时退出 2
 *
 * 安全属性:
 *   - 只绑定 tailnet IP（100.64.0.0/10），绝不 0.0.0.0/LAN
 *   - 随机 32-hex token 在 URL 路径，即认证（128 bit）
 *   - 单次提交即关；TTL 兜底（默认 90s，GETPASS_TTL 覆盖）
 *   - 秘密只进内存，不落盘、不写日志；页面 no-store + autocomplete=off
 */
import http from "node:http";
import crypto from "node:crypto";
import { execSync } from "node:child_process";

const PROMPT = process.argv[2] ?? "请输入秘密";
const TTL = parseInt(process.env.GETPASS_TTL ?? "90", 10);
const TOKEN = crypto.randomBytes(16).toString("hex");

function tailnetIp(): string {
  try {
    const out = execSync("tailscale ip -4", { encoding: "utf8" });
    for (const line of out.split("\n")) {
      const ip = line.trim();
      if (ip.startsWith("100.")) return ip;
    }
  } catch {
    /* fall through */
  }
  process.exitCode = 1;
  throw new Error("no tailnet IP found (tailscale up?)");
}

const CSS = `:root{--bg:#f6f7f9;--fg:#1d232a;--muted:#6b7280;--accent:#2563eb;--danger:#dc2626;--ok:#16a34a;--card:#fff;--border:#e5e7eb}@media(prefers-color-scheme:dark){:root{--bg:#111418;--fg:#e5e7eb;--muted:#9ca3af;--card:#1b2027;--border:#2a3038}}*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg);min-height:100vh;display:flex;align-items:center;justify-content:center}main{width:min(26em,calc(100vw - 2rem));background:var(--card);border:1px solid var(--border);border-radius:14px;padding:1.5rem 1.25rem;box-shadow:0 2px 10px rgba(0,0,0,.06)}h1{font-size:1.25rem;margin:0 0 .4rem}.prompt{color:var(--muted);margin:0 0 1rem;font-size:.95rem;line-height:1.45}input{width:100%;font-size:1.05rem;padding:.7em .8em;border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--fg)}input:focus{outline:2px solid var(--accent);border-color:transparent}button{width:100%;margin-top:.8rem;font-size:1.05rem;padding:.7em;border:0;border-radius:10px;background:var(--accent);color:#fff;cursor:pointer}button:disabled{opacity:.6;cursor:default}.hint{color:var(--muted);font-size:.82rem;margin:1rem 0 0}.hint.ok{color:var(--ok)}.hint.err{color:var(--danger)}`;

const JS = `(function(){"use strict";var f=document.getElementById("secret-form"),i=document.getElementById("secret"),b=document.getElementById("submit-btn"),s=document.getElementById("status"),h=document.getElementById("ttl-hint"),T=parseInt(document.body.dataset.ttl||"90",10),l=T;h.textContent="⏱ Link expires in "+l+"s (single use)";var t=setInterval(function(){l-=1;h.textContent="⏱ Link expires in "+l+"s (single use)";if(l<=0){clearInterval(t);h.textContent="⌛ Expired — this page no longer accepts submissions.";f.hidden=true}},1000);f.addEventListener("submit",function(e){e.preventDefault();var v=i.value;if(!v)return;b.disabled=true;b.textContent="Submitting…";s.hidden=false;s.textContent="Submitting…";fetch(window.location.pathname,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({secret:v})}).then(function(r){if(r.ok){s.textContent="✅ Received — you can close this page.";s.className="hint ok";f.hidden=true;clearInterval(t)}else{s.textContent="⚠️ Submission failed (HTTP "+r.status+"), please retry.";s.className="hint err";b.disabled=false;b.textContent="Submit"}}).catch(function(){s.textContent="⚠️ Network error, please retry.";s.className="hint err";b.disabled=false;b.textContent="Submit"});i.value=""})})();`;

function html(): string {
  const esc = PROMPT.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>🔐 Secret Entry</title><style>${CSS}</style></head><body data-ttl="${TTL}"><main><h1>🔐 Secret Entry</h1><p class="prompt">${esc}</p><form id="secret-form" autocomplete="off"><input type="password" id="secret" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Paste or type the secret…" required><button type="submit" id="submit-btn">Submit</button></form><p id="status" class="hint" hidden></p><p class="hint" id="ttl-hint"></p></main><script>${JS}<\/script></body></html>`;
}

const IP = tailnetIp();

function writeHead(res: http.ServerResponse, code: number, ctype: string, body: string | Buffer) {
  res.writeHead(code, {
    "Content-Type": ctype,
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";
  if (req.method === "GET") {
    if (url === `/${TOKEN}`) return writeHead(res, 200, "text/html; charset=utf-8", html());
    if (url === `/${TOKEN}/app.js`) return writeHead(res, 200, "application/javascript; charset=utf-8", JS);
    if (url === `/${TOKEN}/style.css`) return writeHead(res, 200, "text/css; charset=utf-8", CSS);
    return writeHead(res, 404, "text/plain", "");
  }
  if (req.method === "POST" && safeEqual(url, `/${TOKEN}`)) {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const val = new URLSearchParams(body).get("secret") ?? "";
      if (!val) return writeHead(res, 400, "text/plain", "");
      SECRET = val;
      writeHead(res, 200, "text/html; charset=utf-8", "<!doctype html><meta charset=utf-8><title>ok</title><body><p>✅ Received — you can close this page.</p></body>");
      server.close();
    });
    return;
  }
  writeHead(res, 404, "text/plain", "");
});

let SECRET = "";
server.on("error", (err) => {
  console.error(err);
  process.exit(1);
});
server.listen(0, IP, () => {
  const addr = server.address();
  if (addr && typeof addr === "object") {
    console.log(`http://${IP}:${addr.port}/${TOKEN}`);
  }
});

// TTL 兜底
setTimeout(() => {
  if (!SECRET) process.exit(2);
}, TTL * 1000);

server.on("close", () => {
  console.log(SECRET);
  process.exit(0);
});
