// 离线元数据回归：只在临时目录运行真实市场 CLI，gh / devkit 都是严格本地夹具。
// 不下载、不签名、不上传、不调用宿主，也不运行组件 selftest 或生成真机 verified 记录。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { asset, hostApiOf, modelsOf, recipes } from "../tools/lib.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const BASE = "a".repeat(64), NEXT_BASE = "b".repeat(64), TAG = "offline-base";
const REPO = "offline-fixture/metadata-test";
const writeJSON = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
};
const invalidHostApis = [
  ["null", null], ["false", false], ["true", true], ["number", 1], ["string", "remoteSession"],
  ["array", []], ["array with entry", [{ remoteSession: 1 }]], ["empty object", {}],
  ["string version", { remoteSession: "1" }], ["boolean version", { remoteSession: true }],
  ["null version", { remoteSession: null }], ["zero version", { remoteSession: 0 }],
  ["future version", { remoteSession: 2 }], ["negative version", { remoteSession: -1 }],
  ["fractional version", { remoteSession: 1.5 }], ["unknown capability", { another: 1 }],
  ["wrong case", { RemoteSession: 1 }], ["extra capability", { remoteSession: 1, another: 1 }],
];

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-market-host-api-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin"), work = path.join(root, "work"), devkit = path.join(root, "devkit");
  for (const dir of [bin, devkit, path.join(root, "tools"), path.join(root, "recipes"), path.join(root, "home")]) fs.mkdirSync(dir, { recursive: true });
  for (const file of ["lib.mjs", "check-recipes.mjs", "ci-build.mjs", "build-index.mjs"]) fs.copyFileSync(path.join(ROOT, "tools", file), path.join(root, "tools", file));
  writeJSON(path.join(root, "bases.json"), { bases: [{ tag: TAG }] });
  writeJSON(path.join(work, "bases", TAG, "devkit.lock.json"), { target: "cc.codroid", gz: { sha256: BASE }, packages: [] });
  writeJSON(path.join(root, "verified.json"), {});
  fs.writeFileSync(path.join(bin, "gh"), "#!" + process.execPath + "\n" + String.raw`
import fs from "node:fs";
import path from "node:path";
const root = process.env.FIXTURE_ROOT, args = process.argv.slice(2);
fs.appendFileSync(path.join(root, "gh-calls.jsonl"), JSON.stringify(args) + "\n");
const rel = path.join(root, "releases", args[2] || "");
if (args[0] === "release" && args[1] === "view" && args.includes("--json")) {
  process.stdout.write(JSON.stringify({ assets: fs.readdirSync(rel).map((name) => ({ name })) }));
} else if (args[0] === "release" && args[1] === "download" && args[args.indexOf("-p") + 1] === "*.json") {
  const dest = args[args.indexOf("-D") + 1];
  for (const file of fs.readdirSync(rel).filter((name) => name.endsWith(".json"))) fs.copyFileSync(path.join(rel, file), path.join(dest, file));
} else throw new Error("Offline gh fixture refuses this operation: " + args.join(" "));
`, { mode: 0o755 });
  fs.writeFileSync(path.join(devkit, "devkit.mjs"), String.raw`
// Sidecar contract fixture, NOT a real component build or a selftest result.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
const args = process.argv.slice(2), opt = (key) => args[args.indexOf("--" + key) + 1];
if (args[0] !== "component") throw new Error("Not a component invocation");
const r = JSON.parse(fs.readFileSync(path.join(opt("recipe"), "recipe.json"), "utf8"));
const version = (r.version || "1.0.0") + "-r" + r.revision;
if (args.includes("--dry")) { process.stdout.write("COMPONENT_VERSION=" + version + "\n"); process.exit(0); }
const out = opt("out"), base = JSON.parse(fs.readFileSync(opt("base"), "utf8"));
const data = Buffer.from("Offline metadata fixture only; not a component archive\n"), gz = gzipSync(data);
const info = (file, bytes) => ({ file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
fs.mkdirSync(out, { recursive: true });
const meta = { id: r.id, version, upstream: r.version || "1.0.0", target: base.target, compat: 1,
  base: { snapshot: "offline", gz: base.gz.sha256 }, bin: r.bin, skill: "", selftest: r.selftest,
  name: r.name, desc: r.desc, kind: r.kind, needs: {}, license: r.license,
  tar: info("component-fixture.tar", data), gz: info("component-fixture.tar.gz", gz), installed: data.length,
  packages: [], baseDeps: [{ name: "nodejs", version: "22" }] };
if (Object.hasOwn(r, "hostApi")) meta.hostApi = r.hostApi;
let mode = {}; try { mode = JSON.parse(fs.readFileSync(path.join(process.env.FIXTURE_ROOT, "devkit-mode.json"), "utf8")); } catch {}
if (mode.drop) delete meta.hostApi;
if (Object.hasOwn(mode, "override")) meta.hostApi = mode.override;
fs.writeFileSync(path.join(out, meta.tar.file), data);
fs.writeFileSync(path.join(out, meta.gz.file), gz);
fs.writeFileSync(path.join(out, "component-" + r.id + ".json"), JSON.stringify(meta));
`);
  // Deliberately do not inherit credentials, signing keys, NODE_OPTIONS or gateway settings.
  const env = { PATH: bin + path.delimiter + path.dirname(process.execPath), HOME: path.join(root, "home"), TMPDIR: root,
    WORK: work, FIXTURE_ROOT: root, GITHUB_REPOSITORY: REPO };
  for (const key of ["LD_LIBRARY_PATH", "LD_PRELOAD", "ANDROID_ROOT", "ANDROID_DATA"]) if (process.env[key]) env[key] = process.env[key];
  return { root, work, devkit, env };
}
function recipe(f, changes = {}) {
  const r = { schema: 1, id: "fixture", kind: "termux", revision: 1, version: "1.0.0",
    name: { zh: "离线夹具", en: "Offline fixture" }, desc: { zh: "仅供元数据测试", en: "Metadata tests only" },
    roots: ["nodejs"], bin: ["node"], selftest: "node --version", license: "MIT", category: "net", ...changes };
  const dir = path.join(f.root, "recipes", r.id);
  writeJSON(path.join(dir, "recipe.json"), r);
  fs.mkdirSync(path.join(dir, "skill"), { recursive: true });
  fs.writeFileSync(path.join(dir, "skill", "SKILL.md"), "---\nname: offline-fixture\ndescription: 仅供离线元数据夹具使用\n---\n\n## 运行链路\n仅测试市场元数据，不是可发布组件，不证明远程业务可用。\n");
  return r;
}
function cli(f, tool, args = []) {
  const r = spawnSync(process.execPath, [path.join(f.root, "tools", tool), ...args], { cwd: f.root, env: f.env, encoding: "utf8", timeout: 30_000 });
  assert.ifError(r.error);
  return { ...r, output: (r.stdout || "") + (r.stderr || "") };
}
function success(result) { assert.equal(result.status, 0, result.output); }
function failure(result, pattern = /hostApi/) { assert.equal(result.status, 1, result.output); assert.match(result.output, pattern); }
function manifest(r, { base = BASE, version = "1.0.0-r1", ...changes } = {}) {
  return { id: r.id, version, upstream: "1.0.0", base: { gz: base, tag: TAG },
    gz: { sha256: "c".repeat(64), bytes: 123 }, installed: 456, bin: r.bin, skill: "", selftest: r.selftest,
    packages: [{ name: "offline-package", sha256: "d".repeat(64) }], baseDeps: [{ name: "nodejs", version: "22" }], ...changes };
}
function release(f, m, complete = true) {
  const name = asset(m.id, m.version, m.base.gz), dir = path.join(f.root, "releases", m.id);
  writeJSON(path.join(dir, name + ".json"), m);
  if (complete) fs.writeFileSync(path.join(dir, name + ".tar.gz"), "offline asset presence fixture only\n");
}
function index(f, out = "index") {
  const dir = path.join(f.root, out), result = cli(f, "build-index.mjs", ["--out", dir]);
  return { dir, result, read: () => JSON.parse(fs.readFileSync(path.join(dir, "components.json"), "utf8")) };
}
function build(f) { return cli(f, "ci-build.mjs", ["--devkit", f.devkit, "--no-upload"]); }
function builtSidecar(f, r) { return path.join(f.work, "out", r.id, BASE.slice(0, 12), asset(r.id, r.version + "-r" + r.revision, BASE) + ".json"); }
function assertNoPublish(f) {
  const file = path.join(f.root, "gh-calls.jsonl");
  if (fs.existsSync(file)) for (const call of fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse))
    assert.ok(!["create", "upload"].includes(call[1]), JSON.stringify(call));
}

test("hostApi schema is optional but exact, including explicit undefined rejection", () => {
  assert.equal(hostApiOf({}), undefined);
  const input = { hostApi: { remoteSession: 1 } }, value = hostApiOf(input);
  assert.deepEqual(value, input.hostApi);
  assert.notEqual(value, input.hostApi);
  for (const [name, hostApi] of [...invalidHostApis, ["undefined", undefined], ["inherited capability", Object.create({ remoteSession: 1 })]])
    assert.throws(() => hostApiOf({ hostApi }), /hostApi/, name);
});

test("real recipe checker accepts legacy and remoteSession 1, rejects every other hostApi shape", (t) => {
  const f = fixture(t);
  recipe(f); success(cli(f, "check-recipes.mjs"));
  recipe(f, { hostApi: { remoteSession: 1 } }); success(cli(f, "check-recipes.mjs"));
  for (const [name, hostApi] of invalidHostApis) {
    recipe(f, { hostApi });
    const result = cli(f, "check-recipes.mjs");
    failure(result);
    assert.doesNotMatch(result.output, /不认识的字段: hostApi/, name);
  }
});

test("hostApi does not relax GUI bin/selftest, file containment, fetch or unknown-field gates", (t) => {
  const f = fixture(t), hostApi = { remoteSession: 1 };
  recipe(f, { hostApi, bin: [], selftest: "" });
  const gui = cli(f, "check-recipes.mjs"); failure(gui, /bin 至少一个入口命令/); assert.match(gui.output, /selftest 必填/);
  recipe(f, { hostApi, files: { "outside/wrapper": { src: "skill/SKILL.md" } } });
  failure(cli(f, "check-recipes.mjs"), /files 只能放进 usr/);
  recipe(f, { hostApi, fetch: { "usr/share/fixture": { url: "http://offline.invalid/fixture", sha256: "bad", why: "negative fixture" } } });
  const download = cli(f, "check-recipes.mjs"); failure(download, /url 必须是 https/); assert.match(download.output, /sha256 要写全/);
  recipe(f, { hostApi, unexpected: true });
  failure(cli(f, "check-recipes.mjs"), /不认识的字段: unexpected/);
});

test("existing TLS and download safety scans still reject marked component fixtures", (t) => {
  const f = fixture(t); recipe(f, { hostApi: { remoteSession: 1 } });
  const cases = [
    ["curl --insecure https://offline.invalid/file", /curl -k \/ --insecure/],
    ["wget --no-check-certificate https://offline.invalid/file", /wget --no-check-certificate/],
    ["requests.get('https://offline.invalid/file', verify=False)", /verify=False/],
    ["context = ssl._create_unverified_context()", /Python 关证书校验/],
    ["const tlsOptions = { rejectUnauthorized: false, pin: 'offline-fixture' };", /Node 关证书校验/],
    ["NODE_TLS_REJECT_UNAUTHORIZED=0 node fixture.mjs", /Node 关证书校验/],
    ["git -c http.sslVerify=false clone https://offline.invalid/repository", /git 关证书校验/],
    ["curl https://offline.invalid/file", /没看到 sha256 校验/],
  ];
  for (const [code, expected] of cases) {
    fs.writeFileSync(path.join(f.root, "recipes", "fixture", "unsafe-fixture.txt"), code + "\n");
    failure(cli(f, "check-recipes.mjs"), expected);
  }
});

for (const marked of [false, true]) test("ci-build preserves " + (marked ? "remoteSession 1" : "unmarked legacy") + " sidecar contract", (t) => {
  const f = fixture(t), r = recipe(f, marked ? { hostApi: { remoteSession: 1 } } : {});
  success(build(f));
  const m = JSON.parse(fs.readFileSync(builtSidecar(f, r), "utf8"));
  assert.equal(Object.hasOwn(m, "hostApi"), marked);
  if (marked) assert.deepEqual(m.hostApi, { remoteSession: 1 });
  assert.equal(m.base.tag, TAG);
  assert.equal(m.recipe.revision, r.revision);
  assert.equal(Object.hasOwn(m, "tar"), false);
  assert.equal(m.gz.file, asset(r.id, r.version + "-r" + r.revision, BASE) + ".tar.gz");
  const rel = path.join(f.root, "releases", r.id);
  fs.mkdirSync(rel, { recursive: true });
  fs.copyFileSync(builtSidecar(f, r), path.join(rel, path.basename(builtSidecar(f, r))));
  fs.copyFileSync(path.join(path.dirname(builtSidecar(f, r)), m.gz.file), path.join(rel, m.gz.file));
  const ix = index(f); success(ix.result);
  const entry = ix.read().components[r.id], b = entry.builds[0];
  assert.equal(Object.hasOwn(entry, "hostApi"), false);
  assert.equal(Object.hasOwn(b, "hostApi"), marked);
  if (marked) assert.deepEqual(b.hostApi, m.hostApi);
  assert.equal(b.sha256, m.gz.sha256);
  assert.deepEqual(b.baseDeps, ["nodejs"]);
  assert.equal(b.selftest, r.selftest);
  assertNoPublish(f);
});

test("ci-build stops if an old devkit drops hostApi, or adds an undeclared requirement", (t) => {
  const f = fixture(t);
  const r = recipe(f, { hostApi: { remoteSession: 1 } });
  writeJSON(path.join(f.root, "devkit-mode.json"), { drop: true });
  failure(build(f), /构建清单的 hostApi 与配方不一致/);
  assert.equal(fs.existsSync(builtSidecar(f, r)), false);
  recipe(f);
  writeJSON(path.join(f.root, "devkit-mode.json"), { override: { remoteSession: 1 } });
  failure(build(f), /构建清单的 hostApi 与配方不一致/);
  assert.equal(fs.existsSync(builtSidecar(f, r)), false);
  assertNoPublish(f);
});

test("ci-build rejects malformed devkit sidecars and malformed recipes without producing release sidecars", (t) => {
  const f = fixture(t), r = recipe(f, { hostApi: { remoteSession: 1 } });
  for (const [, hostApi] of invalidHostApis) {
    writeJSON(path.join(f.root, "devkit-mode.json"), { override: hostApi });
    failure(build(f));
    assert.equal(fs.existsSync(builtSidecar(f, r)), false);
  }
  recipe(f, { hostApi: { remoteSession: 2 } });
  failure(build(f));
  assertNoPublish(f);
});

test("ci-build leaves already published unmarked builds alone even when current recipe declares hostApi", (t) => {
  const f = fixture(t), r = recipe(f, { hostApi: { remoteSession: 1 } }), m = manifest(r);
  release(f, m);
  const file = path.join(f.root, "releases", r.id, asset(r.id, m.version, BASE) + ".json"), before = fs.readFileSync(file);
  const result = build(f); success(result); assert.match(result.output, /已发布，跳过/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.existsSync(builtSidecar(f, r)), false);
  assertNoPublish(f);
});

test("index uses each historical sidecar, never current recipe hostApi or a top-level fallback", (t) => {
  const f = fixture(t), r = recipe(f, { hostApi: { remoteSession: 1 }, revision: 5, version: "2.0.0" });
  release(f, manifest(r));
  release(f, manifest(r, { base: NEXT_BASE, version: "1.1.0-r1" }));
  release(f, manifest(r, { base: NEXT_BASE, version: "2.0.0-r5", hostApi: { remoteSession: 1 } }));
  release(f, manifest(r, { base: "e".repeat(64), version: "9.0.0-r1", hostApi: { remoteSession: 1 } }), false);
  const first = index(f); success(first.result);
  const components = first.read().components, entry = components[r.id];
  assert.equal(Object.hasOwn(entry, "hostApi"), false);
  assert.equal(entry.builds.length, 2);
  const old = entry.builds.find((b) => b.base === BASE), current = entry.builds.find((b) => b.base === NEXT_BASE);
  assert.equal(Object.hasOwn(old, "hostApi"), false);
  assert.deepEqual(current.hostApi, { remoteSession: 1 });
  assert.equal(current.version, "2.0.0-r5");
  assert.ok(entry.builds.every((b) => b.verified === null));
  assert.equal(fs.existsSync(path.join(first.dir, "components.json.sig")), false);
  recipe(f, { revision: 5, version: "2.0.0" });
  const second = index(f, "index-without-recipe-marker"); success(second.result);
  assert.deepEqual(second.read().components, components);
  assertNoPublish(f);
});

test("index fails closed for any explicit invalid hostApi in a complete release sidecar", (t) => {
  const f = fixture(t), r = recipe(f);
  for (const [i, [name, hostApi]] of invalidHostApis.entries()) {
    release(f, manifest(r, { hostApi }));
    const ix = index(f, "invalid-index-" + i);
    failure(ix.result);
    assert.equal(fs.existsSync(path.join(ix.dir, "components.json")), false, name);
  }
  assertNoPublish(f);
});

test("all original recipes and their unmarked index entry shapes remain compatible", (t) => {
  const f = fixture(t), originals = recipes().filter((r) => !Object.hasOwn(r, "hostApi"));
  assert.ok(originals.length > 0);
  fs.cpSync(path.join(ROOT, "recipes"), path.join(f.root, "recipes"), { recursive: true });
  success(cli(f, "check-recipes.mjs"));
  for (const r of originals) release(f, manifest(r));
  const ix = index(f); success(ix.result);
  const entries = ix.read().components;
  assert.equal(Object.keys(entries).length, originals.length);
  for (const r of originals) {
    const m = manifest(r), name = asset(r.id, m.version, BASE) + ".tar.gz", models = modelsOf(r).models;
    assert.deepEqual(entries[r.id], {
      name: r.name, desc: r.desc, kind: r.kind || "termux", license: r.license, homepage: r.homepage || "",
      category: r.category || "other", maintainers: r.maintainers || [], needs: r.needs || {}, requires: r.requires || [],
      ...(models.length ? { models } : {}), builds: [{
        base: BASE, baseTag: TAG, version: m.version, upstream: m.upstream,
        url: "https://github.com/" + REPO + "/releases/download/" + r.id + "/" + name, asset: name,
        sha256: m.gz.sha256, bytes: m.gz.bytes, installed: m.installed,
        bin: m.bin, skill: m.skill, selftest: m.selftest, packages: m.packages.length, baseDeps: ["nodejs"], verified: null,
      }],
    }, r.id);
  }
  assert.equal(fs.existsSync(path.join(ix.dir, "components.json.sig")), false);
  assertNoPublish(f);
});
