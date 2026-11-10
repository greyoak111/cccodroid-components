// 给每个配方 × 每个底座打组件包，已经发布过的跳过：
//   node tools/ci-build.mjs --devkit <cccodroid 仓库的 devkit 目录> [--only <id>] [--dry] [--no-upload]
//
// 每个组件一个 Release（tag = 组件 id），资产：
//   <id>-<版本>-for-<底座前 12 位>.tar.gz   安装包
//   <id>-<版本>-for-<底座前 12 位>.json     构建清单（版本、包列表、哈希……build-index 读它出索引）
// 「已发布」以资产在不在为准，所以重跑 CI 是安全的；要重打就把 revision 加一。
import fs from "node:fs";
import path from "node:path";
import { ROOT, REPO, APP_REPO, recipes, bases, run, asset, hostApiOf } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : undefined; };
const DEVKIT = path.resolve(opt("devkit") || "../cccodroid/devkit");
const DRY = args.includes("--dry"), UPLOAD = !args.includes("--no-upload") && !DRY;
const WORK = path.resolve(process.env.WORK || path.join(ROOT, "work"));
if (!fs.existsSync(path.join(DEVKIT, "devkit.mjs"))) { console.error("找不到 devkit.mjs: " + DEVKIT); process.exit(1); }

const gh = (...a) => run("gh", a);
const assetsOf = (tag) => { try { return JSON.parse(run("gh", ["release", "view", tag, "-R", REPO, "--json", "assets"], { stdio: ["ignore", "pipe", "ignore"] })).assets.map((a) => a.name); } catch { return null; } };

let built = 0, failed = 0;
for (const b of bases()) {
  const bdir = path.join(WORK, "bases", b.tag);
  const lockFile = path.join(bdir, "devkit.lock.json");
  if (!fs.existsSync(lockFile)) { fs.mkdirSync(bdir, { recursive: true }); gh("release", "download", b.tag, "-R", APP_REPO, "-p", "devkit.lock.json", "-D", bdir, "--clobber"); }
  const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  const baseSha = lock.gz.sha256;
  console.log(`\n══ 底座 ${b.tag}（${baseSha.slice(0, 12)}，${lock.target}）`);
  for (const r of recipes()) {
    if (opt("only") && r.id !== opt("only")) continue;
    let hostApi;
    try { hostApi = hostApiOf(r); }
    catch (e) { console.log(`✗ ${r.id}: ${e.message}`); failed++; continue; }
    const dk = (extra) => run("node", [path.join(DEVKIT, "devkit.mjs"), "component", "--recipe", r.dir, "--target", lock.target, "--base", lockFile, ...extra], { stdio: ["ignore", "pipe", "inherit"] });
    let version;
    try { version = /COMPONENT_VERSION=(\S+)/.exec(dk(["--dry"]))[1]; }
    catch (e) { console.log(`✗ ${r.id}: 依赖解析失败`); failed++; continue; }
    const name = asset(r.id, version, baseSha);
    const have = assetsOf(r.id);
    if (have && have.includes(name + ".tar.gz") && have.includes(name + ".json")) { console.log(`· ${name} 已发布，跳过`); continue; }
    console.log(`▶ ${name}`);
    if (DRY) continue;
    const out = path.join(WORK, "out", r.id, baseSha.slice(0, 12));
    fs.rmSync(out, { recursive: true, force: true });
    let meta;
    try {
      process.stdout.write(dk(["--out", out]));
      meta = JSON.parse(fs.readFileSync(path.join(out, `component-${r.id}.json`), "utf8"));
      // 只验证本次生成的侧车，不从配方补写。旧 devkit 丢了能力声明时必须停止，不能发布未标记的新包。
      if (JSON.stringify(hostApiOf(meta)) !== JSON.stringify(hostApi))
        throw new Error("构建清单的 hostApi 与配方不一致；请使用支持 hostApi 的 devkit");
    } catch (e) { console.log(`✗ ${r.id}: 构建失败（${e.message}）`); failed++; continue; }
    const gz = path.join(out, name + ".tar.gz"), js = path.join(out, name + ".json");
    fs.renameSync(path.join(out, meta.gz.file), gz);
    fs.rmSync(path.join(out, meta.tar.file), { force: true });
    meta.base.tag = b.tag;
    meta.recipe = { revision: r.revision, commit: process.env.GITHUB_SHA || "" };
    delete meta.tar; meta.gz.file = path.basename(gz);
    fs.writeFileSync(js, JSON.stringify(meta, null, 1) + "\n");
    built++;
    if (!UPLOAD) continue;
    if (!have) gh("release", "create", r.id, "-R", REPO, "--title", `${r.id} · ${r.name.en}`, "--notes", `${r.name.zh} / ${r.name.en}\n\n${r.desc.zh}\n\n${r.desc.en}`, "--latest=false");
    // 先传包再传清单：build-index 只认有清单的构建，半截上传不会进索引
    gh("release", "upload", r.id, "-R", REPO, gz, "--clobber");
    gh("release", "upload", r.id, "-R", REPO, js, "--clobber");
    fs.rmSync(gz);
    console.log(`  ↑ 已上传`);
  }
}
console.log(`\n打了 ${built} 个，失败 ${failed} 个`);
if (failed) process.exit(1);
