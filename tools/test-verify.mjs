import test from "node:test";
import assert from "node:assert/strict";
import { isHardwareBound, basePkgAbiBreaking, inheritBlockerWithLocks, mergeCiVerified } from "./build-index.mjs";
import { SKILL_FLAGS } from "./lib.mjs";

test("isHardwareBound：仅 GPU / display / shizuku 强制真机验证", () => {
  assert.equal(isHardwareBound({}), false);
  assert.equal(isHardwareBound({ gpu: false, display: false, shizuku: false }), false);
  assert.equal(isHardwareBound({ gpu: "adreno" }), true);
  assert.equal(isHardwareBound({ gpu: "mali" }), true);
  assert.equal(isHardwareBound({ gpu: true }), true);
  assert.equal(isHardwareBound({ display: true }), true);
  assert.equal(isHardwareBound({ shizuku: true }), true);
});

test("basePkgAbiBreaking 与 inheritBlockerWithLocks：补丁/次版本漂移允许继承，ABI-MAJOR 阻断继承", () => {
  const lockOld = {
    pkgs: new Map([
      ["bash", "5.2.37"],
      ["openssl", "3.5.0"],
      ["python", "3.14.8"],
      ["libicu", "78.3"],
      ["npm", "11.10.0"],
      ["zlib", "1.3.2"],
    ]),
    sonames: null,
  };
  const lockNew = {
    pkgs: new Map([
      ["bash", "5.2.38"],
      ["openssl", "3.5.1"],
      ["python", "3.14.10"],
      ["libicu", "79.1"],
      ["npm", "12.2.2"],
      ["zlib", "1.4"],
    ]),
    sonames: null,
  };

  // 不依赖 libicu 的组件（只依赖 bash/openssl/python/npm/zlib）：全部属于兼容漂移，允许继承
  const ghOld = { packages: [{ name: "gh", sha256: "aaa" }], baseDeps: [{ name: "bash" }, { name: "openssl" }, { name: "npm" }, { name: "zlib" }] };
  const ghNew = { packages: [{ name: "gh", sha256: "aaa" }], baseDeps: [{ name: "bash" }, { name: "openssl" }, { name: "npm" }, { name: "zlib" }] };
  assert.equal(inheritBlockerWithLocks(ghNew, ghOld, lockNew, lockOld), null);

  // 依赖 libicu 的组件：libicu 78.3→79.1 属于 ABI-MAJOR，必须阻断继承
  const loOld = { packages: [{ name: "libreoffice", sha256: "bbb" }], baseDeps: [{ name: "libicu" }, { name: "openssl" }] };
  const loNew = { packages: [{ name: "libreoffice", sha256: "bbb" }], baseDeps: [{ name: "libicu" }, { name: "openssl" }] };
  const block = inheritBlockerWithLocks(loNew, loOld, lockNew, lockOld);
  assert.match(block, /libicu/);

  // 若新旧底座锁文件带实测 SONAME 且完全相同，即使主版本变了也不误拦
  const snOld = { pkgs: new Map([["libxml2", "2.13.8"]]), sonames: { libxml2: ["libxml2.so.2"] } };
  const snNewSame = { pkgs: new Map([["libxml2", "3.0.0"]]), sonames: { libxml2: ["libxml2.so.2"] } };
  const snNewBroken = { pkgs: new Map([["libxml2", "2.14.0"]]), sonames: { libxml2: ["libxml2.so.16"] } };
  assert.equal(basePkgAbiBreaking("libxml2", snOld, snNewSame), null);
  assert.match(basePkgAbiBreaking("libxml2", snOld, snNewBroken), /SONAME/);
});

test("mergeCiVerified：合并多片结果并保留历史底座记录", () => {
  const prev = { gh: { "2.104.0-r2": { oldbase12345: { kind: "ci-arm64", gzSha256: "111" } } } };
  const shard0 = { gh: { "2.104.0-r2": { newbase67890: { kind: "ci-arm64", gzSha256: "222" } } } };
  const shard1 = { d2: { "0.9.0-r1": { newbase67890: { kind: "ci-arm64", gzSha256: "333" } } } };
  const merged = mergeCiVerified(prev, shard0, shard1);
  assert.equal(merged.gh["2.104.0-r2"].oldbase12345.gzSha256, "111");
  assert.equal(merged.gh["2.104.0-r2"].newbase67890.gzSha256, "222");
  assert.equal(merged.d2["0.9.0-r1"].newbase67890.gzSha256, "333");
});

test("SKILL_FLAGS Cookie / 登录态规则：命中 --cookies-from-browser 与常见凭据，排除连字符词误报", () => {
  const cookieRule = SKILL_FLAGS.find(([, label]) => label.includes("Cookie"));
  assert.ok(cookieRule, "应存在 Cookie / 登录态标记规则");
  const re = cookieRule[2];
  assert.equal(re.test("yt-dlp --cookies-from-browser chrome https://example.com"), true);
  assert.equal(re.test("yt-dlp --cookies-from-browser=firefox https://example.com"), true);
  assert.equal(re.test("支持传 `--cookies-from-browser` 或 `--cookies cookies.txt`"), true);
  assert.equal(re.test("curl -H 'Cookie: SESSDATA=xxx; bili_jct=yyy'"), true);
  assert.equal(re.test("console.log(document.cookie)"), true);
  assert.equal(re.test("read /tmp/cookies.txt"), true);
  assert.equal(re.test("fortune-cookies.txt"), false);
  assert.equal(re.test("yt-dlp https://example.com/video"), false);
});
