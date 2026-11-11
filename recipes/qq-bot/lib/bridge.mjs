import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, readApiKey } from "./config.mjs";
import { LOG_DIR, ensureLayout } from "./paths.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(LOG_DIR, "bridge.log");
const MAX_LOG = 5 * 1024 * 1024;
const seen = new Set();
const seenOrder = [];
const contexts = new Map();
const lastReply = new Map();
let selfId = null;
let ws = null;
let retry = 0;
let active = 0;
const queue = [];
let lastKeyError = 0;

ensureLayout();
process.umask(0o077);

function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}\n`;
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > MAX_LOG) fs.renameSync(LOG, LOG + ".1");
    fs.appendFileSync(LOG, msg);
  } catch {}
  process.stdout.write(msg);
}

function remember(id) {
  if (!id) return true;
  if (seen.has(id)) return false;
  seen.add(id);
  seenOrder.push(id);
  if (seenOrder.length > 500) seen.delete(seenOrder.shift());
  return true;
}

export function extractText(event) {
  const segs = Array.isArray(event.message) ? event.message : [];
  const atMe = event.message_type === "group" && segs.some(
    (s) => s.type === "at" && String(s.data?.qq ?? "") === String(event.self_id ?? selfId ?? ""),
  );
  const text = segs.filter((s) => s.type === "text")
    .map((s) => String(s.data?.text ?? "")).join("").trim();
  return { text, atMe };
}

export function shouldHandle(event, cfg) {
  if (!event || event.post_type !== "message") return null;
  if (!["private", "group"].includes(event.message_type)) return null;
  if (String(event.user_id) === String(event.self_id)) return null;
  const { text, atMe } = extractText(event);
  if (!text) return null;
  if (event.message_type === "private") {
    if (!cfg.allow.private.includes(String(event.user_id))) return null;
    return { kind: "private", id: String(event.user_id), text, atMe };
  }
  if (!cfg.allow.groups.includes(String(event.group_id))) return null;
  let hit = false;
  let body = text;
  if (cfg.groupTrigger === "at") hit = atMe;
  else if (cfg.groupTrigger === "any") hit = true;
  else if (cfg.groupTrigger === "prefix") {
    const p = cfg.behavior.groupPrefix || "";
    hit = !!p && text.startsWith(p);
    if (hit) body = text.slice(p.length).trim();
  }
  if (!hit || !body) return null;
  return { kind: "group", id: String(event.group_id), text: body, atMe };
}

export function stripMarkdown(s) {
  return String(s || "")
    .replace(/```[a-zA-Z0-9_+-]*\n?/g, "")
    .replace(/```/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "· ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildMessages(cfg, chatKey, userText, senderName) {
  const hist = contexts.get(chatKey) || [];
  const sys = cfg.behavior.systemPrompt;
  const msgs = [{ role: "system", content: sys }];
  let budget = 16000;
  const tail = [];
  for (const m of hist.slice(-cfg.behavior.contextMessages).reverse()) {
    const n = String(m.content || "").length;
    if (budget - n < 0) break;
    budget -= n;
    tail.push(m);
  }
  for (const m of tail.reverse()) msgs.push(m);
  const name = senderName ? `${senderName}：` : "";
  msgs.push({ role: "user", content: name + userText });
  return msgs;
}

function rememberTurn(chatKey, userText, reply) {
  const hist = contexts.get(chatKey) || [];
  hist.push({ role: "user", content: userText });
  hist.push({ role: "assistant", content: reply });
  const cap = 40;
  while (hist.length > cap) hist.shift();
  contexts.set(chatKey, hist);
}

export async function callBackend(cfg, messages, fetchImpl = fetch) {
  const key = readApiKey(cfg);
  let base = String(cfg.backend.baseUrl || "").replace(/\/+$/, "");
  if (!/\/chat\/completions$/.test(base)) base += "/chat/completions";
  const r = await fetchImpl(base, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: cfg.backend.model,
      messages,
      max_tokens: cfg.backend.maxTokens,
      temperature: cfg.backend.temperature,
    }),
    signal: AbortSignal.timeout(cfg.backend.timeoutMs),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`模型接口 ${r.status}：${body.slice(0, 300)}`);
  }
  const j = await r.json();
  const content = j.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => typeof p === "string" ? p : (p?.text || "")).join("");
  }
  throw new Error("模型接口没有返回 choices[0].message.content");
}

export async function sendOneBot(cfg, action, params, fetchImpl = fetch) {
  const url = `${String(cfg.onebot.httpUrl).replace(/\/+$/, "")}/${action}`;
  const headers = { "Content-Type": "application/json" };
  if (cfg.onebot.accessToken) headers.Authorization = `Bearer ${cfg.onebot.accessToken}`;
  const r = await fetchImpl(url, {
    method: "POST", headers, body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`OneBot ${action} HTTP ${r.status}`);
  const j = await r.json().catch(() => ({}));
  if (j.status && j.status !== "ok") throw new Error(`OneBot ${action}: ${j.message || j.wording || j.status}`);
  return j;
}

function senderName(event) {
  const s = event.sender || {};
  return String(s.card || s.nickname || "").slice(0, 40);
}

async function handle(event) {
  const cfg = loadConfig();
  if (!remember(event.message_id)) return;
  const job = shouldHandle(event, cfg);
  if (!job) return;
  job.text = job.text.slice(0, cfg.behavior.maxInputChars);
  const chatKey = `${job.kind}:${job.id}`;
  const now = Date.now();
  if (now - (lastReply.get(chatKey) || 0) < cfg.behavior.cooldownMs) return;
  lastReply.set(chatKey, now);
  queue.push({ event, cfg, job, chatKey });
  pump();
}

function pump() {
  while (active < 2 && queue.length) {
    const item = queue.shift();
    active++;
    run(item).finally(() => { active--; pump(); });
  }
}

async function run({ event, cfg, job, chatKey }) {
  const t0 = Date.now();
  try {
    const messages = buildMessages(cfg, chatKey, job.text, senderName(event));
    let reply = await callBackend(cfg, messages);
    reply = stripMarkdown(reply).slice(0, cfg.behavior.maxReplyChars).trim();
    if (!reply) return;
    const params = job.kind === "private"
      ? { user_id: Number(job.id), message: [{ type: "text", data: { text: reply } }] }
      : { group_id: Number(job.id), message: [{ type: "text", data: { text: reply } }] };
    await sendOneBot(cfg, job.kind === "private" ? "send_private_msg" : "send_group_msg", params);
    rememberTurn(chatKey, job.text, reply);
    log(`回复 ${job.kind}:${job.id} · ${reply.length} 字 · ${Date.now() - t0}ms`);
  } catch (e) {
    if (/API 密钥文件/.test(e.message)) {
      if (Date.now() - lastKeyError > 60000) {
        lastKeyError = Date.now();
        log(`未配置模型密钥：${e.message.split("\n")[0]}（只记一次/分钟）`);
      }
    } else {
      log(`处理失败 ${job.kind}:${job.id}：${String(e.message || e).slice(0, 300)}`);
    }
  }
}

function connect() {
  const cfg = loadConfig();
  let url;
  try {
    url = new URL(cfg.onebot.wsUrl);
  } catch {
    log(`OneBot WS 地址无效：${cfg.onebot.wsUrl}`);
    setTimeout(connect, 5000);
    return;
  }
  if (cfg.onebot.accessToken) url.searchParams.set("access_token", cfg.onebot.accessToken);
  log(`连接 OneBot ${url.origin}${url.pathname}…`);
  ws = new WebSocket(url);
  ws.addEventListener("open", () => {
    retry = 0;
    log("OneBot 已连接");
  });
  ws.addEventListener("message", (ev) => {
    let data;
    try { data = JSON.parse(String(ev.data)); } catch { return; }
    if (data.self_id) selfId = data.self_id;
    handle(data).catch((e) => log(`事件处理异常：${e.message}`));
  });
  ws.addEventListener("error", () => {});
  ws.addEventListener("close", () => {
    ws = null;
    const delay = Math.min(30000, 2000 * 2 ** Math.min(retry++, 4));
    log(`OneBot 断开，${Math.round(delay / 1000)}s 后重连`);
    setTimeout(connect, delay);
  });
}

function main() {
  log(`qq-bot bridge 启动 pid=${process.pid}`);
  if (typeof WebSocket === "undefined") {
    log("Node 没有全局 WebSocket，需要 Node 22+");
    process.exit(1);
  }
  connect();
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main();
