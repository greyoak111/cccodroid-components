// 给每个配方 × 每个底座打组件包，已经发布过的跳过：
//   node tools/ci-build.mjs --devkit <cccodroid 仓库的 devkit 目录> [--only <id>] [--dry] [--no-upload]
//
// 每个组件一个 Release（tag = 组件 id），资产：
//   <id>-<版本>-for-<底座前 12 位>.tar.gz   安装包
//   <id>-<版本>-for-<底座前 12 位>.json     构建清单（版本、包列表、哈希……build-index 读它出索引）
// 「已发布」以资产在不在为准，所以重跑 CI 是安全的；要重打就把 revision 加一。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ROOT, REPO, APP_REPO, recipes, bases, run, asset, baseAtLeast } from "./lib.mjs";

const execFileAsync = promisify(execFile);

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : undefined; };
const DEVKIT = path.resolve(opt("devkit") || "../cccodroid/devkit");
const ONLY = opt("only");
const DRY = args.includes("--dry"), UPLOAD = !args.includes("--no-upload") && !DRY;
const NO_SENTINEL = args.includes("--no-sentinel");
const WORK = path.resolve(process.env.WORK || path.join(ROOT, "work"));
if (!fs.existsSync(path.join(DEVKIT, "devkit.mjs"))) { console.error("找不到 devkit.mjs: " + DEVKIT); process.exit(1); }

const MAN = JSON.parse(fs.readFileSync(path.join(DEVKIT, "devkit.json"), "utf8"));
const BASE_REPOS = MAN.repos || [MAN.repo];
const { TERMUX_KEYS, verifyDetached } = await import(pathToFileURL(path.join(DEVKIT, "pgp.mjs")).href);

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
async function httpGet(url) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(600000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (i >= 5) throw new Error(`${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
}

// 进程内复用 Termux 索引：每个仓库（main / glibc / extraRepos）整次 CI 只拉取、验签、解析一次，
// 避免为每个 配方 × 底座 重复起子进程拉索引；真正打非 --dry 包时仍调原生 devkit.mjs --out。
const repoCache = new Map();
function loadRepoCached(repo) {
  const key = repo.name || repo.base;
  if (repoCache.has(key)) return repoCache.get(key);
  const p = (async () => {
    const { dist, component, arch } = repo;
    let relBuf = null, rel = null, gz = null, lastErr = null;
    for (const base of [repo.base, ...(repo.mirrors || [])]) {
      try {
        const buf = await httpGet(`${base}dists/${dist}/Release`);
        verifyDetached(buf, (await httpGet(`${base}dists/${dist}/Release.gpg`)).toString(), TERMUX_KEYS);
        relBuf = buf; rel = buf.toString();
        const rp = `${component}/binary-${arch}/Packages.gz`;
        const want = rel.split("SHA256:")[1].split("\n").find((l) => l.trim().endsWith(" " + rp));
        if (!want) throw new Error("Release 里没有 " + rp);
        gz = await httpGet(`${base}dists/${dist}/${rp}`);
        if (sha256(gz) !== want.trim().split(/\s+/)[0]) throw new Error("Packages.gz 哈希与 Release 不符");
        break;
      } catch (e) { lastErr = e; }
    }
    if (!relBuf || !rel || !gz) throw new Error(`${repo.name || "repo"}：所有源的 Release 都没过签名校验（最后：${lastErr && lastErr.message}）`);
    const date = (rel.match(/^Date: (.+)$/m) || [])[1];
    const pkgs = new Map(), provides = new Map();
    for (const blk of zlib.gunzipSync(gz).toString().split("\n\n")) {
      const f = {};
      for (const l of blk.split("\n")) { const m = l.match(/^([\w-]+): (.*)$/); if (m) f[m[1]] = m[2]; }
      if (!f.Package) continue;
      const pkg = {
        name: f.Package, version: f.Version, file: f.Filename, sha256: f.SHA256, size: +f.Size,
        isize: +(f["Installed-Size"] || 0) * 1024, source: f.Source || f.Package, homepage: f.Homepage || "",
        deps: [f["Pre-Depends"], f.Depends].filter(Boolean).join(", "),
        repo,
      };
      pkgs.set(pkg.name, pkg);
      for (const v of (f.Provides || "").split(",")) {
        const n = v.trim().split(/[\s(]/)[0];
        if (n) { if (!provides.has(n)) provides.set(n, []); provides.get(n).push(pkg.name); }
      }
    }
    return { pkgs, provides, date };
  })().catch((e) => { repoCache.delete(key); throw e; });
  repoCache.set(key, p);
  return p;
}

const indexCache = new Map();
function loadIndexCached(extraRepoNames = []) {
  const key = extraRepoNames.join(",");
  if (indexCache.has(key)) return indexCache.get(key);
  const p = (async () => {
    const repos = [...BASE_REPOS];
    for (const n of extraRepoNames) {
      if (!MAN.extraRepos || !MAN.extraRepos[n]) throw new Error("不认识的仓库: " + n);
      repos.push(MAN.extraRepos[n]);
    }
    const loaded = await Promise.all(repos.map((repo) => loadRepoCached(repo)));
    const pkgs = new Map(), provides = new Map(), dates = [];
    for (let i = 0; i < repos.length; i++) {
      const one = loaded[i];
      dates.push(`${repos[i].name || "main"} ${one.date}`);
      for (const [k, pkg] of one.pkgs) if (!pkgs.has(k)) pkgs.set(k, pkg);
      for (const [k, v] of one.provides) if (!provides.has(k)) provides.set(k, v);
    }
    return { pkgs, provides, date: dates.join(" · ") };
  })().catch((e) => { indexCache.delete(key); throw e; });
  indexCache.set(key, p);
  return p;
}

function closure(idx, roots, exclude = []) {
  const out = new Set(), missing = [];
  const manEx = MAN.exclude || [];
  const pick = (alt) => {
    for (const a of alt.split("|")) {
      const n = a.trim().split(/[\s(]/)[0];
      if (idx.pkgs.has(n)) return n;
      const pv = idx.provides.get(n);
      if (pv) return pv[0];
    }
    return null;
  };
  const walk = (n, from) => {
    if (out.has(n) || manEx.includes(n) || exclude.includes(n)) return;
    const p = idx.pkgs.get(n);
    if (!p) { missing.push(`${n}（${from}）`); return; }
    out.add(n);
    for (const d of p.deps.split(",")) {
      if (!d.trim()) continue;
      const k = pick(d);
      if (k) walk(k, n); else missing.push(`${d.trim()}（${n}）`);
    }
  };
  for (const r of roots) walk(pick(r) || r, "清单");
  return { names: [...out].sort(), missing };
}

const PIP_URL = /^https:\/\/files\.pythonhosted\.org\/packages\/[0-9a-f/]+\/[A-Za-z0-9_.]+-[A-Za-z0-9_.+!]+-(?:py3|py2\.py3)-none-any\.whl$/;
const ARCHIVE_EXT = [["tar.gz", /\.(tar\.gz|tgz)$/], ["tar.xz", /\.(tar\.xz|txz)$/], ["tar.bz2", /\.(tar\.bz2|tbz2?)$/], ["tar", /\.tar$/], ["zip", /\.zip$/]];
const relOk = (s) => typeof s === "string" && s && !s.startsWith("/") && !s.split("/").includes("..");
function archiveFormat(f, p) {
  const x = f.extract;
  if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error("fetch 的 extract 要写成对象（可以是 {}）: " + p);
  for (const k of Object.keys(x)) if (!["format", "strip", "include", "exec"].includes(k)) throw new Error(`fetch 的 extract 不认 ${k}: ` + p);
  if (x.strip !== undefined && !(Number.isInteger(x.strip) && x.strip >= 0 && x.strip <= 5)) throw new Error("extract.strip 是 0–5 的整数: " + p);
  for (const k of ["include", "exec"]) if (x[k] !== undefined && !(Array.isArray(x[k]) && x[k].length && x[k].every(relOk))) throw new Error(`extract.${k} 要写成相对路径的数组（不许绝对路径、不许 ..）: ` + p);
  const fmt = x.format || (ARCHIVE_EXT.find(([, re]) => re.test(new URL(f.url).pathname)) || [])[0];
  if (!ARCHIVE_EXT.some(([n]) => n === fmt)) throw new Error("认不出压缩格式，写 extract.format（tar.gz / tar.xz / tar.bz2 / tar / zip）: " + p);
  return fmt;
}

// 与 devkit.mjs loadRecipe + component --dry 保持 100% 等价的字段、版本与闭包校验
function validateRecipeForDevkit(r) {
  if (r.schema !== 1) throw new Error("配方 schema 必须是 1");
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(r.id || "")) throw new Error("配方 id 不合法: " + r.id);
  if (!["termux", "glibc"].includes(r.kind || "termux")) throw new Error(`kind "${r.kind}" 还不支持（termux / glibc）`);
  if (!Array.isArray(r.roots) || !r.roots.length) throw new Error("roots 不能为空");
  for (const n of r.repos || []) if (!MAN.extraRepos || !MAN.extraRepos[n]) throw new Error("不认识的仓库: " + n);
  for (const [p, f] of Object.entries(r.files || {})) {
    if (!p.startsWith("usr/") || p.includes("..")) throw new Error("files 只能放进 usr/ 下: " + p);
    if (!f || typeof f.src !== "string" || !f.src || path.isAbsolute(f.src) || f.src.split(/[\\/]/).includes("..")) throw new Error("files 的 src 只能是配方目录里的相对路径: " + p);
  }
  if (r.version !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(r.version)) throw new Error("version 不合法: " + r.version);
  for (const [p, f] of Object.entries(r.fetch || {})) {
    if (!p.startsWith("usr/") || p.includes("..")) throw new Error("fetch 只能放进 usr/ 下: " + p);
    if (f.link !== undefined) {
      if (!/^[A-Za-z0-9._+-]+$/.test(f.link) || f.link === "." || f.link === ".." || f.url || f.sha256) throw new Error("fetch 的 link 只能是同目录的文件名，且不带 url/sha256: " + p);
      continue;
    }
    if (!/^https:\/\/\S+$/.test(f.url || "")) throw new Error("fetch 的 url 必须是 https: " + p);
    if (!/^[0-9a-f]{64}$/.test(f.sha256 || "")) throw new Error("fetch 的 sha256 要写全: " + p);
    if (!f.why) throw new Error("fetch 要写 why: " + p);
    if (f.mode !== undefined && !/^[0-7]{3,4}$/.test(String(f.mode))) throw new Error("fetch 的 mode 是八进制三位/四位: " + p);
    if ((f.extract !== undefined) !== p.endsWith("/")) throw new Error("fetch 解压包的键要以 / 结尾（落地目录），且要写 extract: " + p);
    if (f.extract !== undefined) {
      if (f.mode !== undefined) throw new Error("fetch 解压包不收 mode（权限取包里的，补执行位用 extract.exec）: " + p);
      archiveFormat(f, p);
    }
  }
  if (r.pip !== undefined) {
    if (!r.pip || !r.pip.why || !Array.isArray(r.pip.wheels) || !r.pip.wheels.length) throw new Error("pip 要写成 { why, wheels: [{ url, sha256 }] }");
    for (const w of r.pip.wheels) {
      if (!PIP_URL.test(w.url || "")) throw new Error("pip 的 wheel 只能是 files.pythonhosted.org 上的纯 Python 包（*-none-any.whl）: " + w.url);
      if (!/^[0-9a-f]{64}$/.test(w.sha256 || "")) throw new Error("pip 的 sha256 要写全: " + w.url);
    }
  }
  if (r.npm !== undefined) {
    if (!/^usr\/lib\/[a-z0-9][a-z0-9._-]*$/.test((r.npm && r.npm.dir) || "")) throw new Error("npm.dir 只能是 usr/lib/<名字>");
    if (!r.npm.why) throw new Error("npm 要写 why");
    for (const f of ["package.json", "package-lock.json"]) if (!fs.existsSync(path.join(r.dir, f))) throw new Error("npm 型组件缺 " + f);
  }
}

const recipeResolveCache = new Map();
async function resolveRecipe(r) {
  if (recipeResolveCache.has(r.id)) return recipeResolveCache.get(r.id);
  const res = (async () => {
    validateRecipeForDevkit(r);
    const idx = await loadIndexCached(r.repos || []);
    const { missing } = closure(idx, r.roots, r.exclude || []);
    if (missing.length) throw new Error("配方的依赖有满足不了的: " + missing.join("; "));
    const rootPkg = idx.pkgs.get(r.roots[0]);
    if (!rootPkg) throw new Error("找不到根包: " + r.roots[0]);
    return {
      version: `${r.version || rootPkg.version}-r${r.revision || 1}`,
    };
  })().catch((e) => { recipeResolveCache.delete(r.id); throw e; });
  recipeResolveCache.set(r.id, res);
  return res;
}

async function resolveRecipeVersion(r, lock) {
  if (!Array.isArray(lock?.packages)) throw new Error("底座锁文件缺 packages");
  const { version } = await resolveRecipe(r);
  return version;
}

const gh = (...a) => run("gh", a);
const assetsCache = new Map();
const truncatedTags = new Set();
let assetsPrefetched = false;

async function prefetchReleaseAssets() {
  if (ONLY) return;
  try {
    const { stdout } = await execFileAsync("gh", [
      "api", `repos/${REPO}/releases?per_page=100`,
      "--paginate", "--jq", ".[] | {tag: .tag_name, assets: [.assets[].name]}",
    ], { encoding: "utf8", maxBuffer: 1 << 28 });
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const item = JSON.parse(line);
      if (!item || typeof item.tag !== "string" || !Array.isArray(item.assets)) continue;
      if (item.assets.length >= 100) truncatedTags.add(item.tag);
      else assetsCache.set(item.tag, item.assets);
    }
    assetsPrefetched = true;
  } catch (e) {
    console.log(`⚠ 批量预拉 Release 资产失败，退回逐标签查询：${e.message}`);
  }
}

const assetsOf = (tag) => {
  if (assetsCache.has(tag)) return assetsCache.get(tag);
  if (assetsPrefetched && !truncatedTags.has(tag)) return null;
  let rel;
  try {
    rel = JSON.parse(run("gh", ["api", `repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`], { stdio: ["ignore", "pipe", "pipe"] }));
  } catch (e) {
    const msg = String(e.stderr || e.message || "");
    if (/\b404\b|Not Found/i.test(msg)) { assetsCache.set(tag, null); return null; }
    throw new Error(`查询 Release ${tag} 失败：${msg.split("\n")[0]}`);
  }
  const list = run("gh", ["api", `repos/${REPO}/releases/${rel.id}/assets?per_page=100`, "--paginate", "--jq", ".[].name"], { stdio: ["ignore", "pipe", "pipe"] })
    .split("\n").map((s) => s.trim()).filter(Boolean);
  assetsCache.set(tag, list);
  return list;
};

const allBases = bases();
const allRecipes = recipes();
const activeRecipes = allRecipes.filter((r) => (!ONLY || r.id === ONLY) && !r.skipBuild);

// 启动阶段并行完成：批量预拉 Release 资产 + 缺失底座锁文件 + 预热涉及到的 Termux 仓库索引
const neededExtraRepos = new Set();
for (const r of activeRecipes) for (const n of r.repos || []) if (MAN.extraRepos && MAN.extraRepos[n]) neededExtraRepos.add(n);
const warmRepos = [...BASE_REPOS, ...[...neededExtraRepos].map((n) => MAN.extraRepos[n])];
const missingBases = allBases.filter((b) => !fs.existsSync(path.join(WORK, "bases", b.tag, "devkit.lock.json")));

await Promise.all([
  prefetchReleaseAssets(),
  Promise.all(warmRepos.map((repo) => loadRepoCached(repo).catch(() => {}))),
  (async () => {
    if (!missingBases.length) return;
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(4, missingBases.length) }, async () => {
      while (i < missingBases.length) {
        const b = missingBases[i++];
        const bdir = path.join(WORK, "bases", b.tag);
        fs.mkdirSync(bdir, { recursive: true });
        await execFileAsync("gh", ["release", "download", b.tag, "-R", APP_REPO, "-p", "devkit.lock.json", "-D", bdir, "--clobber"], { encoding: "utf8", maxBuffer: 1 << 26 });
      }
    }));
  })(),
]);

let built = 0, failed = 0, sentinelTarget = null;
for (const b of allBases) {
  const bdir = path.join(WORK, "bases", b.tag);
  const lockFile = path.join(bdir, "devkit.lock.json");
  if (!fs.existsSync(lockFile)) { fs.mkdirSync(bdir, { recursive: true }); gh("release", "download", b.tag, "-R", APP_REPO, "-p", "devkit.lock.json", "-D", bdir, "--clobber"); }
  const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  const baseSha = lock.gz.sha256;
  console.log(`\n══ 底座 ${b.tag}（${baseSha.slice(0, 12)}，${lock.target}）`);
  for (const r of allRecipes) {
    if (ONLY && r.id !== ONLY) continue;
    if (r.skipBuild) { console.log(`· ${r.id}: 跳过构建（${r.skipBuild}）`); continue; }
    if (r.minBase && !baseAtLeast(b.tag, r.minBase)) { console.log(`· ${r.id}: 跳过旧底座 ${b.tag}（需 ≥ ${r.minBase}）`); continue; }
    const dk = (extra) => run("node", [path.join(DEVKIT, "devkit.mjs"), "component", "--recipe", r.dir, "--target", lock.target, "--base", lockFile, ...extra], { stdio: ["ignore", "pipe", "inherit"] });
    let version;
    try { version = await resolveRecipeVersion(r, lock); }
    catch (e) { console.log(`✗ ${r.id}: 依赖解析失败（${e.message}）`); failed++; continue; }
    if (DRY && !NO_SENTINEL && !sentinelTarget) sentinelTarget = { r, tag: b.tag, target: lock.target, lockFile, version };
    const name = asset(r.id, version, baseSha);
    let have;
    try { have = assetsOf(r.id); }
    catch (e) { console.log(`✗ ${r.id}: ${e.message}`); failed++; continue; }
    if (have && have.includes(name + ".tar.gz") && have.includes(name + ".json")) { console.log(`· ${name} 已发布，跳过`); continue; }
    console.log(`▶ ${name}`);
    if (DRY) continue;
    const out = path.join(WORK, "out", r.id, baseSha.slice(0, 12));
    fs.rmSync(out, { recursive: true, force: true });
    try { process.stdout.write(dk(["--out", out])); }
    catch (e) { console.log(`✗ ${r.id}: 构建失败`); failed++; continue; }
    const meta = JSON.parse(fs.readFileSync(path.join(out, `component-${r.id}.json`), "utf8"));
    if (meta.version !== version) {
      console.log(`✗ ${r.id}: 版本复算不一致（ci-build=${version} vs devkit=${meta.version}）`);
      failed++;
      continue;
    }
    const gz = path.join(out, name + ".tar.gz"), js = path.join(out, name + ".json");
    fs.renameSync(path.join(out, meta.gz.file), gz);
    fs.rmSync(path.join(out, meta.tar.file), { force: true });
    meta.base.tag = b.tag;
    meta.recipe = { revision: r.revision, commit: process.env.GITHUB_SHA || "" };
    delete meta.tar; meta.gz.file = path.basename(gz);
    fs.writeFileSync(js, JSON.stringify(meta, null, 1) + "\n");
    built++;
    if (!UPLOAD) continue;
    if (!have) {
      try {
        gh("release", "create", r.id, "-R", REPO, "--title", `${r.id} · ${r.name.en}`, "--notes", `${r.name.zh} / ${r.name.en}\n\n${r.desc.zh}\n\n${r.desc.en}`, "--latest=false");
      } catch (e) {
        if (!/already exists/i.test(String(e.stderr || e.message || ""))) throw e;
      }
    }
    // 先传包再传清单：build-index 只认有清单的构建，半截上传不会进索引
    gh("release", "upload", r.id, "-R", REPO, gz, "--clobber");
    gh("release", "upload", r.id, "-R", REPO, js, "--clobber");
    assetsCache.set(r.id, [...(have || []), path.basename(gz), path.basename(js)]);
    fs.rmSync(gz);
    console.log(`  ↑ 已上传`);
  }
}
if (DRY && !NO_SENTINEL && failed === 0 && sentinelTarget) {
  const { r, tag, target, lockFile, version } = sentinelTarget;
  try {
    const out = run("node", [path.join(DEVKIT, "devkit.mjs"), "component", "--recipe", r.dir, "--target", target, "--base", lockFile, "--dry"], { stdio: ["ignore", "pipe", "pipe"] });
    const nativeVer = /COMPONENT_VERSION=(\S+)/.exec(out)?.[1];
    if (nativeVer !== version) {
      console.log(`\n✗ 原生漂移哨兵不一致（${r.id}@${tag}: ci-build=${version} vs devkit=${nativeVer || "未知"}）`);
      failed++;
    } else {
      console.log(`\n✓ 原生漂移哨兵通过（${r.id}@${tag}: ${version}）`);
    }
  } catch (e) {
    console.log(`\n✗ 原生漂移哨兵执行失败（${r.id}@${tag}）：${e.message}`);
    failed++;
  }
}
console.log(`\n打了 ${built} 个，失败 ${failed} 个`);
if (failed) process.exit(1);
