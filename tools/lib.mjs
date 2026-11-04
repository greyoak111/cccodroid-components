// 共用的小工具：读配方、读底座、跑命令
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
export const REPO = process.env.GITHUB_REPOSITORY || "greyoak111/cccodroid-components";
export const APP_REPO = "greyoak111/cccodroid";

export function recipes() {
  const dir = path.join(ROOT, "recipes");
  return fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, "recipe.json")))
    .map((d) => ({ dir: path.join(dir, d), ...JSON.parse(fs.readFileSync(path.join(dir, d, "recipe.json"), "utf8")) }));
}
export const bases = () => JSON.parse(fs.readFileSync(path.join(ROOT, "bases.json"), "utf8")).bases;
export const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28, ...opts });
// 版本号里的 : ~ + 之类 GitHub 资产名会改掉，统一换成 _
export const asset = (id, version, baseSha) => `${id}-${String(version).replace(/[^A-Za-z0-9._-]/g, "_")}-for-${baseSha.slice(0, 12)}`;
// 可选的最低宿主能力。旧包不带标记；显式声明目前只接受这一种精确 schema，不能把未知能力静默丢掉。
export function hostApiOf(meta) {
  if (!Object.hasOwn(meta, "hostApi")) return undefined;
  const h = meta.hostApi;
  if (!h || typeof h !== "object" || Array.isArray(h) || Object.keys(h).length !== 1
    || !Object.hasOwn(h, "remoteSession") || h.remoteSession !== 1)
    throw new Error('hostApi 省略或严格写成 { "remoteSession": 1 }（不接受空对象、未知能力或其它版本）');
  return { remoteSession: 1 };
}
// 组件附带的模型目录（目前只有 llama-cpp 用）：recipes/<id>/models.json，进签名索引，App 的「下载模型」按它列。
// 索引签了名，sha256 就可信；repo / file 严格限字符，App 拿它们拼下载地址（魔搭 / HF / hf-mirror），不许塞路径或别的站。
export const MODEL_TAGS = new Set(["think", "code"]);
export function modelsOf(r) {
  const f = path.join(r.dir, "models.json");
  if (!fs.existsSync(f)) return { models: [], errors: [] };
  const errors = [], models = [], seen = new Set();
  let list;
  try { list = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return { models: [], errors: ["models.json 不是合法 JSON：" + e.message] }; }
  if (!Array.isArray(list)) return { models: [], errors: ["models.json 必须是数组"] };
  if (list.length > 100) errors.push("models.json 最多 100 条");
  list.slice(0, 100).forEach((m, i) => {
    const at = `models[${i}]`;
    const bad = (why) => errors.push(`${at}: ${why}`);
    if (!m || typeof m !== "object") return bad("不是对象");
    const extra = Object.keys(m).filter((k) => !["fam", "params", "repo", "file", "bytes", "sha256", "tag", "ms"].includes(k));
    if (extra.length) bad("不认识的字段 " + extra.join(","));
    if (typeof m.fam !== "string" || !/^[\w .+-]{1,40}$/.test(m.fam)) bad("fam 只能是 1–40 个字母数字空格 . + -");
    if (typeof m.params !== "number" || !(m.params > 0 && m.params < 1000)) bad("params 是参数量（十亿），0–1000");
    if (typeof m.repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(m.repo)) bad("repo 必须是 <组织>/<仓库>");
    if (typeof m.file !== "string" || !/^[A-Za-z0-9_.-]+\.gguf$/i.test(m.file)) bad("file 必须是不带路径的 .gguf 文件名");
    if (!Number.isInteger(m.bytes) || m.bytes <= 0) bad("bytes 必须是正整数");
    if (typeof m.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.sha256)) bad("sha256 必须是 64 位小写十六进制");
    if (m.tag !== undefined && !MODEL_TAGS.has(m.tag)) bad("tag 只能是 " + [...MODEL_TAGS].join(" / "));
    if (m.ms !== undefined && m.ms !== 1) bad("ms（魔搭上也有）只能写 1");
    if (seen.has(m.file)) bad("file 重复"); seen.add(m.file);
    models.push(m);
  });
  return { models: errors.length ? [] : models, errors };
}
