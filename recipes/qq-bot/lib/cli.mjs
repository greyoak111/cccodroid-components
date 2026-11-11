import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  API_KEY_FILE, CONFIG_FILE, HOME_DIR, LIB_DIR, LIB_INSTALLER, LIB_SELFTEST,
  LIB_SUPERVISOR, LOG_DIR, NAPCAT_DIR, PREFIX, QR_FILE, QQ_BIN, ROOT, SETUP_FILE,
  STATE_FILE, ensureLayout,
} from "./paths.mjs";
import { loadConfig, redactedConfig, saveConfig, apiKeyPath } from "./config.mjs";

const HELP = `qq-bot —— 原生 Linux QQ + NapCat + OneBot 桥

安装（会下载约 307 MB，装后约 1.1 GB）：
  qq-bot setup --check     只报体积和来源，不下载
  qq-bot setup --yes       征得用户同意后真正安装

运行：
  qq-bot start             启动 QQ / NapCat / 桥（后台）
  qq-bot stop              停止
  qq-bot restart           重启
  qq-bot status            进程、登录状态、二维码页面
  qq-bot qr                打印扫码页面地址
  qq-bot whoami            查询当前登录的 QQ 号

白名单（默认空 = 不响应任何人）：
  qq-bot allow add <QQ号>         允许某个 QQ 私聊
  qq-bot allow remove <QQ号>
  qq-bot allow add-group <群号>   允许某个群（默认只有 @ 机器人时回复）
  qq-bot allow remove-group <群号>
  qq-bot allow list

配置：
  qq-bot config                    打印配置（令牌打码）
  qq-bot config set backend.baseUrl <URL>
  qq-bot config set backend.model <模型名>
  qq-bot config set backend.apiKeyFile <路径>
  qq-bot config set groupTrigger <at|prefix|any>
  qq-bot config set behavior.groupPrefix <前缀>
  qq-bot config set behavior.maxReplyChars <数字>
  qq-bot config set behavior.systemPrompt <文本>

排查：
  qq-bot doctor            检查安装、端口、密钥文件权限
  qq-bot logs [行数]       查看日志（可能含聊天内容，先问用户）
  qq-bot selftest          组件自检（不联网、不登录）
  qq-bot version

模型密钥：自己写入 ${API_KEY_FILE}，不要发到对话里：
  printf '%s' '你的密钥' > ${API_KEY_FILE} && chmod 600 ${API_KEY_FILE}
`;

function out(s = "") { process.stdout.write(s + "\n"); }
function err(s = "") { process.stderr.write(s + "\n"); }

function alive(pid) {
  if (!pid) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return null; }
}

function qrUrl(s) {
  if (!s?.qrPort) return null;
  return `http://127.0.0.1:${s.qrPort}/` + (s.qrToken ? `?token=${s.qrToken}` : "");
}

function setupInstalled() {
  return fs.existsSync(SETUP_FILE) && fs.existsSync(QQ_BIN) &&
    fs.existsSync(path.join(NAPCAT_DIR, "napcat.mjs"));
}

function requireSetup() {
  if (!setupInstalled()) {
    err("还没安装运行环境。先跑 qq-bot setup --check，征得用户同意后再加 --yes。");
    process.exit(1);
  }
}

function cleanEnv() {
  const env = { ...process.env };
  delete env.LD_LIBRARY_PATH;
  return env;
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const t = Date.now() + ms; while (Date.now() < t) {} }
}

function httpJson(url, token, timeout = 4000) {
  return fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(timeout),
  }).then(async (r) => ({ ok: r.ok, status: r.status, json: await r.json().catch(() => null) }));
}

async function loginInfo(cfg) {
  const base = cfg.onebot.httpUrl.replace(/\/+$/, "");
  try {
    const r = await httpJson(`${base}/get_login_info`, cfg.onebot.accessToken);
    if (r.ok && r.json?.status === "ok" && r.json.data?.user_id) return r.json.data;
  } catch {}
  return null;
}

function cmdSetup(args) {
  ensureLayout();
  const passthrough = [];
  if (args.includes("--check")) passthrough.push("--check");
  if (args.includes("--yes")) passthrough.push("--yes");
  if (args.includes("--force")) passthrough.push("--force");
  const i = args.indexOf("--jobs");
  if (i >= 0 && args[i + 1]) passthrough.push("--jobs", args[i + 1]);
  const env = cleanEnv();
  env.PREFIX = PREFIX;
  const r = spawnSync(process.env.PYTHON || "python3",
    [LIB_INSTALLER, ROOT, ...passthrough], { stdio: "inherit", env });
  if (r.error) { err(`无法启动安装器：${r.error.message}`); process.exit(1); }
  process.exit(r.status ?? 1);
}

function cmdStart() {
  requireSetup();
  const s = readState();
  if (s && alive(s.pid)) {
    out(`已经在运行（pid ${s.pid}）· ${qrUrl(s) ? `二维码 ${qrUrl(s)}` : "二维码页面未启动"}`);
    return;
  }
  ensureLayout();
  const env = cleanEnv();
  env.PREFIX = PREFIX;
  const child = spawn(process.execPath, [LIB_SUPERVISOR], {
    detached: true, stdio: "ignore", env, cwd: ROOT,
  });
  child.unref();
  let st = null;
  for (let i = 0; i < 30; i++) {
    sleepSync(200);
    st = readState();
    if (st && alive(st.pid)) break;
  }
  if (!st || !alive(st.pid)) {
    err(`启动失败，看日志：${path.join(LOG_DIR, "supervisor.log")}`);
    process.exit(1);
  }
  // 二维码页面是 supervisor 最后一步起的，稍等它把端口写进 state
  for (let i = 0; i < 25 && !st.qrPort; i++) { sleepSync(200); st = readState() || st; }
  out(`已启动（pid ${st.pid}）`);
  out(`扫码页面：${qrUrl(st) || "未启动（看 qq-bot logs）"}`);
  out("登录后：qq-bot status；放行会话：qq-bot allow add <你的QQ号>");
}

function sleepingMs(ms) { sleepSync(ms); }

function cmdStop() {
  const s = readState();
  const pids = new Set();
  if (s?.pid && alive(s.pid)) pids.add(Number(s.pid));
  for (const p of [s?.qqPid, s?.bridgePid]) if (alive(p)) pids.add(Number(p));
  for (const p of pids) { try { process.kill(p, "SIGTERM"); } catch {} }
  const until = Date.now() + 5000;
  while (Date.now() < until && [...pids].some(alive)) sleepingMs(100);
  for (const p of pids) if (alive(p)) { try { process.kill(p, "SIGKILL"); } catch {} }
  // 进程表里可能还有 QQ / Xvfb（supervisor 被强杀时）：只按组件自己的路径/显示号清
  if (s?.display) {
    for (const pid of pidsMatching(`Xvfb :${s.display}`)) {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
  }
  const leftovers = new Set(pidsMatching(QQ_BIN));
  if (s?.display) for (const pid of pidsMatching(`Xvfb :${s.display}`)) leftovers.add(pid);
  for (const pid of leftovers) { try { process.kill(pid, "SIGTERM"); } catch {} }
  const until2 = Date.now() + 2000;
  while (Date.now() < until2 && [...leftovers].some(alive)) sleepingMs(100);
  for (const pid of leftovers) if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  try { fs.rmSync(STATE_FILE, { force: true }); } catch {}
  out(pids.size ? "已停止" : "没有在运行");
}

function pidsMatching(needle) {
  const out = [];
  let ents = [];
  try { ents = fs.readdirSync("/proc"); } catch { return out; }
  for (const n of ents) {
    if (!/^\d+$/.test(n)) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${n}/cmdline`, "utf8").split("\0").join(" ");
      if (cmd.includes(needle)) out.push(Number(n));
    } catch {}
  }
  return out;
}

async function cmdStatus() {
  const s = readState();
  if (!s || !alive(s.pid)) { out("未运行。用 qq-bot start 启动。"); return; }
  const cfg = loadConfig();
  const info = await loginInfo(cfg);
  out(`supervisor：运行中（pid ${s.pid}）`);
  out(`显示：:${s.display}（X 代理 127.0.0.1:${s.proxyPort}）`);
  out(`QQ：${s.qqPid && alive(s.qqPid) ? `运行中（pid ${s.qqPid}）` : "未运行"}`);
  out(`桥：${s.bridgePid && alive(s.bridgePid) ? `运行中（pid ${s.bridgePid}）` : "未运行"}`);
  out(`OneBot：${s.login || info ? "已登录" : "等待扫码登录"}`);
  if (info || s.login) {
    const d = info || s.login;
    out(`账号：${d.nickname || ""}（${d.user_id}）`);
  }
  if (s.qrPort) out(`扫码页面：${qrUrl(s)}`);
  else if (fs.existsSync(QR_FILE)) out(`二维码文件：${QR_FILE}`);
}

async function cmdWhoami() {
  requireSetup();
  const cfg = loadConfig();
  const info = await loginInfo(cfg);
  if (!info) { err("还没登录（或 OneBot 没起来）。先 qq-bot start 并扫码。"); process.exit(1); }
  out(`${info.nickname || ""}（${info.user_id}）`);
}

function cmdQr() {
  const s = readState();
  if (s?.qrPort) { out(qrUrl(s)); return; }
  if (fs.existsSync(QR_FILE)) { out(QR_FILE); return; }
  err("还没有二维码。先 qq-bot start，等 QQ 起来。");
  process.exit(1);
}

function cmdAllow(args) {
  requireSetup();
  const cfg = loadConfig();
  const [op, value] = args;
  const norm = (v) => {
    if (!/^\d{4,20}$/.test(v || "")) { err("QQ 号/群号应是 4–20 位数字"); process.exit(1); }
    return v;
  };
  if (!op || op === "list") {
    out(`私聊白名单：${cfg.allow.private.length ? cfg.allow.private.join(", ") : "空（不响应任何人）"}`);
    out(`群白名单：${cfg.allow.groups.length ? cfg.allow.groups.join(", ") : "空（不响应任何群）"}`);
    out(`群触发：${cfg.groupTrigger === "at" ? "仅 @ 机器人" : cfg.groupTrigger === "prefix" ? `前缀 ${cfg.behavior.groupPrefix || "(未设置)"}` : "所有消息（不建议）"}`);
    return;
  }
  if (op === "add" || op === "remove") {
    const id = norm(value);
    const set = new Set(cfg.allow.private);
    op === "add" ? set.add(id) : set.delete(id);
    cfg.allow.private = [...set];
    saveConfig(cfg);
    out(`私聊白名单：${cfg.allow.private.join(", ") || "空"}`);
    return;
  }
  if (op === "add-group" || op === "remove-group") {
    const id = norm(value);
    const set = new Set(cfg.allow.groups);
    op === "add-group" ? set.add(id) : set.delete(id);
    cfg.allow.groups = [...set];
    saveConfig(cfg);
    out(`群白名单：${cfg.allow.groups.join(", ") || "空"}`);
    return;
  }
  err(`不认识的子命令：allow ${op}`);
  process.exit(1);
}

function cmdConfig(args) {
  const cfg = loadConfig();
  if (!args.length || args[0] === "get") {
    out(`配置文件：${CONFIG_FILE}`);
    out(JSON.stringify(redactedConfig(cfg), null, 2));
    out(`密钥文件：${apiKeyPath(cfg)}`);
    return;
  }
  if (args[0] !== "set" || args.length < 3) {
    err("用法：qq-bot config set <键> <值>");
    process.exit(1);
  }
  const key = args[1];
  const val = args.slice(2).join(" ");
  const allowed = new Set([
    "backend.baseUrl", "backend.model", "backend.apiKeyFile",
    "backend.maxTokens", "backend.temperature", "backend.timeoutMs",
    "groupTrigger", "behavior.groupPrefix", "behavior.maxReplyChars",
    "behavior.contextMessages", "behavior.cooldownMs", "behavior.systemPrompt",
    "behavior.maxInputChars",
  ]);
  if (!allowed.has(key)) { err(`不支持的键：${key}`); process.exit(1); }
  const numeric = new Set(["backend.maxTokens", "backend.temperature", "backend.timeoutMs",
    "behavior.maxReplyChars", "behavior.contextMessages", "behavior.cooldownMs",
    "behavior.maxInputChars"]);
  let v = numeric.has(key) ? Number(val) : val;
  if (numeric.has(key) && !Number.isFinite(v)) { err("这个键需要数字"); process.exit(1); }
  if (key === "groupTrigger" && !["at", "prefix", "any"].includes(v)) {
    err("groupTrigger 只能是 at / prefix / any"); process.exit(1);
  }
  const [a, b] = key.split(".");
  if (b === undefined) cfg[a] = v;
  else cfg[a][b] = v;
  saveConfig(cfg);
  out(`${key} = ${key.startsWith("backend.") && key.includes("apiKey") ? "(已设置，不显示)" : v}`);
}

function cmdLogs(args) {
  const n = Math.min(500, Math.max(1, Number(args[0]) || 80));
  out(`日志目录：${LOG_DIR}（可能包含聊天内容；只在用户同意时查看）`);
  for (const name of ["supervisor.log", "qq.log", "bridge.log"]) {
    const p = path.join(LOG_DIR, name);
    out(`\n===== ${name} =====`);
    try {
      const lines = fs.readFileSync(p, "utf8").split("\n");
      out(lines.slice(-n).join("\n"));
    } catch { out("(无)"); }
  }
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.setTimeout(1000, () => done(false));
  });
}

async function cmdDoctor() {
  const checks = [];
  const ok = (n, v, hint = "") => checks.push({ n, ok: !!v, hint });
  ok("安装标记", fs.existsSync(SETUP_FILE), "先 qq-bot setup --yes");
  ok("QQ", fs.existsSync(QQ_BIN), "QQ 没装好，重跑 setup");
  ok("NapCat", fs.existsSync(path.join(NAPCAT_DIR, "napcat.mjs")), "NapCat 没装好，重跑 setup");
  ok("glibc 加载器", fs.existsSync(path.join(PREFIX, "glibc", "lib", "ld-linux-aarch64.so.1")));
  ok("Xvfb", fs.existsSync(path.join(PREFIX, "bin", "Xvfb")), "组件依赖没装全，重装组件");
  ok("库路径缓存", fs.existsSync(LIB_DIR), "重跑 setup 生成");
  try {
    const cur = spawnSync("patchelf", ["--print-interpreter", QQ_BIN], { encoding: "utf8" }).stdout.trim();
    ok("QQ 解释器", cur === path.join(PREFIX, "glibc", "lib", "ld-linux-aarch64.so.1"),
      "setup 没改解释器；重跑 qq-bot setup --yes");
  } catch { ok("QQ 解释器", false, "patchelf 不可用"); }
  const cfg = loadConfig();
  const key = apiKeyPath(cfg);
  let mode = null;
  try { mode = fs.statSync(key).mode & 0o777; } catch {}
  ok("模型密钥文件", mode !== null, `按提示自己创建 ${key}`);
  if (mode !== null) ok("密钥文件权限", (mode & 0o077) === 0, `建议 chmod 600 ${key}（当前 ${mode.toString(8)}）`);
  const s = readState();
  ok("supervisor", s && alive(s.pid), "qq-bot start");
  const info = [];
  if (s && alive(s.pid)) {
    info.push(`OneBot HTTP :3000 ${await portOpen(3000) ? "监听中" : "未监听（登录后才会打开）"}`);
    info.push(`OneBot WS :3001 ${await portOpen(3001) ? "监听中" : "未监听（登录后才会打开）"}`);
    info.push(`扫码页面 ${s.qrPort ? (await portOpen(s.qrPort) ? "可访问" : "端口没响应") : "未启动"}`);
  }
  for (const c of checks) out(`${c.ok ? "✓" : "✗"} ${c.n}${c.ok ? "" : " · " + c.hint}`);
  for (const line of info) out(`· ${line}`);
  const bad = checks.filter((c) => !c.ok);
  out(bad.length ? `\n${bad.length} 项需要处理。` : "\n全部通过。");
  process.exit(bad.length ? 1 : 0);
}

function cmdSelftest() {
  const r = spawnSync(process.execPath, [LIB_SELFTEST], { stdio: "inherit", env: cleanEnv() });
  process.exit(r.status ?? 1);
}

function cmdVersion() {
  let setup = {};
  try { setup = JSON.parse(fs.readFileSync(SETUP_FILE, "utf8")); } catch {}
  out(`qq-bot 组件 · Linux QQ ${setup.qq || "未安装"} · NapCat ${setup.napcat || "未安装"}`);
  out(`数据目录：${ROOT}`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  ensureLayout();
  switch (cmd) {
    case undefined:
    case "help":
    case "-h":
    case "--help": out(HELP); break;
    case "setup": cmdSetup(args); break;
    case "start": cmdStart(); break;
    case "stop": cmdStop(); break;
    case "restart": cmdStop(); setTimeout(cmdStart, 500); break;
    case "status": await cmdStatus(); break;
    case "whoami": await cmdWhoami(); break;
    case "qr": cmdQr(); break;
    case "allow": cmdAllow(args); break;
    case "config": cmdConfig(args); break;
    case "logs": cmdLogs(args); break;
    case "doctor": await cmdDoctor(); break;
    case "selftest": cmdSelftest(); break;
    case "version": cmdVersion(); break;
    default: err(`不认识的命令：${cmd}\n`); out(HELP); process.exit(1);
  }
}

main().catch((e) => { err("qq-bot: " + (e.stack || e.message)); process.exit(1); });
