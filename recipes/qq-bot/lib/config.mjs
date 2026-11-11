import fs from "node:fs";
import path from "node:path";
import { API_KEY_FILE, CONFIG_FILE, ROOT, ensureLayout } from "./paths.mjs";

export const DEFAULT_SYSTEM_PROMPT =
  "你是一个通过 QQ 提供帮助的 AI 助手。回答准确、简洁，默认使用中文。被问到身份时如实说明你是 AI，不要假装是人类。不要主动发起话题，不要模仿真人群聊语气，不要发送未经用户要求的内容。遇到不确定的信息直接说不确定。";

export function defaults() {
  return {
    version: 1,
    onebot: {
      wsUrl: "ws://127.0.0.1:3001",
      httpUrl: "http://127.0.0.1:3000",
      accessToken: "",
    },
    allow: { private: [], groups: [] },
    groupTrigger: "at",
    backend: {
      type: "openai",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      apiKeyFile: "",
      maxTokens: 800,
      temperature: 0.7,
      timeoutMs: 120000,
    },
    behavior: {
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      groupPrefix: "",
      maxInputChars: 4000,
      contextMessages: 12,
      maxReplyChars: 600,
      cooldownMs: 3000,
    },
  };
}

function merge(base, extra) {
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (v && typeof v === "object" && !Array.isArray(v) &&
        base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) {
      out[k] = merge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export function normalizeConfig(cfg) {
  const c = merge(defaults(), cfg || {});
  for (const k of ["private", "groups"]) {
    const list = Array.isArray(c.allow?.[k]) ? c.allow[k] : [];
    c.allow[k] = [...new Set(list.map(String).filter((s) => /^\d{4,20}$/.test(s)))];
  }
  if (!["at", "prefix", "any"].includes(c.groupTrigger)) c.groupTrigger = "at";
  if (c.backend?.type !== "openai") c.backend.type = "openai";
  if (!/^https:\/\//i.test(c.backend.baseUrl || "") &&
      !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(c.backend.baseUrl || "")) {
    c.backend.baseUrl = defaults().backend.baseUrl;
  }
  c.backend.maxTokens = Math.min(4096, Math.max(64, Number(c.backend.maxTokens) || 800));
  c.backend.temperature = Math.min(2, Math.max(0, Number(c.backend.temperature) || 0));
  c.backend.timeoutMs = Math.min(300000, Math.max(5000, Number(c.backend.timeoutMs) || 120000));
  c.behavior.groupPrefix = String(c.behavior.groupPrefix ?? "").slice(0, 12);
  c.behavior.maxInputChars = Math.min(20000, Math.max(100, Number(c.behavior.maxInputChars) || 4000));
  c.behavior.contextMessages = Math.min(50, Math.max(0, Number(c.behavior.contextMessages) || 0));
  c.behavior.maxReplyChars = Math.min(4000, Math.max(50, Number(c.behavior.maxReplyChars) || 600));
  c.behavior.cooldownMs = Math.min(60000, Math.max(0, Number(c.behavior.cooldownMs) || 0));
  return c;
}

export function loadConfig() {
  ensureLayout();
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") {
      throw new Error(`配置读取失败 ${CONFIG_FILE}: ${e.message}`);
    }
  }
  return normalizeConfig(raw);
}

export function saveConfig(cfg) {
  ensureLayout();
  const c = normalizeConfig(cfg);
  const tmp = `${CONFIG_FILE}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch {}
  return c;
}

export function ensureConfig() {
  ensureLayout();
  if (!fs.existsSync(CONFIG_FILE)) {
    const c = defaults();
    c.onebot.accessToken = "";
    saveConfig(c);
    return { cfg: normalizeConfig(c), created: true };
  }
  return { cfg: loadConfig(), created: false };
}

export function apiKeyPath(cfg = loadConfig()) {
  const p = cfg.backend.apiKeyFile || API_KEY_FILE;
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

export function readApiKey(cfg = loadConfig()) {
  const p = apiKeyPath(cfg);
  let st;
  try { st = fs.statSync(p); } catch {
    throw new Error(`API 密钥文件不存在：${p}\n请你自己创建（不要发到对话里）：printf '%s' '你的密钥' > ${p} && chmod 600 ${p}`);
  }
  if (!st.isFile()) throw new Error(`API 密钥路径不是普通文件：${p}`);
  if ((st.mode & 0o077) !== 0) {
    console.error(`qq-bot: 警告：${p} 权限是 ${(st.mode & 0o777).toString(8)}，建议 chmod 600`);
  }
  const key = fs.readFileSync(p, "utf8").trim();
  if (!key) throw new Error(`API 密钥文件为空：${p}`);
  if (key.length > 8192) throw new Error(`API 密钥文件异常长：${p}`);
  return key;
}

export function redactedConfig(cfg = loadConfig()) {
  const c = JSON.parse(JSON.stringify(cfg));
  if (c.onebot?.accessToken) c.onebot.accessToken = "***";
  return c;
}
