// 从各组件 Release 收集构建清单，合成 App 读的 components.json，并用 ed25519 签名：
//   INDEX_SIGNING_KEY=<PEM> node tools/build-index.mjs [--out DIR] [--upload]
//
// 产物：components.json + components.json.sig（对 components.json 原始字节的签名，base64）
// App 内置公钥，验签不过整份索引作废 —— 所以索引里的 sha256 可信，包被换了也装不上。
// 只收录仓库里还有配方的组件；每个底座只留最新版本。
//
// 验证继承：换了底座、组件没变的，不用重新真机验证。同一版本在别的底座上验证过，且
//   · 组件自己的包（名字 + sha256）一模一样，
//   · 它依赖链里由底座提供的包（构建清单的 baseDeps）在两个底座里版本都相同，
//   · 它 requires 的组件在新底座上也算验证过，
// 就把那条记录带过来，标上 inherited（从哪个底座、为什么）。旧构建清单没有 baseDeps 的不继承。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ROOT, REPO, APP_REPO, recipes, run, asset, modelsOf } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : undefined; };
const OUT = path.resolve(opt("out") || path.join(ROOT, "work", "index"));
const gh = (...a) => run("gh", a);
const verified = JSON.parse(fs.readFileSync(path.join(ROOT, "verified.json"), "utf8"));
fs.mkdirSync(OUT, { recursive: true });

// 底座的包清单（devkit.lock.json）：按 gz 前 12 位缓存
const locks = new Map();
function baseLock(tag) {
  if (!tag) return null;
  if (locks.has(tag)) return locks.get(tag);
  const d = path.join(OUT, "bases", tag);
  let lock = null;
  try {
    if (!fs.existsSync(path.join(d, "devkit.lock.json"))) { fs.mkdirSync(d, { recursive: true }); gh("release", "download", tag, "-R", APP_REPO, "-p", "devkit.lock.json", "-D", d, "--clobber"); }
    lock = JSON.parse(fs.readFileSync(path.join(d, "devkit.lock.json"), "utf8"));
  } catch {}
  locks.set(tag, lock && new Map(lock.packages.map((p) => [p.name, p.version])));
  return locks.get(tag);
}
const pkgKey = (m) => m.packages.map((p) => p.name + "@" + p.sha256).sort().join("\n");
/** m（新底座上的构建）能不能继承 a（别的底座上验证过的同版本构建）的验证：不能就返回原因 */
function inheritBlocker(m, a) {
  if (!Array.isArray(m.baseDeps)) return "构建清单没有 baseDeps";
  if (pkgKey(m) !== pkgKey(a)) return "组件自己的包变了";
  const lb = baseLock(m.base.tag), la = baseLock(a.base.tag);
  if (!lb || !la) return "底座清单取不到";
  const diff = m.baseDeps.filter((d) => la.get(d.name) !== lb.get(d.name)).map((d) => `${d.name} ${la.get(d.name) || "无"}→${lb.get(d.name)}`);
  return diff.length ? "依赖的底座包变了：" + diff.slice(0, 5).join(", ") : null;
}

const vcmp = (a, b) => a.localeCompare(b, "en", { numeric: true });
const idx = { schema: 1, source: REPO, generated: new Date().toISOString(), components: {} };
for (const r of recipes()) {
  let rel;
  try { rel = JSON.parse(gh("release", "view", r.id, "-R", REPO, "--json", "assets")).assets; } catch { console.log(`· ${r.id}: 还没有发布的构建`); continue; }
  const names = new Set(rel.map((a) => a.name));
  const dl = path.join(OUT, "meta", r.id);
  fs.rmSync(dl, { recursive: true, force: true });
  fs.mkdirSync(dl, { recursive: true });
  gh("release", "download", r.id, "-R", REPO, "-p", "*.json", "-D", dl);
  const byBase = new Map(), all = [];
  for (const f of fs.readdirSync(dl)) {
    const m = JSON.parse(fs.readFileSync(path.join(dl, f), "utf8"));
    const name = asset(m.id, m.version, m.base.gz);
    if (m.id !== r.id || !names.has(name + ".tar.gz")) continue;       // 包没传完的不收
    all.push(m);
    const cur = byBase.get(m.base.gz);
    if (!cur || vcmp(m.version, cur.version) > 0) byBase.set(m.base.gz, { ...m, asset: name + ".tar.gz" });
  }
  if (!byBase.size) continue;
  idx.components[r.id] = {
    name: r.name, desc: r.desc, kind: r.kind || "termux", license: r.license, homepage: r.homepage || "",
    category: r.category || "other",
    ...(r.mcp ? { mcp: { name: r.mcp.name, bin: r.mcp.bin } } : {}),
    maintainers: r.maintainers || [], needs: r.needs || {}, requires: r.requires || [],
    ...((m) => (m.length ? { models: m } : {}))(modelsOf(r).models),
    builds: [...byBase.values()].map((m) => {
      let v = verified[r.id]?.[m.version]?.[m.base.gz.slice(0, 12)] || null;
      if (!v) {
        const why = [];
        for (const a of all.filter((x) => x.version === m.version && x.base.gz !== m.base.gz)) {
          const va = verified[r.id]?.[a.version]?.[a.base.gz.slice(0, 12)];
          if (!va || va.inherited) continue;
          const block = inheritBlocker(m, a);
          if (!block) { v = { ...va, inherited: { from: a.base.gz.slice(0, 12), fromTag: a.base.tag || "", why: "component packages and the base packages it depends on are unchanged" } }; break; }
          why.push(`${a.base.gz.slice(0, 12)}：${block}`);
        }
        if (!v && why.length) console.log(`  ${r.id} ${m.version} for ${m.base.gz.slice(0, 12)} 不继承验证（${why.join("；")}）`);
      }
      return {
        base: m.base.gz, baseTag: m.base.tag || "", version: m.version, upstream: m.upstream,
        url: `https://github.com/${REPO}/releases/download/${encodeURIComponent(r.id)}/${encodeURIComponent(m.asset)}`, asset: m.asset,
        sha256: m.gz.sha256, bytes: m.gz.bytes, installed: m.installed,
        bin: m.bin, skill: m.skill, selftest: m.selftest, packages: m.packages.length,
        // 依赖链里由底座提供的包：cccodroid 0.4.0 起的模块化工具包据此算出组件要先装哪些模块
        baseDeps: (m.baseDeps || []).map((d) => d.name),
        verified: v,
      };
    }),
  };
}
// requires 的组件在同一底座上没验证过：继承来的验证不算数（自己直接验的不受影响）
for (let changed = true; changed;) {
  changed = false;
  for (const [id, c] of Object.entries(idx.components)) for (const b of c.builds) {
    if (!b.verified?.inherited) continue;
    const bad = c.requires.filter((d) => !idx.components[d]?.builds.some((x) => x.base === b.base && x.verified));
    if (bad.length) { console.log(`  ${id} ${b.version} for ${b.base.slice(0, 12)} 撤掉继承（依赖 ${bad.join(", ")} 在这个底座上没验证）`); b.verified = null; changed = true; }
  }
}
for (const [id, c] of Object.entries(idx.components)) for (const b of c.builds)
  console.log(`${id} ${b.version} for ${b.base.slice(0, 12)}${b.verified ? (b.verified.inherited ? ` ✓已验证（继承自 ${b.verified.inherited.from}）` : " ✓已验证") : " （未真机验证）"}`);

const body = Buffer.from(JSON.stringify(idx, null, 1) + "\n");
const jf = path.join(OUT, "components.json");
fs.writeFileSync(jf, body);
const pem = process.env.INDEX_SIGNING_KEY || (process.env.INDEX_SIGNING_KEY_FILE && fs.readFileSync(process.env.INDEX_SIGNING_KEY_FILE, "utf8"));
if (!pem) { console.log("\n⚠ 没有 INDEX_SIGNING_KEY，只出未签名的索引（App 默认不认）"); process.exit(args.includes("--upload") ? 1 : 0); }
const key = crypto.createPrivateKey(pem);
const sig = crypto.sign(null, body, key).toString("base64");
if (!crypto.verify(null, body, crypto.createPublicKey(key), Buffer.from(sig, "base64"))) throw new Error("自验签失败");
fs.writeFileSync(jf + ".sig", sig + "\n");
console.log(`\n✓ ${jf}（${Object.keys(idx.components).length} 个组件，已签名）`);
if (args.includes("--upload")) {
  try { gh("release", "view", "index", "-R", REPO); }
  catch { gh("release", "create", "index", "-R", REPO, "--title", "Component index / 组件索引", "--notes", "App 读这里的 components.json（ed25519 签名在 .sig）。由 CI 自动更新，别手动改。", "--latest=false"); }
  gh("release", "upload", "index", "-R", REPO, jf, jf + ".sig", "--clobber");
  console.log("  ↑ 已上传到 index");
}
