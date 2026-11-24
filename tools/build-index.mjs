// 从各组件 Release 收集构建清单，合成 App 读的 components.json，并用 ed25519 签名：
//   INDEX_SIGNING_KEY=<PEM> node tools/build-index.mjs [--out DIR] [--devkit ../cccodroid/devkit]
//                                                      [--ci-verified file.json] [--upload]
//
// 产物：components.json + components.json.sig（对 components.json 原始字节的签名，base64）
// App 内置公钥，验签不过整份索引作废 —— 所以索引里的 sha256 可信，包被换了也装不上。
// 只收录仓库里还有配方的组件；每个底座只留最新版本。
//
// 三级验证体系（避免每次重打底座都要人工真机重验全部组件）：
//   1. device（真机直接验证）：verified.json 里对应组件版本 + 底座前 12 位的记录。
//   2. inherited（ABI 兼容继承）：同一版本在老底座上有真机验证，且：
//      · 组件自己的包（名字 + sha256）一模一样；
//      · 它依赖的底座包（baseDeps）在新旧底座之间没有发生 ABI-MAJOR / REMOVED 变化
//        （优先比对 devkit.lock.json 的 abi.sonames，老锁文件退回 abi-policy 共享库/运行时规则；
//        patch/minor/CLI-major 漂移不再一刀切作废验证）；
//      · 它 requires 的其他组件在新底座上也已验证（module:* 由底座提供，不误判）。
//   3. ci-arm64（CI 容器自动验证）：不依赖手机硬件（无 GPU / 屏幕 / Shizuku）的组件，
//      在 ubuntu-24.04-arm + termux-docker:aarch64 真实底座快照里跑通安装 + first-run + selftest，
//      且 gzSha256 与当前资产完全一致。硬件相关组件禁止走 ci-arm64，必须真机验。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { ROOT, REPO, APP_REPO, recipes, bases, run, asset, modelsOf, baseAtLeast } from "./lib.mjs";

// 兜底 ABI 策略（若通过 --devkit 指向了 cccodroid/devkit，会直接读取那里的 abi-policy.json）
const FALLBACK_ABI_POLICY = {
  soProviders: {
    libicu: { scheme: "major" }, openssl: { scheme: "major" }, "libc++": { scheme: "major" },
    libllvm: { scheme: "major" }, clang: { scheme: "major" }, glibc: { scheme: "minor" },
    libxml2: { scheme: "major" }, ffmpeg: { scheme: "major" }, "openjdk-21": { scheme: "major" },
    zlib: { scheme: "major" }, libsqlite: { scheme: "major" }, libcurl: { scheme: "major" },
    libpng: { scheme: "major" }, "libjpeg-turbo": { scheme: "major" }, libwebp: { scheme: "major" },
    libffi: { scheme: "major" }, liblzma: { scheme: "major" }, libzstd: { scheme: "major" },
    libarchive: { scheme: "major" }, glib: { scheme: "major" }, freetype: { scheme: "major" },
    fontconfig: { scheme: "major" }, harfbuzz: { scheme: "major" }, cairo: { scheme: "major" },
    pango: { scheme: "major" }, mesa: { scheme: "major" }, "vulkan-loader": { scheme: "major" },
  },
  runtimeAbi: {
    python: { scheme: "minor" }, nodejs: { scheme: "major" }, perl: { scheme: "minor" }, ruby: { scheme: "minor" },
  },
  cliOnly: ["npm", "git", "openssh", "bash", "coreutils", "curl", "tar", "gzip", "xz-utils", "zstd", "python-pip"],
};

export function isHardwareBound(needs = {}) {
  return !!(needs.gpu === "adreno" || needs.gpu === "mali" || needs.gpu === true || needs.display || needs.shizuku);
}

function parseVer(raw) {
  const s = String(raw || "").trim();
  const epIdx = s.indexOf(":");
  const rest = epIdx >= 0 ? s.slice(epIdx + 1) : s;
  const dashIdx = rest.lastIndexOf("-");
  const upstream = dashIdx > 0 ? rest.slice(0, dashIdx) : rest;
  const nums = (upstream.match(/\d+/g) || []).map(Number);
  return { upstream, nums };
}

function versionDelta(fromRaw, toRaw) {
  if (fromRaw === toRaw) return "same";
  const a = parseVer(fromRaw), b = parseVer(toRaw);
  if (a.upstream === b.upstream) return "patch";
  if ((a.nums[0] ?? 0) !== (b.nums[0] ?? 0)) return "major";
  if ((a.nums[1] ?? 0) !== (b.nums[1] ?? 0)) return "minor";
  return "patch";
}

/**
 * 判断某个底座依赖包从老底座 lockA 到新底座 lockB 是否发生了可能破坏 ABI 的变化。
 * 返回阻断原因字符串，兼容时返回 null。
 */
export function basePkgAbiBreaking(name, lockA, lockB, policy = FALLBACK_ABI_POLICY) {
  const va = lockA.pkgs.get(name), vb = lockB.pkgs.get(name);
  if (va === vb) return null;
  if (!va || !vb) return `${name} ${va || "无"}→${vb || "无"}`;

  // 若新旧锁文件都带有实测 ELF SONAME，优先按 SONAME 是否消失判定
  const snA = lockA.sonames?.[name], snB = lockB.sonames?.[name];
  if (Array.isArray(snA) && Array.isArray(snB)) {
    const setB = new Set(snB);
    const removed = snA.filter((s) => !setB.has(s));
    if (removed.length) return `${name} SONAME 变化（移除 ${removed.join(", ")}）`;
    // 运行时 ABI（python 次版本 / nodejs 主版本）即使 SONAME 不变也会破坏扩展路径，继续核对 runtimeAbi
    if (!policy.runtimeAbi?.[name]) return null;
  }

  const delta = versionDelta(va, vb);
  const rt = policy.runtimeAbi?.[name];
  if (rt) {
    const hit = rt.scheme === "minor" ? (delta === "major" || delta === "minor") : delta === "major";
    return hit ? `${name} 运行时 ABI 升级 ${va}→${vb}` : null;
  }
  const so = policy.soProviders?.[name];
  if (so) {
    const hit = so.scheme === "minor" ? (delta === "major" || delta === "minor") : delta === "major";
    return hit ? `${name} 共享库 ABI 升级 ${va}→${vb}` : null;
  }
  const cli = new Set(policy.cliOnly || []);
  if (cli.has(name)) return null;
  if (/^lib[a-z0-9]/.test(name) && delta === "major") return `${name} 共享库主版本升级 ${va}→${vb}`;
  return null;
}

export const pkgKey = (m) => (m.packages || []).map((p) => p.name + "@" + p.sha256).sort().join("\n");

/** m（新底座上的构建）能否从 a（老底座上真机验过的同版本构建）继承验证；不能就返回原因 */
export function inheritBlockerWithLocks(m, a, lockB, lockA, policy = FALLBACK_ABI_POLICY) {
  if (!Array.isArray(m.baseDeps)) return "构建清单没有 baseDeps";
  if (pkgKey(m) !== pkgKey(a)) return "组件自己的包变了";
  if (!lockB || !lockA) return "底座清单取不到";
  const breaking = [];
  for (const d of m.baseDeps) {
    const why = basePkgAbiBreaking(d.name, lockA, lockB, policy);
    if (why) breaking.push(why);
  }
  return breaking.length ? "依赖的底座包发生 ABI 变化：" + breaking.slice(0, 5).join(", ") : null;
}

/** 合并多份 ci-verified 对象（{ id: { version: { base12: rec } } }） */
export function mergeCiVerified(...sources) {
  const out = {};
  for (const src of sources) {
    if (!src || typeof src !== "object") continue;
    for (const [id, vers] of Object.entries(src)) {
      if (!vers || typeof vers !== "object") continue;
      out[id] = out[id] || {};
      for (const [ver, basesMap] of Object.entries(vers)) {
        if (!basesMap || typeof basesMap !== "object") continue;
        out[id][ver] = out[id][ver] || {};
        for (const [b12, rec] of Object.entries(basesMap)) {
          if (rec && typeof rec === "object") out[id][ver][b12] = rec;
        }
      }
    }
  }
  return out;
}

function loadAbiPolicy(devkitDir) {
  const candidates = [
    devkitDir && path.join(devkitDir, "abi-policy.json"),
    path.join(ROOT, "app", "devkit", "abi-policy.json"),
    path.join(ROOT, "..", "cccodroid", "devkit", "abi-policy.json"),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
    }
  }
  return FALLBACK_ABI_POLICY;
}

function main() {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : undefined; };
  const OUT = path.resolve(opt("out") || path.join(ROOT, "work", "index"));
  const gh = (...a) => run("gh", a);
  const policy = loadAbiPolicy(opt("devkit"));
  const verified = JSON.parse(fs.readFileSync(path.join(ROOT, "verified.json"), "utf8"));
  fs.mkdirSync(OUT, { recursive: true });

  // 读取 CI 自动验证记录：优先命令行传入，否则尝试从 index Release 拉取已有记录
  let ciVerified = {};
  const ciArg = opt("ci-verified");
  if (ciArg && fs.existsSync(ciArg)) {
    ciVerified = JSON.parse(fs.readFileSync(ciArg, "utf8"));
  } else {
    const dlCi = path.join(OUT, "ci-verified.json");
    try {
      gh("release", "download", "index", "-R", REPO, "-p", "ci-verified.json", "-O", dlCi, "--clobber");
      ciVerified = JSON.parse(fs.readFileSync(dlCi, "utf8"));
    } catch {}
  }

  // 底座锁文件缓存：保留 packages 版本映射 + 可选 abi.sonames
  const locks = new Map();
  function baseLock(tag) {
    if (!tag) return null;
    if (locks.has(tag)) return locks.get(tag);
    const d = path.join(OUT, "bases", tag);
    let parsed = null;
    try {
      if (!fs.existsSync(path.join(d, "devkit.lock.json"))) {
        fs.mkdirSync(d, { recursive: true });
        gh("release", "download", tag, "-R", APP_REPO, "-p", "devkit.lock.json", "-D", d, "--clobber");
      }
      const lock = JSON.parse(fs.readFileSync(path.join(d, "devkit.lock.json"), "utf8"));
      parsed = {
        gz: lock.gz?.sha256 || "",
        pkgs: new Map((lock.packages || []).map((p) => [p.name, p.version])),
        sonames: lock.abi?.sonames || null,
      };
    } catch {}
    locks.set(tag, parsed);
    return parsed;
  }

  let baseTagMap = null;
  function tagByBaseGz(gzSha) {
    if (!gzSha) return "";
    if (!baseTagMap) {
      baseTagMap = new Map();
      for (const b of bases()) {
        const lk = baseLock(b.tag);
        if (lk?.gz) baseTagMap.set(lk.gz, b.tag);
      }
    }
    return baseTagMap.get(gzSha) || "";
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
      if (r.minBase) {
        const baseTag = m.base?.tag || tagByBaseGz(m.base?.gz);
        if (!baseTag) {
          console.log(`· ${r.id}: 索引跳过缺 base.tag 的清单（${f}，需 ≥ ${r.minBase}）`);
          continue;
        }
        if (!baseAtLeast(baseTag, r.minBase)) {
          console.log(`· ${r.id}: 索引跳过旧底座清单 ${baseTag}（需 ≥ ${r.minBase}）`);
          continue;
        }
      }
      all.push(m);
      const cur = byBase.get(m.base.gz);
      if (!cur || vcmp(m.version, cur.version) > 0) byBase.set(m.base.gz, { ...m, asset: name + ".tar.gz" });
    }
    if (!byBase.size) continue;
    const hwBound = isHardwareBound(r.needs);
    idx.components[r.id] = {
      name: r.name, desc: r.desc, kind: r.kind || "termux", license: r.license, homepage: r.homepage || "",
      category: r.category || "other",
      ...(r.mcp ? { mcp: { name: r.mcp.name, bin: r.mcp.bin } } : {}),
      maintainers: r.maintainers || [], needs: r.needs || {}, requires: r.requires || [],
      ...((m) => (m.length ? { models: m } : {}))(modelsOf(r).models),
      builds: [...byBase.values()].map((m) => {
        const b12 = m.base.gz.slice(0, 12);
        // 1. 直接真机验证
        const rawDevice = verified[r.id]?.[m.version]?.[b12] || null;
        let v = rawDevice ? { kind: "device", ...rawDevice } : null;
        // 2. ABI 兼容继承（来自老底座的真机验证）
        if (!v) {
          const why = [];
          for (const a of all.filter((x) => x.version === m.version && x.base.gz !== m.base.gz)) {
            const va = verified[r.id]?.[a.version]?.[a.base.gz.slice(0, 12)];
            if (!va || va.inherited) continue;
            const block = inheritBlockerWithLocks(m, a, baseLock(m.base.tag), baseLock(a.base.tag), policy);
            if (!block) {
              v = {
                kind: "inherited",
                ...va,
                inherited: {
                  from: a.base.gz.slice(0, 12),
                  fromTag: a.base.tag || "",
                  why: "component packages are unchanged and baseDeps have no ABI-breaking changes",
                },
              };
              break;
            }
            why.push(`${a.base.gz.slice(0, 12)}：${block}`);
          }
          if (!v && why.length) console.log(`  ${r.id} ${m.version} for ${b12} 不继承验证（${why.join("；")}）`);
        }
        // 3. CI arm64 容器实跑 selftest（硬件依赖组件禁止走这一档）
        if (!v && !hwBound) {
          const ci = ciVerified[r.id]?.[m.version]?.[b12];
          if (ci && ci.gzSha256 === m.gz.sha256) {
            v = { kind: "ci-arm64", ...ci };
          }
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
  // requires 的组件在同一底座上没验证过：继承来的验证不算数（自己直接验或 CI 实跑过的本身已连同依赖跑过）。
  // 跳过 module:<id>：工具包模块由底座发布并随底座验证，不在组件索引里。
  for (let changed = true; changed;) {
    changed = false;
    for (const [id, c] of Object.entries(idx.components)) for (const b of c.builds) {
      if (!b.verified?.inherited) continue;
      const bad = c.requires.filter((d) => !d.startsWith("module:") && !idx.components[d]?.builds.some((x) => x.base === b.base && x.verified));
      if (bad.length) { console.log(`  ${id} ${b.version} for ${b.base.slice(0, 12)} 撤掉继承（依赖 ${bad.join(", ")} 在这个底座上没验证）`); b.verified = null; changed = true; }
    }
  }
  for (const [id, c] of Object.entries(idx.components)) for (const b of c.builds) {
    const tag = b.verified
      ? b.verified.inherited ? ` ✓已验证（ABI继承自 ${b.verified.inherited.from}）`
        : b.verified.kind === "ci-arm64" ? " ✓已验证（CI arm64 selftest）"
          : " ✓已验证（真机）"
      : " （未验证）";
    console.log(`${id} ${b.version} for ${b.base.slice(0, 12)}${tag}`);
  }

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
    const uploadFiles = [jf, jf + ".sig"];
    if (ciArg && fs.existsSync(ciArg)) {
      const ciOut = path.join(OUT, "ci-verified.json");
      if (path.resolve(ciArg) !== path.resolve(ciOut)) fs.copyFileSync(ciArg, ciOut);
      uploadFiles.push(ciOut);
    }
    gh("release", "upload", "index", "-R", REPO, ...uploadFiles, "--clobber");
    console.log("  ↑ 已上传到 index");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
