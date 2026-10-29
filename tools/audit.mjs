// 组件审计（PR 时 CI 跑；本地也能跑）：照正式流程真打一次包（不上传），对产物做静态检查，出一份 Markdown 报告。
//   node tools/audit.mjs --devkit <cccodroid 仓库的 devkit 目录> [--only a,b | --changed <git 基准>] [--out 报告.md] [--base-list 底座文件清单]
//
// 只对 bases.json 里第一个（最新的）底座审。查的东西：
//   · 包清单、体积、和上一版比多了少了什么、和别的组件共用了哪些包
//   · 每个 ELF：是不是 arm64；NEEDED 在「底座 + 本组件 + requires」里找不找得到；解释器在不在
//   · 脚本 shebang 指向的解释器在不在；有没有残留 /data/data/com.termux；配方自带文件里有没有 /tmp
//   · 会不会盖掉底座的文件；bin 入口、selftest 的命令在不在
//   · SKILL.md 里要人看一眼的地方（令牌、管道进 shell、删除/发布、联网下载、提权）
// 然后分级：🟢 看报告即可 / 🟡 要读脚本和 skill / 🔴 要逐行审。有 ❌ 就以非零退出（CI 标红）。
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { ROOT, REPO, APP_REPO, recipes, bases, run } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : undefined; };
const DEVKIT = path.resolve(opt("devkit") || "../cccodroid/devkit");
const WORK = path.resolve(process.env.WORK || path.join(ROOT, "work"));
const TARGET = "cc.codroid", PFX = `/data/data/${TARGET}/files/`;
const all = recipes(), byId = new Map(all.map((r) => [r.id, r]));

// ── 审哪些 ──
let ids;
if (opt("only")) ids = opt("only").split(",");
else if (opt("changed")) {
  const ch = run("git", ["diff", "--name-only", `${opt("changed")}...HEAD`]).split("\n").filter(Boolean);
  // 改了审计本身或打包工具：全审一遍，顺便验证规则没误伤已有组件
  ids = ch.some((f) => f === "tools/audit.mjs" || f === "tools/ci-selftest.mjs" || f === "bases.json") ? all.map((r) => r.id)
    : [...new Set(ch.map((f) => /^recipes\/([^/]+)\//.exec(f)?.[1]).filter((id) => id && byId.has(id)))];
} else ids = all.map((r) => r.id);

// ── 底座 ──
const base = bases()[0];
const bdir = path.join(WORK, "bases", base.tag);
fs.mkdirSync(bdir, { recursive: true });
const lockFile = path.join(bdir, "devkit.lock.json");
if (!fs.existsSync(lockFile)) run("gh", ["release", "download", base.tag, "-R", APP_REPO, "-p", "devkit.lock.json", "-D", bdir, "--clobber"]);
const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
const base12 = lock.gz.sha256.slice(0, 12);
const listFile = opt("base-list") || path.join(bdir, "files.txt");
if (!fs.existsSync(listFile)) {
  console.log(`取底座文件清单（${base.tag}，只列不解）…`);
  const r = spawnSync("sh", ["-c", `gh release download "${base.tag}" -R "${APP_REPO}" -p devkit-${TARGET}.tar.gz -O - | tar -tzf - > "${listFile}.part"`], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("底座文件清单取不到");
  fs.renameSync(listFile + ".part", listFile);
}
const norm = (n) => n.replace(/ -> .*$/, "").replace(/^\.\//, "").replace(/\/$/, "");   // toybox 的 tar -t 会给软链带上 " -> 目标"
const baseNames = new Set(fs.readFileSync(listFile, "utf8").split("\n").filter((l) => l && !l.endsWith("/")).map(norm));

// ── tar：逐条读（pax / GNU 长名都认），大文件只读需要的部分 ──
function* readTar(file) {
  const fd = fs.openSync(file, "r"), h = Buffer.alloc(512);
  let off = 0, pax = {}, long = null, longLink = null;
  const str = (b, s, n) => { const x = b.subarray(s, s + n); const z = x.indexOf(0); return x.subarray(0, z < 0 ? n : z).toString(); };
  try {
    while (fs.readSync(fd, h, 0, 512, off) === 512 && h[0]) {
      const size = parseInt(str(h, 124, 12).trim() || "0", 8), type = String.fromCharCode(h[156] || 48);
      const dataOff = off + 512;
      off = dataOff + Math.ceil(size / 512) * 512;
      const body = () => { const b = Buffer.alloc(size); fs.readSync(fd, b, 0, size, dataOff); return b; };
      if (type === "x") { for (const m of body().toString().matchAll(/\d+ ([^=]+)=([^\n]*)\n/g)) pax[m[1]] = m[2]; continue; }
      if (type === "g") continue;
      if (type === "L") { long = body().toString().replace(/\0.*$/s, ""); continue; }
      if (type === "K") { longLink = body().toString().replace(/\0.*$/s, ""); continue; }
      const prefix = str(h, 345, 155);
      const name = pax.path || long || (prefix ? prefix + "/" : "") + str(h, 0, 100);
      const link = pax.linkpath || longLink || str(h, 157, 100);
      pax = {}; long = longLink = null;
      yield { name: norm(name), type, size, mode: parseInt(str(h, 100, 8).trim() || "0", 8), link,
        head: (n) => { const b = Buffer.alloc(Math.min(n, size)); fs.readSync(fd, b, 0, b.length, dataOff); return b; }, body };
    }
  } finally { fs.closeSync(fd); }
}

// ── ELF：只解析要用的（机器、解释器、NEEDED、RUNPATH） ──
function elfInfo(b) {
  if (b.length < 64 || b.readUInt32BE(0) !== 0x7f454c46) return null;
  if (b[4] !== 2) return { bits: 32, machine: b.readUInt16LE(18) };
  const machine = b.readUInt16LE(18), phoff = Number(b.readBigUInt64LE(32)), phsz = b.readUInt16LE(54), phn = b.readUInt16LE(56);
  const loads = [];
  let interp = null, dyn = null;
  for (let i = 0; i < phn; i++) {
    const o = phoff + i * phsz;
    if (o + 56 > b.length) break;
    const t = b.readUInt32LE(o), off = Number(b.readBigUInt64LE(o + 8)), va = Number(b.readBigUInt64LE(o + 16)), fsz = Number(b.readBigUInt64LE(o + 32));
    if (t === 1) loads.push([va, off, fsz]);
    if (t === 3) interp = b.subarray(off, off + fsz).toString().replace(/\0.*$/s, "");
    if (t === 2) dyn = [off, fsz];
  }
  const out = { bits: 64, machine, interp, needed: [], runpath: [] };
  if (!dyn) return out;
  const ent = [];
  for (let o = dyn[0]; o + 16 <= dyn[0] + dyn[1] && o + 16 <= b.length; o += 16) {
    const tag = Number(b.readBigInt64LE(o)), val = Number(b.readBigUInt64LE(o + 8));
    if (tag === 0) break;
    ent.push([tag, val]);
  }
  const strva = (ent.find(([t]) => t === 5) || [])[1];
  const seg = loads.find(([va, , sz]) => strva >= va && strva < va + sz);
  if (strva === undefined || !seg) return out;
  const stroff = strva - seg[0] + seg[1];
  const s = (v) => { const a = stroff + v, z = b.indexOf(0, a); return b.subarray(a, z < 0 ? b.length : z).toString(); };
  for (const [t, v] of ent) {
    if (t === 1) out.needed.push(s(v));
    if (t === 15 || t === 29) out.runpath.push(...s(v).split(":").filter(Boolean));
  }
  return out;
}
// ELF 头部读多少：程序头和动态段一般在前 1MB 内；不够就整个读
const elfOf = (e) => { let i = elfInfo(e.head(1 << 20)); if (i && i.bits === 64 && i.needed.length === 0 && e.size > 1 << 20) i = elfInfo(e.body()); return i; };

// 安卓系统自带、应用可以直接链的库（NDK 公开库 + 常见的几个）
const ANDROID_LIBS = new Set(["libc.so", "libm.so", "libdl.so", "liblog.so", "libandroid.so", "libz.so", "libEGL.so", "libGLESv1_CM.so",
  "libGLESv2.so", "libGLESv3.so", "libvulkan.so", "libOpenSLES.so", "libjnigraphics.so", "libmediandk.so", "libcamera2ndk.so",
  "libnativewindow.so", "libsync.so", "libneuralnetworks.so", "libOpenMAXAL.so", "libstdc++.so", "libaaudio.so", "libamidi.so",
  "libbinder_ndk.so", "libicu.so", "libvndksupport.so"]);
// 厂商库：只在部分设备的 /vendor 里有（骁龙的 OpenCL 等），链了它的东西只能在那些设备上用 —— 提醒，不拦
const VENDOR_LIBS = new Set(["libOpenCL.so", "libcdsprpc.so", "libQnnHtp.so", "libQnnSystem.so"]);
const SHELL_BUILTINS = new Set(["cd", "echo", "test", "[", "true", "false", "printf", "export", "env", "sh", "bash", "command", "exec", "set"]);

// ── 打包 ──
const built = new Map();
function build(id) {
  if (built.has(id)) return built.get(id);
  const r = byId.get(id), out = path.join(WORK, "audit", id);
  fs.rmSync(out, { recursive: true, force: true });
  let log = "";
  try {
    log = run("node", [path.join(DEVKIT, "devkit.mjs"), "component", "--recipe", r.dir, "--target", TARGET, "--base", lockFile, "--out", out],
      { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { built.set(id, { error: ((e.stdout || "") + (e.stderr || "")).trim().split("\n").slice(-8).join("\n") }); return built.get(id); }
  const meta = JSON.parse(fs.readFileSync(path.join(out, `component-${id}.json`), "utf8"));
  const tar = path.join(out, meta.tar.file);
  const names = new Set(), entries = [], pipPost = [];
  for (const e of readTar(tar)) {
    if (e.type === "5") continue;
    names.add(e.name);
    // 包的 postinst 里现场 pip install 的（如 matplotlib）：装组件时会去 PyPI 拉依赖
    if (e.name.startsWith(`usr/libexec/devkit/components/${id}/postinst/`) && /\bpip3?"?\s+install\b/.test(e.body().toString())) pipPost.push(path.posix.basename(e.name));
    entries.push({ name: e.name, type: e.type, mode: e.mode, size: e.size, link: e.link });
  }
  const res = { meta, tar, names, entries, pipPost, log, drift: (/⚠ 底座与仓库版本不同[^\n]*/.exec(log) || [""])[0] };
  built.set(id, res);
  return res;
}
// 依赖链（requires 的 requires 也算）
function reqClosure(id, seen = new Set()) {
  for (const d of byId.get(id)?.requires || []) if (!seen.has(d)) { seen.add(d); if (byId.has(d)) reqClosure(d, seen); }
  return seen;
}
// 已发布的构建清单（这个底座的）：上一版对比、和别的组件共用包
const published = new Map();
function publishedMeta(id) {
  if (published.has(id)) return published.get(id);
  const d = path.join(WORK, "audit-pub", id);
  fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true });
  try { execFileSync("gh", ["release", "download", id, "-R", REPO, "-p", `*-for-${base12}.json`, "-D", d], { stdio: "ignore" }); } catch {}
  const metas = fs.readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(d, f), "utf8")));
  const m = metas.sort((a, b) => String(b.recipe?.commit || "").localeCompare(String(a.recipe?.commit || "")) || b.version.localeCompare(a.version, undefined, { numeric: true }))[0] || null;
  published.set(id, m);
  return m;
}

const mb = (n) => (n / 1048576).toFixed(1) + " MB";
// /data/data/cc.codroid/files/usr/lib → usr/lib（/data/user/0/ 是同一个地方）
const rel = (p) => p.replace(`/data/user/0/${TARGET}/files/`, PFX).replace(PFX, "");
const ours = (p) => p.startsWith(PFX) || p.startsWith(`/data/user/0/${TARGET}/files/`);
const SKILL_FLAGS = [
  ["🔴", "碰凭据", /gateway-token|gh auth token|\.ssh\/id_|\bapi[_-]?key\b|\bpassword\b|\bsecret\b/i],
  ["🔴", "下载内容直接进 shell", /\b(?:curl|wget)\b[^\n|]*\|\s*(?:ba|z)?sh\b/],
  ["🔴", "提权 / 动系统", /\bpriv\b|shizuku|settings put|\bpm (?:install|uninstall)\b|\bam (?:start|force-stop)\b/i],
  ["🟡", "删除 / 对外发布", /\brm -[a-z]*r[a-z]*f|\bpush --force|\bgh (?:release|repo) (?:create|delete)|\bgh pr merge\b/],
  ["🟡", "联网下载", /\b(?:curl|wget)\b(?![^\n]*\b(?:127\.0\.0\.1|localhost)\b)|\b(?:git clone|pip install|npm install|huggingface-cli|hf download)\b/],
];

let fails = 0;
const targets = [];                                  // 给 ci-selftest.mjs：审了哪些、包在哪、依赖按先后
const tarOf = (id) => built.get(id)?.tar || null;
const report = [`## 组件审计报告`, ``, `底座 \`${base.tag}\`（${base12}）· 规则见 \`tools/audit.mjs\` 开头。🟢 看报告即可 · 🟡 要读脚本和 skill · 🔴 要逐行审`, ``];
for (const id of ids) {
  const r = byId.get(id);
  if (!r) { report.push(`### ❌ ${id}`, "", "仓库里没有这个配方", ""); fails++; continue; }
  console.log(`\n══ ${id}`);
  const b = build(id);
  if (b.error) { report.push(`### ❌ ${id}`, "", "打包失败：", "```", b.error, "```", ""); fails++; continue; }
  const errs = [], warns = [], oks = [], review = [];
  let risk = 0;                                      // 0 🟢 1 🟡 2 🔴
  const bump = (n, why) => { if (n > risk) risk = n; review.push(why); };

  // 依赖组件的文件
  const reqs = [...reqClosure(id)];
  const reqNames = new Set();
  for (const d of reqs) {
    if (!byId.has(d)) { warns.push(`requires 的 \`${d}\` 不在本仓库（预置组件？），它的文件没算进链接检查`); continue; }
    const rb = build(d);
    if (rb.error) { errs.push(`依赖的 \`${d}\` 打包失败`); continue; }
    for (const n of rb.names) reqNames.add(n);
  }
  const has = (n) => b.names.has(n) || baseNames.has(n) || reqNames.has(n);
  const dirOf = (n) => path.posix.dirname(n);
  const anywhere = new Map();                        // 文件名 → 某个路径（找不到时提示"别处有同名"）
  for (const s of [b.names, reqNames, baseNames]) for (const n of s) if (!anywhere.has(path.posix.basename(n))) anywhere.set(path.posix.basename(n), n);

  // 盖底座文件
  const clobber = b.entries.filter((e) => baseNames.has(e.name) && !/^usr\/var\/lib\/dpkg\/info\//.test(e.name)).map((e) => e.name);
  if (clobber.length) errs.push(`会盖掉底座的 ${clobber.length} 个文件：${clobber.slice(0, 5).map((x) => "`" + x + "`").join("、")}`);
  else oks.push("不会盖掉底座的文件");
  const overReq = b.entries.filter((e) => reqNames.has(e.name)).map((e) => e.name);
  if (overReq.length) warns.push(`和依赖组件有 ${overReq.length} 个同路径文件（卸载时谁留谁走要看清）：${overReq.slice(0, 3).join("、")}`);

  // 逐文件：ELF、shebang、残留路径
  const elfGraph = new Map();                        // ELF 路径 → { exe, deps: 解析到本组件里的库路径 }
  const vendor = new Map();
  const missing = new Map(), offPath = new Map(), foreign = [], badInterp = [], upInterp = [], residue = [], badShebang = [], envShebang = [];
  let elfs = 0;
  for (const e of readTar(b.tar)) {
    if (e.type !== "0" && e.type !== "7") continue;
    const head = e.head(4096);
    if (head.length >= 64 && head.readUInt32BE(0) === 0x7f454c46) {
      const info = elfOf(e);
      if (!info) continue;
      elfs++;
      if (info.bits !== 64 || info.machine !== 183) { foreign.push(`${e.name}（${info.bits} 位，机器号 ${info.machine}）`); continue; }
      const glibc = /\/glibc\//.test(info.interp || "") || e.name.startsWith("usr/glibc/");
      // 上游的 glibc 程序（fetch 解包进 usr/glibc/opt/）：解释器写死 /lib/ld-linux-aarch64.so.1，安卓上没有，
      // 只能由包装脚本经 $PREFIX/glibc/lib/ld-linux-aarch64.so.1 启动 —— 放在这里且是这个路径的只提醒，别处的照常拦
      const upstream = e.name.startsWith("usr/glibc/opt/") && info.interp === "/lib/ld-linux-aarch64.so.1";
      if (info.interp && info.interp !== "/system/bin/linker64" && !has(rel(info.interp))) (upstream ? upInterp : badInterp).push(`${e.name} → ${info.interp}`);
      const dirs = [...info.runpath.map((p) => rel(p.replace(/\$\{?ORIGIN\}?/g, PFX + dirOf(e.name)))),
        glibc ? "usr/glibc/lib" : "usr/lib", dirOf(e.name)].map((p) => path.posix.normalize(p.replace(/^\//, "")));
      const node = { exe: !!info.interp, deps: [] };
      elfGraph.set(e.name, node);
      for (const n of info.needed) {
        if (!glibc && ANDROID_LIBS.has(n)) continue;
        const hit = dirs.find((d) => has(d + "/" + n));
        if (hit) { if (b.names.has(hit + "/" + n)) node.deps.push(hit + "/" + n); continue; }
        if (!glibc && VENDOR_LIBS.has(n)) { vendor.set(n, [...(vendor.get(n) || []), e.name]); continue; }
        (anywhere.has(n) ? offPath : missing).set(n, [...((anywhere.has(n) ? offPath : missing).get(n) || []), e.name]);
      }
    } else if (head[0] === 0x23 && head[1] === 0x21 && e.mode & 0o111) {
      const interp = head.toString("latin1", 2, 200).split("\n")[0].trim().split(/\s+/)[0];
      if (ours(interp)) { if (!has(rel(interp))) badShebang.push(`${e.name} → ${interp}`); }
      else if (!interp.startsWith("/system/")) envShebang.push(`${e.name} → ${interp}`);
    }
    // 残留的 Termux 前缀：devkit 会等长改写，还剩的多半是 fetch / 配方自带文件带进来的
    if (e.size < 256 << 20) { const all = e.size <= 4096 ? head : e.body(); if (all.includes("/data/data/com.termux/")) residue.push(e.name); }
  }
  oks.push(`${elfs} 个 ELF 检查过`);
  // 分轻重：bin 入口、库（lib 目录下的）坏了才拦；包里附带的其它程序、share 里的脚本坏了只提醒（多是上游打包的边角）
  const entry = new Set((r.bin || []).map((c) => "usr/bin/" + c));
  // 要紧的 ELF：从「入口命令、bin 目录外的可执行程序、lib 顶层的库」出发，沿 NEEDED 走得到的。
  // 没人链接、只靠 dlopen 加载的插件（如 libreoffice 的 Qt6 / gstreamer 界面与媒体插件）缺库只提醒：用到那个功能才会坏
  const isBin = (f) => /^usr\/(glibc\/)?bin\//.test(f);
  const byName = new Map(b.entries.map((y) => [y.name, y]));
  const resolve = (f) => { let x = f; for (let i = 0; i < 8; i++) { const en = byName.get(x); if (!en || en.type !== "2") break; x = path.posix.normalize(en.link.startsWith("/") ? rel(en.link) : path.posix.join(path.posix.dirname(x), en.link)); } return x; };
  const roots = [...entry].map(resolve).filter((f) => elfGraph.has(f));
  for (const [f, nd] of elfGraph) if ((nd.exe && !isBin(f)) || /^usr\/(glibc\/)?lib\/[^/]+$/.test(f)) roots.push(f);
  const reach = new Set();
  for (const q = [...roots]; q.length;) { const f = q.pop(); if (reach.has(f)) continue; reach.add(f); for (const d of elfGraph.get(resolve(f))?.deps || []) q.push(resolve(d)); }
  const vital = (f) => reach.has(f) || entry.has(f);
  const split = (m) => { const hard = new Map(), soft = new Map(); for (const [n, by] of m) { const v = by.filter(vital); (v.length ? hard : soft).set(n, v.length ? v : by); } return [hard, soft]; };
  const [missHard, missSoft] = split(missing);
  const shHard = badShebang.filter((x) => vital(x.split(" → ")[0])), shSoft = badShebang.filter((x) => !vital(x.split(" → ")[0]));
  if (foreign.length) (foreign.some((f) => /^usr\/(bin|lib|glibc\/(bin|lib))\//.test(f)) ? errs : warns).push(`不是 arm64 的 ELF ${foreign.length} 个：${foreign.slice(0, 3).join("、")}`);
  if (upInterp.length) warns.push(`${upInterp.length} 个上游 glibc 程序的解释器是 /lib/ld-linux-aarch64.so.1（安卓上没有）：包装脚本必须经 $PREFIX/glibc/lib/ld-linux-aarch64.so.1 启动，如 ${upInterp[0]}`);
  if (badInterp.length) errs.push(`解释器（动态链接器）找不到：${badInterp.slice(0, 3).join("、")}`);
  if (missSoft.size) warns.push(`包里附带的程序有 ${missSoft.size} 个库找不到（不是入口，不拦）：` + [...missSoft].slice(0, 4).map(([n, by]) => `\`${n}\` ← ${by[0]}`).join("、"));
  if (vendor.size) warns.push(`链了设备厂商的库（只有部分设备有，没有的设备上这部分用不了）：` + [...vendor].map(([n, by]) => `\`${n}\` ← ${by[0]}`).join("、"));
  if (missHard.size) errs.push(`链接的库哪里都找不到 ${missHard.size} 个：` + [...missHard].slice(0, 6).map(([n, by]) => `\`${n}\`（${by.length} 个文件要，如 ${by[0]}）`).join("、"));
  else oks.push(missSoft.size ? "入口命令和库要的库都找得到" : "每个 ELF 要的库都找得到");
  if (offPath.size) warns.push(`有库不在搜索路径上、但别处有同名文件（可能靠包装脚本设 LD_LIBRARY_PATH，真机要验）：` + [...offPath].slice(0, 4).map(([n, by]) => `\`${n}\` ← ${by[0]}（有 ${anywhere.get(n)}）`).join("、"));
  if (shHard.length) errs.push(`脚本的解释器不存在：${shHard.slice(0, 3).join("、")}`);
  if (shSoft.length) warns.push(`附带脚本的解释器不存在（不是入口，不拦）：${shSoft.slice(0, 3).join("、")}`);
  if (envShebang.length) warns.push(`${envShebang.length} 个脚本的 shebang 不在本应用前缀下（靠 termux-exec 改写）：${envShebang.slice(0, 2).join("、")}`);
  if (residue.length) errs.push(`残留 /data/data/com.termux 路径：${residue.slice(0, 3).join("、")}`);

  // 入口与自测
  for (const c of r.bin || []) if (!has("usr/bin/" + c)) errs.push(`bin 入口 \`${c}\` 不在 usr/bin`);
  const st = (r.selftest || "").trim().split(/\s+/).find((w) => !/^[A-Z_][A-Z0-9_]*=/.test(w));
  if (st && !SHELL_BUILTINS.has(st) && !has("usr/bin/" + st) && !(ours(st) && has(rel(st)))) errs.push(`selftest 的命令 \`${st}\` 找不到`);
  else oks.push("bin 入口与 selftest 命令都在");

  // 配方自带的文件里写 /tmp（安卓上应用写不进）
  for (const [p, f] of Object.entries(r.files || {})) {
    const t = fs.readFileSync(path.join(r.dir, f.src), "utf8");
    if (/(^|[\s"'=:(])\/tmp(\/|\b)/m.test(t)) warns.push(`\`${f.src}\` 用了 /tmp（应用写不进，用 $TMPDIR）`);
  }

  // skill 要人看的地方
  const skp = path.join(r.dir, "skill", "SKILL.md");
  const sk = fs.existsSync(skp) ? fs.readFileSync(skp, "utf8").split("\n") : [];
  if (sk.some((l) => /(^|[\s"'=:(`])\/tmp(\/|\b)/.test(l))) warns.push("SKILL.md 让 Claude 用 /tmp（应用写不进，用 $TMPDIR）");
  for (const [lvl, what, re] of SKILL_FLAGS) {
    const hits = sk.map((l, i) => [i + 1, l]).filter(([, l]) => re.test(l));
    if (hits.length) bump(lvl === "🔴" ? 2 : 1, `${lvl} SKILL.md ${what}：` + hits.slice(0, 3).map(([n, l]) => `L${n} \`${l.trim().slice(0, 80).replace(/`/g, "'")}\``).join("；"));
  }

  // 分级
  if (Object.values(r.fetch || {}).some((f) => f.url)) bump(2, `🔴 fetch 了仓库外的文件：${Object.entries(r.fetch).filter(([, f]) => f.url).map(([p, f]) => `${path.posix.basename(p)} ← ${new URL(f.url).host}`).join("、")}（哈希打包时已核对）`);
  if (r.needs?.shizuku) bump(2, "🔴 needs.shizuku：要提权");
  const scripts = Object.keys(r.files || {}).filter((p) => !p.includes("/components/" + id + "/skill/"));
  if (scripts.length) bump(1, `🟡 配方自带文件 ${scripts.length} 个：${scripts.map((p) => "`" + p + "`").join("、")}`);
  if (r.needs?.display || r.needs?.gpu) bump(1, `🟡 needs ${Object.entries(r.needs).filter(([, v]) => v).map(([k, v]) => k + "=" + v).join(" ")}：真机才测得出`);
  if (reqs.length) bump(1, `🟡 依赖组件：${reqs.join("、")}`);
  if ((r.repos || []).length) bump(1, `🟡 用了额外仓库：${r.repos.join("、")}`);
  const post = b.entries.filter((e) => e.name.startsWith(`usr/libexec/devkit/components/${id}/postinst/`)).map((e) => path.posix.basename(e.name));
  if (post.length) bump(1, `🟡 装完要跑包的 postinst：${post.join("、")}`);
  if ((r.pip?.wheels || []).length) bump(1, `🟡 带了 PyPI 的纯 Python 包 ${r.pip.wheels.length} 个：${r.pip.wheels.map((w) => decodeURIComponent(w.url.split("/").pop()).split("-").slice(0, 2).join(" ")).join("、")}（哈希打包时已核对）`);
  if (b.pipPost.length) (r.pip ? oks : warns).push(`postinst 里会 pip install：${b.pipPost.join("、")}${r.pip ? "（配方的 pip 已带依赖，CI 自检用 PIP_NO_INDEX=1 跑首次运行，缺了会失败）" : " —— 装组件时会去 PyPI 现场拉依赖（版本不定、离线装坏、卸载删不掉）；把缺的纯 Python 依赖写进配方的 pip"}`);

  // 体积、包、对比
  const m = b.meta, pk = m.packages;
  const prev = publishedMeta(id);
  let delta = "（第一次发布）";
  if (prev && prev.version === m.version) delta = `（与已发布的 ${prev.version} 同版本：合进去不会重新打包，要发新版得改 revision）`;
  else if (prev) {
    const pv = new Map(prev.packages.map((p) => [p.name, p.version])), nv = new Map(pk.map((p) => [p.name, p.version]));
    const add = pk.filter((p) => !pv.has(p.name)).map((p) => p.name), del = prev.packages.filter((p) => !nv.has(p.name)).map((p) => p.name);
    const chg = pk.filter((p) => pv.has(p.name) && pv.get(p.name) !== p.version).map((p) => `${p.name} ${pv.get(p.name)}→${p.version}`);
    delta = `对比已发布 ${prev.version}：装后 ${mb(prev.installed)} → ${mb(m.installed)}` +
      (add.length ? `；新增 ${add.join(", ")}` : "") + (del.length ? `；去掉 ${del.join(", ")}` : "") + (chg.length ? `；升级 ${chg.slice(0, 8).join(", ")}` : "");
  }
  const mine = new Set(pk.map((p) => p.name)), shared = [];
  for (const o of all) {
    if (o.id === id || reqs.includes(o.id)) continue;
    const om = (built.get(o.id) && !built.get(o.id).error ? built.get(o.id).meta : null) || publishedMeta(o.id);
    const s = om ? om.packages.filter((p) => mine.has(p.name)).map((p) => p.name) : [];
    if (s.length) shared.push(`${o.id}：${s.join(", ")}`);
  }
  if (b.drift) warns.push(b.drift.replace(/^⚠ /, ""));

  if (errs.length) fails++;
  const icon = errs.length ? "❌" : ["🟢", "🟡", "🔴"][risk];
  report.push(`### ${icon} ${id} ${m.version}`, "",
    `下载 ${mb(m.gz.bytes)} · 装后 ${mb(m.installed)} · ${m.files} 个文件 · ${pk.length} 个包 ${delta}`, "",
    ...errs.map((x) => "- ❌ " + x), ...warns.map((x) => "- ⚠️ " + x), ...oks.map((x) => "- ✅ " + x), "",
    review.length ? "**人要看的：**\n\n" + review.map((x) => "- " + x).join("\n") : "**人要看的：** 无（纯官方仓库的包，读一遍 skill 即可）", "",
    `和别的组件共用的包：${shared.length ? shared.join("；") : "无"}`, "",
    `<details><summary>包清单</summary>\n\n| 包 | 版本 | 下载 |\n|---|---|---|\n` + pk.map((p) => `| ${p.name} | ${p.version} | ${mb(p.size)} |`).join("\n") + "\n\n</details>", "");
  console.log(`${icon} ${id}：${errs.length} 错 ${warns.length} 警告`);
  targets.push({ id, version: m.version, ok: !errs.length, tar: b.tar, selftest: r.selftest || "", needs: r.needs || {},
    deps: [...reqs].reverse().filter((d) => byId.has(d)).map((d) => ({ id: d, tar: tarOf(d) })) });
}
if (!ids.length) report.push("这次没有改动配方，没审什么。");
fs.mkdirSync(path.join(WORK, "audit"), { recursive: true });
fs.writeFileSync(path.join(WORK, "audit", "targets.json"), JSON.stringify(targets, null, 1));
let text = report.join("\n");
if (text.length > 60000) text = text.slice(0, 60000) + "\n\n…（太长截断了，完整的看 CI 的 Summary）";
if (opt("out")) fs.writeFileSync(opt("out"), text + "\n");
else console.log("\n" + text);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report.join("\n") + "\n");
process.exit(fails ? 1 : 0);
