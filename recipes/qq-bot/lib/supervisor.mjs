import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DEBROOT, HOME_DIR, LIB_DIR, LOG_DIR, PREFIX, QR_FILE, QQ_BIN, QQ_DIR,
  ROOT, RUN_DIR, STATE_FILE, TMP_DIR, ensureLayout,
} from "./paths.mjs";
import { loadConfig } from "./config.mjs";

const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "bridge.mjs");
const SUP_LOG = path.join(LOG_DIR, "supervisor.log");
const MAX_LOG = 5 * 1024 * 1024;

process.umask(0o077);
ensureLayout();

let stopping = false;
let xvfb = null;
let qq = null;
let bridge = null;
let proxyServer = null;
let qrServer = null;
let display = null;
let proxyPort = null;
let qrPort = null;
let login = null;
let qrToken = crypto.randomBytes(16).toString("hex");
let xauthFile = null;
let restarts = { qq: [], bridge: [] };
const childLogs = {};

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    if (fs.existsSync(SUP_LOG) && fs.statSync(SUP_LOG).size > MAX_LOG) {
      fs.renameSync(SUP_LOG, SUP_LOG + ".1");
    }
    fs.appendFileSync(SUP_LOG, line);
  } catch {}
  process.stdout.write(line);
}

function childLog(name) {
  const p = path.join(LOG_DIR, `${name}.log`);
  if (!childLogs[name]) {
    if (fs.existsSync(p) && fs.statSync(p).size > MAX_LOG) {
      try { fs.renameSync(p, p + ".1"); } catch {}
    }
    childLogs[name] = fs.openSync(p, "a", 0o600);
  }
  return childLogs[name];
}

function writeState(extra = {}) {
  const state = {
    pid: process.pid,
    display,
    proxyPort,
    qrPort,
    qrToken,
    qqPid: qq?.pid || null,
    bridgePid: bridge?.pid || null,
    login,
    startedAt: META.startedAt,
    ...extra,
  };
  try {
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
  } catch {}
}

const META = { startedAt: new Date().toISOString() };

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  delete env.LD_LIBRARY_PATH;
  delete env.LD_AUDIT;
  delete env.LD_DEBUG;
  return { ...env, ...extra };
}

function libraryPath() {
  try {
    const s = fs.readFileSync(LIB_DIR, "utf8").trim();
    if (s) return s;
  } catch {}
  const dirs = [];
  for (const base of ["usr/lib/aarch64-linux-gnu", "usr/lib", "lib/aarch64-linux-gnu", "lib"]) {
    const d = path.join(DEBROOT, base);
    if (fs.existsSync(d)) dirs.push(d);
  }
  dirs.push(path.join(PREFIX, "glibc", "lib"));
  return [...new Set(dirs)].join(":");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pickDisplay() {
  for (let n = 99; n <= 120; n++) {
    const sock = path.join(PREFIX, "tmp", ".X11-unix", `X${n}`);
    const lock = path.join(PREFIX, "tmp", `.X${n}-lock`);
    if (!fs.existsSync(sock) && !fs.existsSync(lock)) return n;
  }
  throw new Error("找不到空闲的 X 显示号（99–120 都占用）");
}

async function startXvfb() {
  fs.mkdirSync(path.join(PREFIX, "tmp"), { recursive: true, mode: 0o700 });
  display = pickDisplay();
  xauthFile = path.join(RUN_DIR, ".Xauthority");
  try { fs.rmSync(xauthFile, { force: true }); } catch {}
  const cookie = crypto.randomBytes(16).toString("hex");
  const xauth = spawnSync(path.join(PREFIX, "bin", "xauth"),
    ["-f", xauthFile, "add", `:${display}`, ".", cookie], { env: cleanEnv() });
  if (xauth.status !== 0) {
    throw new Error(`xauth 生成失败：${(xauth.stderr || "").toString().slice(0, 200)}`);
  }
  try { fs.chmodSync(xauthFile, 0o600); } catch {}
  const logFd = childLog("xvfb");
  xvfb = spawn(path.join(PREFIX, "bin", "Xvfb"),
    [`:${display}`, "-screen", "0", "720x1280x24", "-nolisten", "tcp", "-auth", xauthFile],
    { env: cleanEnv(), stdio: ["ignore", logFd, logFd] });
  xvfb.on("exit", (code, sig) => {
    if (!stopping) {
      log(`Xvfb 退出 code=${code} sig=${sig}，服务停止；请重新 qq-bot start`);
      shutdown("xvfb-exit");
    }
  });
  const sock = path.join(PREFIX, "tmp", ".X11-unix", `X${display}`);
  for (let i = 0; i < 50; i++) {
    if (fs.existsSync(sock)) {
      log(`Xvfb :${display} 已启动`);
      return;
    }
    if (xvfb.exitCode !== null) throw new Error(`Xvfb 启动失败，见 ${LOG_DIR}/xvfb.log`);
    await sleep(200);
  }
  throw new Error("Xvfb 启动超时");
}

async function startProxy() {
  proxyPort = 6000 + display;
  const sock = path.join(PREFIX, "tmp", ".X11-unix", `X${display}`);
  proxyServer = net.createServer((client) => {
    const upstream = net.connect(sock);
    client.pipe(upstream);
    upstream.pipe(client);
    const close = () => { client.destroy(); upstream.destroy(); };
    client.on("error", close);
    upstream.on("error", close);
    client.on("close", close);
    upstream.on("close", close);
  });
  await new Promise((resolve, reject) => {
    proxyServer.once("error", reject);
    proxyServer.listen(proxyPort, "127.0.0.1", resolve);
  });
  log(`X 代理 127.0.0.1:${proxyPort} → ${sock}`);
}

function qqEnv() {
  const env = cleanEnv();
  delete env.LD_PRELOAD;
  const libs = libraryPath();
  return {
    ...env,
    HOME: HOME_DIR,
    TMPDIR: TMP_DIR,
    XDG_CONFIG_HOME: path.join(HOME_DIR, ".config"),
    XDG_CACHE_HOME: path.join(HOME_DIR, ".cache"),
    XDG_DATA_HOME: path.join(HOME_DIR, ".local", "share"),
    XDG_RUNTIME_DIR: RUN_DIR,
    XDG_DATA_DIRS: `${path.join(DEBROOT, "usr", "share")}:/usr/share`,
    DISPLAY: `127.0.0.1:${display}`,
    LIBGL_ALWAYS_SOFTWARE: "1",
    NO_AT_BRIDGE: "1",
    GSETTINGS_BACKEND: "memory",
    GSETTINGS_SCHEMA_DIR: path.join(DEBROOT, "usr/share/glib-2.0/schemas"),
    GDK_PIXBUF_MODULE_FILE: path.join(DEBROOT, "usr/lib/aarch64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders.cache"),
    FONTCONFIG_FILE: path.join(ROOT, "etc", "fonts.conf"),
    FONTCONFIG_PATH: path.join(DEBROOT, "etc", "fonts"),
    XAUTHORITY: xauthFile,
    LD_LIBRARY_PATH: libs,
  };
}

async function startQq() {
  if (!fs.existsSync(QQ_BIN)) throw new Error(`QQ 未安装：${QQ_BIN}`);
  try { fs.rmSync(QR_FILE, { force: true }); } catch {}
  const logFd = childLog("qq");
  qq = spawn(QQ_BIN, ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    { cwd: QQ_DIR, env: qqEnv(), stdio: ["ignore", logFd, logFd] });
  qq.on("exit", (code, sig) => {
    if (stopping) return;
    log(`QQ 退出 code=${code} sig=${sig}`);
    qq = null;
    login = null;
    writeState();
    const now = Date.now();
    restarts.qq = restarts.qq.filter((t) => now - t < 120000);
    restarts.qq.push(now);
    const delay = restarts.qq.length > 3 ? 30000 : 5000;
    setTimeout(() => { if (!stopping) startQq().catch((e) => log(`QQ 重启失败：${e.message}`)); }, delay);
  });
  log(`QQ 已启动 pid=${qq.pid}`);
  writeState();
}

async function startBridge() {
  const logFd = childLog("bridge");
  // bridge 自己写 logs/bridge.log；stdout 不再重定向到同一个文件，避免每行写两遍
  bridge = spawn(process.execPath, [BRIDGE],
    { env: cleanEnv(), stdio: ["ignore", "ignore", logFd] });
  bridge.on("exit", (code, sig) => {
    if (stopping) return;
    log(`bridge 退出 code=${code} sig=${sig}，5s 后重启`);
    bridge = null;
    writeState();
    setTimeout(() => { if (!stopping) startBridge().catch((e) => log(`bridge 重启失败：${e.message}`)); }, 5000);
  });
  log(`bridge 已启动 pid=${bridge.pid}`);
  writeState();
}

function qrPage() {
  const qs = `?token=${qrToken}`;
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QQ 扫码登录</title>
<style>
body{background:#0b1220;color:#cfe6ff;font-family:system-ui;text-align:center;padding:18px}
img{width:min(78vw,340px);image-rendering:pixelated;background:#fff;padding:10px;border-radius:14px}
p{line-height:1.6;font-size:14px;opacity:.85} code{background:#16233a;padding:2px 5px;border-radius:4px}
</style>
<h2>QQ 扫码登录</h2>
<div id="box"><img src="/qr.png${qs}" alt="二维码"></div>
<p id="hint">二维码 60–90 秒过期。扫完后请在手机上立刻点「确认登录」。</p>
<p>登录后回到终端：<code>qq-bot status</code>，再用 <code>qq-bot allow add 你的QQ号</code> 放行会话。</p>
<script>
setInterval(()=>{const i=document.querySelector('#box img'); if(i) i.src='/qr.png?token=${qrToken}&t='+Date.now();},2000);
fetch('/status${qs}').then(r=>r.json()).then(s=>{if(s.login){document.querySelector('#box').innerHTML='<p>已登录：'+s.login.nickname+'（'+s.login.user_id+'）</p>';document.querySelector('#hint').textContent='这个页面可以关了。';}}).catch(()=>{});
</script>`;
  qrServer = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.searchParams.get("token") !== qrToken) {
      res.writeHead(403); res.end("forbidden");
      return;
    }
    if (u.pathname === "/qr.png") {
      try {
        const data = fs.readFileSync(QR_FILE);
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
        res.end(data);
      } catch {
        res.writeHead(404); res.end("no qr");
      }
      return;
    }
    if (u.pathname === "/status") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ login }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html);
  });
  return new Promise((resolve) => {
    const ports = [8787, 8788, 8789];
    const tryPort = (i) => {
      if (i >= ports.length) {
        qrPort = null;
        log("二维码页面端口 8787–8789 都占用，页面未启动（二维码文件仍在 cache/qrcode.png）");
        resolve();
        return;
      }
      qrServer.once("error", () => {
        try { qrServer.close(); } catch {}
        tryPort(i + 1);
      });
      qrServer.listen(ports[i], "127.0.0.1", () => {
        qrPort = ports[i];
        log(`二维码页面 http://127.0.0.1:${qrPort}/（需要 state.json 里的 token）`);
        resolve();
      });
    };
    tryPort(0);
  });
}

async function pollLogin() {
  const cfg = loadConfig();
  const url = `${cfg.onebot.httpUrl.replace(/\/$/, "")}/get_login_info`;
  for (;;) {
    if (stopping) return;
    try {
      const r = await fetch(url, {
        headers: cfg.onebot.accessToken ? { Authorization: `Bearer ${cfg.onebot.accessToken}` } : {},
        signal: AbortSignal.timeout(3000),
      });
      if (r.ok) {
        const j = await r.json();
        if (j.status === "ok" && j.data?.user_id) {
          const next = { user_id: String(j.data.user_id), nickname: j.data.nickname || "" };
          if (!login || login.user_id !== next.user_id) {
            login = next;
            log(`已登录：${login.nickname}（${login.user_id}）`);
            writeState();
          }
        }
      }
    } catch {}
    await sleep(5000);
  }
}

async function shutdown(reason = "stop") {
  if (stopping) return;
  stopping = true;
  log(`停止（${reason}）…`);
  for (const s of [qrServer, proxyServer]) {
    try { s?.close(); } catch {}
  }
  for (const c of [bridge, qq, xvfb]) {
    try { c?.kill("SIGTERM"); } catch {}
  }
  await sleep(1500);
  for (const c of [bridge, qq, xvfb]) {
    try { if (c && c.exitCode === null) c.kill("SIGKILL"); } catch {}
  }
  try { fs.rmSync(STATE_FILE, { force: true }); } catch {}
  process.exit(0);
}

async function main() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      if (s.pid && s.pid !== process.pid) {
        try { process.kill(s.pid, 0); log(`已有实例 pid=${s.pid}，退出`); process.exit(0); } catch {}
      }
    } catch {}
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  writeState();
  log(`qq-bot supervisor 启动 pid=${process.pid} · 数据目录 ${ROOT}`);
  await startXvfb();
  await startProxy();
  await startQq();
  await startBridge();
  await qrPage();
  writeState();
  pollLogin();
}

main().catch(async (e) => {
  log(`启动失败：${e.stack || e.message}`);
  await shutdown("error");
  process.exit(1);
});
