#!/usr/bin/env node
// 真跑隔离的 CCR 和假上游；不读用户配置，不触网推理，不修改组件本体。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const temp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "openai-bridge-selftest-"));
  let child, upstream, output = "", passed = 0;
  try {
    const dist = path.join(temp, "node_modules/@musistudio/claude-code-router/dist");
    fs.mkdirSync(dist, { recursive: true });
    for (const name of ["@fastify", "@isaacs", "fastify", "ajv", "fast-uri", "find-my-way", "undici", "minimatch", "glob", "shell-quote"]) {
      fs.symlinkSync(path.join(root, "node_modules", name), path.join(temp, "node_modules", name), "dir");
    }
    for (const name of ["cli.js", "tiktoken_bg.wasm"]) {
      fs.copyFileSync(path.join(root, "node_modules/@musistudio/claude-code-router/dist", name), path.join(dist, name));
    }
    fs.copyFileSync(path.join(__dirname, "patch-ccr.js"), path.join(temp, "patch-ccr.js"));
    const patched = spawnSync(process.execPath, [path.join(temp, "patch-ccr.js")], { encoding: "utf8", timeout: 15000 });
    assert.ok([0, 2].includes(patched.status), patched.stderr || patched.error?.message);
    const seen = [];
    upstream = http.createServer(async (req, res) => {
      try {
        let body = "";
        for await (const part of req) body += part;
        const request = JSON.parse(body);
        seen.push(request);
        const usage = { prompt_tokens: 11, completion_tokens: 2 };
        const base = { id: "local-selftest", model: request.model };
        if (request.model === "broken") {
          // 恒 400：重发也失败时要交回第一次的错误正文
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Invalid request payload #" + seen.filter((x) => x.model === "broken").length, type: "invalid_request_error" } }));
          return;
        }
        if (request.model === "quota") {
          // 不像参数错误的 400：不重发
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "daily quota exhausted", type: "rate_limit" } }));
          return;
        }
        if (request.model === "strict" && (request.reasoning !== undefined || request.reasoning_effort !== undefined)) {
          // 学某些上游：不认推理参数，只回一句笼统的 400（#84）
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: null, message: "Invalid request payload", param: null, type: "invalid_request_error" } }));
          return;
        }
        if (request.model === "sse") {
          // 故意误标响应类型，覆盖实际服务端常见兼容问题。
          const frames = [
            { ...base, choices: [{ index: 0, delta: { content: "LOCAL_OK" }, finish_reason: null }] },
            { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage }
          ];
          res.writeHead(200, { "content-type": "application/json" });
          res.end(frames.map((frame) => "data: " + JSON.stringify(frame) + "\n\n").join("") + "data: [DONE]\n\n");
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ...base, choices: [{ index: 0, message: { role: "assistant", content: "LOCAL_OK" }, finish_reason: "stop" }], usage }));
        }
      } catch {
        res.writeHead(500);
        res.end("mock error");
      }
    });
    const upstreamPort = await listen(upstream);
    const reserve = http.createServer();
    const port = await listen(reserve);
    await new Promise((resolve) => reserve.close(resolve));
    const home = path.join(temp, "home"), state = path.join(home, ".claude-code-router");
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, "config.json"), JSON.stringify({
      HOST: "127.0.0.1", PORT: port, APIKEY: "local-test-only", LOG: false, NON_INTERACTIVE_MODE: true,
      Providers: [{ name: "mock", api_base_url: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`, api_key: "local-test-only", models: ["json", "sse", "strict", "broken", "quota"] }],
      Router: { default: "mock,json" }
    }), { mode: 0o600 });
    const env = { ...process.env, HOME: home, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };
    for (const key of ["CCAPP_RUN", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "SERVICE_PORT", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete env[key];
    child = spawn(process.execPath, [path.join(dist, "cli.js"), "start"], { cwd: temp, env, stdio: ["ignore", "pipe", "pipe"] });
    const capture = (part) => { output = (output + part).slice(-4000); };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", capture);
    let ready = false;
    for (let i = 0; i < 60 && child.exitCode === null; i++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(300) });
        ready = response.ok && (await response.json()).status === "ok";
        if (ready) break;
      } catch {}
      await sleep(100);
    }
    assert.ok(ready, "isolated CCR did not become ready: " + output);
    for (const [model, stream] of [["json", false], ["json", true], ["sse", true]]) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST", signal: AbortSignal.timeout(5000), headers: { "content-type": "application/json", "x-api-key": "local-test-only" },
        body: JSON.stringify({ model: "mock," + model, max_tokens: 16, stream, output_config: { effort: "high" }, messages: [{ role: "user", content: "local selftest" }] })
      });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      assert.match(text, /LOCAL_OK/);
      if (stream) assert.match(text, /event: message_stop/);
      else assert.equal(JSON.parse(text).content[0].text, "LOCAL_OK");
      assert.equal(seen.at(-1).reasoning_effort, "high");
      assert.equal(seen.at(-1).stream, stream);
      passed++;
      console.log(`PASS ${model} stream=${stream}; text + effort preserved`);
    }
    assert.equal(seen.length, 3);
    // 上游不认推理参数：第一次 400 后去掉重发并记住，第二次直接不带（#84）
    for (const round of [1, 2]) {
      const before = seen.length;
      const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST", signal: AbortSignal.timeout(5000), headers: { "content-type": "application/json", "x-api-key": "local-test-only" },
        body: JSON.stringify({ model: "mock,strict", max_tokens: 16, stream: true, output_config: { effort: "high" }, messages: [{ role: "user", content: "local selftest" }] })
      });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      assert.match(text, /LOCAL_OK/);
      assert.equal(seen.at(-1).reasoning_effort, undefined);
      assert.equal(seen.at(-1).reasoning, undefined);
      assert.equal(seen.length - before, round === 1 ? 2 : 1);
    }
    for (const [model, sent, pattern] of [["broken", 2, /Invalid request payload #1/], ["quota", 1, /daily quota exhausted/]]) {
      const before = seen.length;
      const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST", signal: AbortSignal.timeout(5000), headers: { "content-type": "application/json", "x-api-key": "local-test-only" },
        body: JSON.stringify({ model: "mock," + model, max_tokens: 16, stream: false, output_config: { effort: "high" }, messages: [{ role: "user", content: "local selftest" }] })
      });
      const text = await response.text();
      assert.equal(response.status, 400, text);
      assert.match(text, pattern);
      assert.equal(seen.length - before, sent);
    }
    passed++;
    console.log("PASS strict upstream; reasoning params dropped after 400, remembered; real errors kept");
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      for (let i = 0; i < 20 && child.exitCode === null; i++) await sleep(100);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(1000)]);
      }
    }
    if (upstream) {
      upstream.closeAllConnections();
      await new Promise((resolve) => upstream.close(resolve));
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log(`===== 总结 ===== CCR=1.0.73 static=10.1.2 JSON/SSE=${passed}/4 effort=OK upstream=loopback-only`);
}

main().catch((error) => { console.error("selftest failed:", error.message); process.exitCode = 1; });
