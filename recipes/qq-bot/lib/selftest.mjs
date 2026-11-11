import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { PREFIX, TMP_DIR, ensureLayout } from "./paths.mjs";
import { extractText, shouldHandle, buildMessages, stripMarkdown, callBackend, sendOneBot } from "./bridge.mjs";
import { defaults, normalizeConfig } from "./config.mjs";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " · " + detail : ""}`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function testXvfb() {
  fs.mkdirSync(path.join(PREFIX, "tmp"), { recursive: true, mode: 0o700 });
  const bin = path.join(PREFIX, "bin", "Xvfb");
  if (!fs.existsSync(bin)) return check("Xvfb", false, "找不到 " + bin);
  let display = 90;
  for (; display < 99; display++) {
    if (!fs.existsSync(path.join(PREFIX, "tmp", ".X11-unix", `X${display}`)) &&
        !fs.existsSync(path.join(PREFIX, "tmp", `.X${display}-lock`))) break;
  }
  const out = fs.openSync(path.join(TMP_DIR, "selftest-xvfb.log"), "w", 0o600);
  const p = spawn(bin, [`:${display}`, "-screen", "0", "320x240x24", "-nolisten", "tcp", "-ac"],
    { stdio: ["ignore", out, out] });
  let ok = false;
  const sock = path.join(PREFIX, "tmp", ".X11-unix", `X${display}`);
  for (let i = 0; i < 50; i++) {
    if (fs.existsSync(sock)) { ok = true; break; }
    if (p.exitCode !== null) break;
    await sleep(100);
  }
  try { p.kill("SIGTERM"); } catch {}
  await sleep(200);
  try { p.kill("SIGKILL"); } catch {}
  fs.closeSync(out);
  check("Xvfb", ok, ok ? `:${display}` : `启动失败，见 ${path.join(TMP_DIR, "selftest-xvfb.log")}`);
}

async function testBridge() {
  const cfg = normalizeConfig(defaults());
  const evPrivate = {
    post_type: "message", message_type: "private", self_id: 10000, user_id: 42,
    message_id: 1, message: [{ type: "text", data: { text: "你好" } }],
    sender: { nickname: "测试" },
  };
  cfg.allow.private = ["42"];
  const priv = shouldHandle(evPrivate, cfg);
  check("私聊白名单", priv && priv.text === "你好", priv ? "命中" : "未命中");

  const evGroup = {
    post_type: "message", message_type: "group", self_id: 10000, group_id: 777,
    user_id: 42, message_id: 2,
    message: [{ type: "at", data: { qq: "10000" } }, { type: "text", data: { text: " 在吗" } }],
    sender: { card: "群友" },
  };
  cfg.allow.groups = ["777"];
  const grp = shouldHandle(evGroup, cfg);
  check("群聊仅 @", grp && grp.text === "在吗", grp ? "命中" : "未命中");
  const evNoAt = { ...evGroup, message: [{ type: "text", data: { text: "在吗" } }] };
  check("群聊未 @ 不响应", shouldHandle(evNoAt, cfg) === null);

  const { atMe, text } = extractText(evGroup);
  check("消息解析", atMe === true && text === "在吗");
  const md = stripMarkdown("**粗体** 和 `代码`\n```js\nx\n```");
  check("Markdown 清理", !md.includes("**") && !md.includes("```"), md.replace(/\n/g, " "));
  const msgs = buildMessages(cfg, "private:42", "你好", "测试");
  check("上下文组装", msgs[0].role === "system" && msgs.at(-1).content.includes("你好"));

  // 本地假模型 + 假 OneBot HTTP，不发外部请求
  let gotAuth = "", gotBody = null;
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      if (req.url.endsWith("/chat/completions")) {
        gotBody = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "**收到**" } }] }));
      } else {
        gotAuth = req.headers.authorization || "";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", data: { message_id: 3 } }));
      }
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const keyFile = path.join(TMP_DIR, "selftest-key.txt");
  fs.writeFileSync(keyFile, "test-key\n", { mode: 0o600 });
  fs.chmodSync(keyFile, 0o600);
  cfg.backend.baseUrl = `http://127.0.0.1:${port}/v1`;
  cfg.backend.apiKeyFile = keyFile;
  cfg.onebot.httpUrl = `http://127.0.0.1:${port}`;
  cfg.onebot.accessToken = "t0ken";
  try {
    const reply = await callBackend(cfg, msgs);
    check("模型接口", reply === "**收到**" && gotBody?.model === cfg.backend.model);
    await sendOneBot(cfg, "send_private_msg", { user_id: 42, message: [{ type: "text", data: { text: "收到" } }] });
    check("OneBot 发送", gotAuth === "Bearer t0ken");
  } catch (e) {
    check("桥单元测试", false, e.message);
  } finally {
    await new Promise((r) => srv.close(r));
    try { fs.rmSync(keyFile, { force: true }); } catch {}
  }
}

async function main() {
  ensureLayout();
  check("Node", Number(process.versions.node.split(".")[0]) >= 22, process.version);
  const ldso = path.join(PREFIX, "glibc", "lib", "ld-linux-aarch64.so.1");
  check("glibc 加载器", fs.existsSync(ldso));
  await testXvfb();
  await testBridge();
  const failed = results.filter((r) => !r.ok);
  console.log(`===== 总结 ===== qq-bot=${failed.length ? "FAIL" : "OK"} Xvfb=${results.find((r) => r.name === "Xvfb")?.ok ? "OK" : "FAIL"} bridge=${results.filter((r) => ["私聊白名单", "群聊仅 @", "模型接口", "OneBot 发送"].includes(r.name)).every((r) => r.ok) ? "PASS" : "FAIL"}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
